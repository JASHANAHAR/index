# bulk_pdf_ocr.py
# Fast & accurate bulk PDF text extraction:
# 1) Use text layer if present (PyMuPDF)  2) Otherwise OCR (Poppler -> pdf2image -> Tesseract)
# Windows-friendly, streams in batches, parallel OCR, two-pass fallback, confidence-based retry.
#
# pip install pymupdf pdf2image pillow pytesseract opencv-python tqdm numpy
# Also install Poppler for Windows and Tesseract-OCR, then set paths below.

import os, sys, gc, shutil, tempfile
from typing import List, Tuple
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
import cv2
from PIL import Image
from tqdm import tqdm
import fitz  # PyMuPDF
from pdf2image import convert_from_path
from pdf2image.pdf2image import pdfinfo_from_path
import pytesseract

# ====== CONFIG ======
INPUT_DIR     = r"E:\Projects\index\pdfs"               # folder with PDFs
OUTPUT_DIR    = r"E:\Projects\index\ocr_output_bulk"    # results are mirrored per-PDF here
POPPLER_DIR   = r"E:\tools\poppler-25.07.0\Library\bin" # has pdftoppm.exe, pdfinfo.exe
TESS_EXE      = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

# OCR
LANGS         = "eng"        # e.g., "eng+hin" (after you install hin.traineddata)
DPI           = 350
THREAD_COUNT  = 4            # rendering threads inside pdf2image/poppler
MAX_WORKERS   = max(2, (os.cpu_count() or 2) - 1)  # OCR processes
BATCH_PAGES   = 40           # render+OCR this many pages at a time (memory-friendly)

# Confidence / fallback
CONF_FIELD_IDX    = 10
LOW_CONF_THRESH   = 55
ORIENT_DESKEW_ON_FAIL = False

# Behavior
APPEND_IF_EXISTS = False     # if combined.txt exists, append instead of overwrite

# ===============

BASE_CONFIG  = "--oem 1 -c preserve_interword_spaces=1"
PSM6_CONFIG  = BASE_CONFIG + " --psm 6"   # uniform block of text
PSM12_CONFIG = BASE_CONFIG + " --psm 12"  # sparse text + OSD

pytesseract.pytesseract.tesseract_cmd = TESS_EXE
os.makedirs(OUTPUT_DIR, exist_ok=True)

def ensure_bins():
    miss = []
    if not os.path.isdir(INPUT_DIR): miss.append(f"Input dir not found: {INPUT_DIR}")
    if not os.path.isfile(os.path.join(POPPLER_DIR, "pdfinfo.exe")): miss.append("Missing pdfinfo.exe in POPPLER_DIR")
    if not os.path.isfile(os.path.join(POPPLER_DIR, "pdftoppm.exe")): miss.append("Missing pdftoppm.exe in POPPLER_DIR")
    if not os.path.isfile(TESS_EXE): miss.append(f"Tesseract not found: {TESS_EXE}")
    if miss:
        for m in miss: print("[!] " + m)
        sys.exit(1)

def normalize_spaces(s: str) -> str:
    import re
    return re.sub(r"\s+", " ", s).strip()

def mean_conf_from_tsv(tsv: str) -> float:
    lines = [l for l in tsv.splitlines() if l and not l.startswith("level")]
    vals = []
    for l in lines:
        parts = l.split('\t')
        if len(parts) > CONF_FIELD_IDX:
            try:
                c = float(parts[CONF_FIELD_IDX])
                if c >= 0:
                    vals.append(c)
            except:
                pass
    return float(np.mean(vals)) if vals else 0.0

def preprocess_fast(pil_img: Image.Image) -> Image.Image:
    img = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, np.ones((2,2), np.uint8), iterations=1)
    return Image.fromarray(bw)

def rotate_if_needed_osd(pil_img: Image.Image) -> Image.Image:
    try:
        osd = pytesseract.image_to_osd(pil_img)
        angle = 0
        for ln in osd.splitlines():
            if "Rotate:" in ln:
                angle = int(ln.split(":")[1].strip())
                break
        if angle:
            return pil_img.rotate(-angle, expand=True)
    except Exception:
        pass
    return pil_img

def deskew(pil_img: Image.Image) -> Image.Image:
    arr = np.array(pil_img.convert("L"))
    _, bw = cv2.threshold(arr, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if bw.mean() > 127:
        bw = cv2.bitwise_not(bw)
    coords = np.column_stack(np.where(bw == 0))
    if coords.size == 0:
        return pil_img
    angle = cv2.minAreaRect(coords)[-1]
    angle = -(90 + angle) if angle < -45 else -angle
    (h, w) = arr.shape
    M = cv2.getRotationMatrix2D((w//2, h//2), angle, 1.0)
    rotated = cv2.warpAffine(np.array(pil_img), M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return Image.fromarray(rotated)

def ocr_one_image(img_path: str) -> Tuple[str, float]:
    try:
        pil = Image.open(img_path)
        pre = preprocess_fast(pil)

        txt = pytesseract.image_to_string(pre, lang=LANGS, config=PSM6_CONFIG)
        tsv = pytesseract.image_to_data(pre, lang=LANGS, config=PSM6_CONFIG, output_type=pytesseract.Output.STRING)
        conf = mean_conf_from_tsv(tsv)

        if conf < LOW_CONF_THRESH:
            pre2 = pre
            if ORIENT_DESKEW_ON_FAIL:
                pre2 = rotate_if_needed_osd(pre2)
                pre2 = deskew(pre2)
            txt2 = pytesseract.image_to_string(pre2, lang=LANGS, config=PSM12_CONFIG)
            tsv2 = pytesseract.image_to_data(pre2, lang=LANGS, config=PSM12_CONFIG, output_type=pytesseract.Output.STRING)
            conf2 = mean_conf_from_tsv(tsv2)
            if conf2 > conf:
                txt, tsv, conf = txt2, tsv2, conf2

        return txt, conf, tsv
    except Exception as e:
        return f"[OCR ERROR: {e}]", 0.0, ""

def pdf_has_useful_text(pdf_path: str, sample_pages: int = 6, min_chars: int = 120) -> bool:
    # Quickly test the first few pages for native text
    try:
        with fitz.open(pdf_path) as doc:
            n = min(sample_pages, doc.page_count)
            total = 0
            for i in range(n):
                total += len(doc.load_page(i).get_text("text"))
            return total >= min_chars
    except Exception:
        return False

def extract_native_text(pdf_path: str, out_txt: str):
    with fitz.open(pdf_path) as doc, open(out_txt, "w", encoding="utf-8") as out:
        for i in range(doc.page_count):
            text = doc.load_page(i).get_text("text")
            out.write(f"\n\n--- Page {i+1} ---\n")
            out.write(text if text.endswith("\n") else text + "\n")

def render_batch_paths(pdf_path: str, first_page: int, last_page: int, tmp_dir: str) -> List[str]:
    # Save as TIFF (lossless, good for OCR). paths_only=True returns file paths, not PIL images.
    paths = convert_from_path(
        pdf_path,
        dpi=DPI,
        first_page=first_page,
        last_page=last_page,
        poppler_path=POPPLER_DIR,
        thread_count=THREAD_COUNT,
        fmt="tiff",
        output_folder=tmp_dir,
        paths_only=True
    )
    return paths

def process_pdf(pdf_path: str):
    base = os.path.splitext(os.path.basename(pdf_path))[0]
    out_dir = os.path.join(OUTPUT_DIR, base)
    os.makedirs(out_dir, exist_ok=True)
    out_txt = os.path.join(out_dir, "combined.txt")

    mode = "a" if (APPEND_IF_EXISTS and os.path.exists(out_txt)) else "w"

    # 1) If it’s a digital PDF, extract text directly
    if pdf_has_useful_text(pdf_path):
        extract_native_text(pdf_path, out_txt)
        print(f"[✓] Native text extracted: {pdf_path}")
        return

    # 2) Otherwise do OCR, in batches
    info = pdfinfo_from_path(pdf_path, poppler_path=POPPLER_DIR)
    total_pages = int(info["Pages"])
    print(f"[i] OCR: {pdf_path} | pages={total_pages}")

    with open(out_txt, mode, encoding="utf-8") as out:
        page_idx = 1
        while page_idx <= total_pages:
            batch_start = page_idx
            batch_end = min(total_pages, batch_start + BATCH_PAGES - 1)

            with tempfile.TemporaryDirectory() as tmpdir:
                img_paths = render_batch_paths(pdf_path, batch_start, batch_end, tmpdir)

                results = {}
                with ProcessPoolExecutor(max_workers=MAX_WORKERS) as ex:
                    futs = {ex.submit(ocr_one_image, p): p for p in img_paths}
                    for fu in tqdm(as_completed(futs), total=len(img_paths), desc=f"OCR {base} {batch_start}-{batch_end}"):
                        txt, conf, tsv = fu.result()
                        # Derive page number from filename suffix created by pdf2image (…-1, -2, etc.)
                        name = os.path.basename(futs[fu])
                        # pdf2image names like: base-001.tiff (or similar). Extract trailing number.
                        pg = None
                        for token in os.path.splitext(name)[0].split('-')[::-1]:
                            if token.isdigit():
                                pg = int(token)
                                break
                        if pg is None:
                            # Fallback to relative order if needed
                            pg = batch_start + len(results)
                        results[pg] = (txt, conf, tsv)

                # Write in page order and dump TSVs
                for pg in range(batch_start, batch_end + 1):
                    txt, conf, tsv = results.get(pg, ("", 0.0, ""))
                    out.write(f"\n\n--- Page {pg} ---\n")
                    out.write(txt if txt.endswith("\n") else txt + "\n")
                    # QA TSV
                    if tsv:
                        with open(os.path.join(out_dir, f"page_{pg:04d}.tsv"), "w", encoding="utf-8") as ftsv:
                            ftsv.write(tsv)

            page_idx = batch_end + 1
            gc.collect()

    print(f"[✓] OCR text written: {out_txt}")

def main():
    ensure_bins()
    pdfs = [os.path.join(INPUT_DIR, f) for f in os.listdir(INPUT_DIR)
            if f.lower().endswith(".pdf")]
    if not pdfs:
        print("[!] No PDFs found.")
        return

    print(f"[i] Found {len(pdfs)} PDFs. DPI={DPI}, OCR workers={MAX_WORKERS}, render threads={THREAD_COUNT}, batch={BATCH_PAGES}")
    for i, pdf in enumerate(sorted(pdfs), 1):
        print(f"\n=== ({i}/{len(pdfs)}) {pdf} ===")
        try:
            process_pdf(pdf)
        except Exception as e:
            print(f"[!] Failed {pdf}: {e}")

if __name__ == "__main__":
    main()
