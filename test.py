# batch_ocr_large_scale.py
# High-performance batch OCR processor for 200+ PDFs with 200+ pages each
# Optimized for speed, accuracy, and memory management
#
# Requires: pip install pdf2image pillow pytesseract opencv-python tqdm scikit-learn psutil

import os
import sys
import gc
import re
import json
import time
import psutil
from pathlib import Path
from typing import Tuple, List, Dict, Optional
from concurrent.futures import ProcessPoolExecutor, as_completed, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import cv2
from PIL import Image
from tqdm import tqdm
from pdf2image import convert_from_path
from pdf2image.pdf2image import pdfinfo_from_path
import pytesseract

# ============ CONFIGURATION ============
@dataclass
class Config:
    # Input/Output paths
    INPUT_DIR: str = r"E:\Projects\pdfs"           # Directory containing all PDFs
    OUTPUT_DIR: str = r"E:\Projects\ocr_results"   # Base output directory
    POPPLER_DIR: str = r"E:\tools\poppler-25.07.0\Library\bin"
    TESS_EXE: str = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    
    # Processing parameters
    LANGS: str = "eng"                             # Languages for OCR
    DPI: int = 300                                 # Lower DPI for speed (300 is good balance)
    BATCH_SIZE: int = 50                           # Pages per batch to prevent memory issues
    MAX_WORKERS_OCR: int = min(6, os.cpu_count())  # OCR workers (don't use all cores)
    MAX_WORKERS_PDF: int = 2                       # PDF processing workers
    THREAD_COUNT: int = 4                          # pdf2image threads
    
    # Memory management
    MAX_MEMORY_GB: float = 8.0                     # Max memory usage in GB
    CLEANUP_INTERVAL: int = 10                     # Clean memory every N PDFs
    
    # Quality control
    LOW_CONF_THRESH: int = 55                      # Confidence threshold for fallback
    MIN_PAGE_CHARS: int = 50                       # Minimum characters per page
    
    # Resume functionality
    RESUME_MODE: bool = True                       # Skip already processed files
    SAVE_PROGRESS: bool = True                     # Save progress info

config = Config()

# OCR configurations
BASE_CONFIG = "--oem 1 -c preserve_interword_spaces=1"
PSM6_CONFIG = BASE_CONFIG + " --psm 6"   # Uniform block of text (faster)
PSM3_CONFIG = BASE_CONFIG + " --psm 3"   # Fully automatic page segmentation

class ProgressTracker:
    """Track progress across multiple PDF files"""
    
    def __init__(self, progress_file: str):
        self.progress_file = progress_file
        self.data = self.load_progress()
    
    def load_progress(self) -> Dict:
        if os.path.exists(self.progress_file):
            try:
                with open(self.progress_file, 'r') as f:
                    return json.load(f)
            except:
                pass
        return {
            "completed_files": [],
            "failed_files": [],
            "start_time": datetime.now().isoformat(),
            "total_pages_processed": 0
        }
    
    def save_progress(self):
        if config.SAVE_PROGRESS:
            with open(self.progress_file, 'w') as f:
                json.dump(self.data, f, indent=2)
    
    def mark_completed(self, filename: str, pages_count: int):
        if filename not in self.data["completed_files"]:
            self.data["completed_files"].append(filename)
        self.data["total_pages_processed"] += pages_count
        self.save_progress()
    
    def mark_failed(self, filename: str, error: str):
        self.data["failed_files"].append({"file": filename, "error": str(error), "time": datetime.now().isoformat()})
        self.save_progress()
    
    def is_completed(self, filename: str) -> bool:
        return filename in self.data["completed_files"]

def setup_directories():
    """Create necessary directories"""
    Path(config.OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
    Path(config.OUTPUT_DIR, "logs").mkdir(exist_ok=True)
    Path(config.OUTPUT_DIR, "texts").mkdir(exist_ok=True)
    Path(config.OUTPUT_DIR, "stats").mkdir(exist_ok=True)

def check_memory_usage() -> float:
    """Return current memory usage in GB"""
    process = psutil.Process(os.getpid())
    return process.memory_info().rss / 1024 / 1024 / 1024

def cleanup_memory():
    """Force garbage collection and memory cleanup"""
    gc.collect()
    time.sleep(1)

def ensure_paths():
    """Validate required paths exist"""
    missing = []
    if not Path(config.INPUT_DIR).exists():
        missing.append(f"Input directory not found: {config.INPUT_DIR}")
    if not Path(config.POPPLER_DIR, "pdfinfo.exe").exists():
        missing.append("Missing pdfinfo.exe in POPPLER_DIR")
    if not Path(config.TESS_EXE).exists():
        missing.append(f"Tesseract not found: {config.TESS_EXE}")
    
    if missing:
        for m in missing:
            print(f"[!] {m}")
        sys.exit(1)

def normalize_text(text: str) -> str:
    """Normalize whitespace and clean text"""
    return re.sub(r'\s+', ' ', text).strip()

def get_confidence_from_tsv(tsv: str) -> float:
    """Extract mean confidence from Tesseract TSV output"""
    lines = [l for l in tsv.splitlines() if l and not l.startswith("level")]
    confidences = []
    
    for line in lines:
        parts = line.split('\t')
        if len(parts) > 10:  # conf is column 10
            try:
                conf = float(parts[10])
                if conf >= 0:
                    confidences.append(conf)
            except ValueError:
                continue
    
    return np.mean(confidences) if confidences else 0.0

def preprocess_image(pil_image: Image.Image) -> Image.Image:
    """Fast and effective image preprocessing"""
    # Convert to OpenCV format
    img_array = np.array(pil_image)
    if len(img_array.shape) == 3:
        gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
    else:
        gray = img_array
    
    # Adaptive thresholding for varied lighting
    binary = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, 
        cv2.THRESH_BINARY, 11, 2
    )
    
    # Light morphological operations to clean up
    kernel = np.ones((2, 2), np.uint8)
    cleaned = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)
    
    return Image.fromarray(cleaned)

def ocr_single_page(args) -> Tuple[int, str, float, int]:
    """OCR a single page with fallback strategy"""
    page_num, pil_image = args
    
    try:
        # Preprocess image
        processed_img = preprocess_image(pil_image)
        
        # First attempt: Fast PSM6
        text = pytesseract.image_to_string(processed_img, lang=config.LANGS, config=PSM6_CONFIG)
        tsv_output = pytesseract.image_to_data(processed_img, lang=config.LANGS, config=PSM6_CONFIG, output_type=pytesseract.Output.STRING)
        confidence = get_confidence_from_tsv(tsv_output)
        
        # Fallback if confidence is low
        if confidence < config.LOW_CONF_THRESH:
            text_fallback = pytesseract.image_to_string(processed_img, lang=config.LANGS, config=PSM3_CONFIG)
            tsv_fallback = pytesseract.image_to_data(processed_img, lang=config.LANGS, config=PSM3_CONFIG, output_type=pytesseract.Output.STRING)
            confidence_fallback = get_confidence_from_tsv(tsv_fallback)
            
            if confidence_fallback > confidence:
                text, confidence = text_fallback, confidence_fallback
        
        # Clean and validate text
        clean_text = normalize_text(text)
        char_count = len(clean_text)
        
        return page_num, clean_text, confidence, char_count
        
    except Exception as e:
        return page_num, f"[OCR ERROR: {str(e)}]", 0.0, 0

def process_pdf_batch(pdf_path: str, start_page: int, end_page: int) -> List[Tuple[int, str, float, int]]:
    """Process a batch of pages from a PDF"""
    try:
        # Convert batch of pages
        pages = convert_from_path(
            pdf_path, 
            dpi=config.DPI,
            first_page=start_page,
            last_page=end_page,
            poppler_path=config.POPPLER_DIR,
            thread_count=config.THREAD_COUNT
        )
        
        # Prepare OCR tasks
        ocr_tasks = [(start_page + i, page) for i, page in enumerate(pages)]
        
        # Process pages in parallel
        results = []
        with ProcessPoolExecutor(max_workers=config.MAX_WORKERS_OCR) as executor:
            future_to_page = {executor.submit(ocr_single_page, task): task[0] for task in ocr_tasks}
            
            for future in as_completed(future_to_page):
                page_num = future_to_page[future]
                try:
                    result = future.result(timeout=120)  # 2-minute timeout per page
                    results.append(result)
                except Exception as e:
                    print(f"    [!] Page {page_num} failed: {str(e)}")
                    results.append((page_num, f"[FAILED: {str(e)}]", 0.0, 0))
        
        # Cleanup
        del pages
        cleanup_memory()
        
        return sorted(results, key=lambda x: x[0])
        
    except Exception as e:
        print(f"    [!] Batch {start_page}-{end_page} failed: {str(e)}")
        return []

def process_single_pdf(pdf_path: str, progress_tracker: ProgressTracker) -> bool:
    """Process a single PDF file"""
    pdf_name = Path(pdf_path).stem
    print(f"\n[i] Processing: {pdf_name}")
    
    # Check if already processed
    if config.RESUME_MODE and progress_tracker.is_completed(pdf_name):
        print(f"    [i] Skipping (already processed)")
        return True
    
    try:
        # Get PDF info
        info = pdfinfo_from_path(pdf_path, poppler_path=config.POPPLER_DIR)
        total_pages = int(info["Pages"])
        print(f"    [i] Total pages: {total_pages}")
        
        # Create output file
        output_path = Path(config.OUTPUT_DIR, "texts", f"{pdf_name}.txt")
        stats_path = Path(config.OUTPUT_DIR, "stats", f"{pdf_name}_stats.json")
        
        # Process in batches
        all_results = []
        total_batches = (total_pages + config.BATCH_SIZE - 1) // config.BATCH_SIZE
        
        for batch_num in range(total_batches):
            start_page = batch_num * config.BATCH_SIZE + 1
            end_page = min((batch_num + 1) * config.BATCH_SIZE, total_pages)
            
            print(f"    [i] Batch {batch_num + 1}/{total_batches} (pages {start_page}-{end_page})")
            
            # Check memory usage
            if check_memory_usage() > config.MAX_MEMORY_GB:
                print(f"    [i] High memory usage, cleaning up...")
                cleanup_memory()
            
            # Process batch
            batch_results = process_pdf_batch(pdf_path, start_page, end_page)
            all_results.extend(batch_results)
            
            # Progress update
            progress_bar = (batch_num + 1) / total_batches * 100
            print(f"    [i] Progress: {progress_bar:.1f}%")
        
        # Write results to file
        with open(output_path, 'w', encoding='utf-8') as f:
            for page_num, text, confidence, char_count in sorted(all_results, key=lambda x: x[0]):
                f.write(f"\n--- Page {page_num} (conf: {confidence:.1f}, chars: {char_count}) ---\n")
                f.write(text)
                if not text.endswith('\n'):
                    f.write('\n')
        
        # Save statistics
        stats = {
            "pdf_name": pdf_name,
            "total_pages": total_pages,
            "processed_pages": len(all_results),
            "avg_confidence": np.mean([r[2] for r in all_results if r[2] > 0]),
            "total_characters": sum(r[3] for r in all_results),
            "low_confidence_pages": len([r for r in all_results if r[2] < config.LOW_CONF_THRESH]),
            "processing_time": datetime.now().isoformat()
        }
        
        with open(stats_path, 'w') as f:
            json.dump(stats, f, indent=2)
        
        # Mark as completed
        progress_tracker.mark_completed(pdf_name, total_pages)
        
        print(f"    [✓] Completed! Avg confidence: {stats['avg_confidence']:.1f}")
        print(f"    [✓] Text saved to: {output_path}")
        
        return True
        
    except Exception as e:
        error_msg = f"Failed to process {pdf_name}: {str(e)}"
        print(f"    [!] {error_msg}")
        progress_tracker.mark_failed(pdf_name, error_msg)
        return False

def main():
    """Main processing function"""
    print("=== Large Scale OCR Processor ===")
    print(f"Configuration: DPI={config.DPI}, OCR_Workers={config.MAX_WORKERS_OCR}, Batch_Size={config.BATCH_SIZE}")
    
    # Setup
    pytesseract.pytesseract.tesseract_cmd = config.TESS_EXE
    ensure_paths()
    setup_directories()
    
    # Initialize progress tracking
    progress_file = Path(config.OUTPUT_DIR, "progress.json")
    progress_tracker = ProgressTracker(str(progress_file))
    
    # Find all PDF files
    pdf_files = list(Path(config.INPUT_DIR).glob("*.pdf"))
    if not pdf_files:
        print(f"[!] No PDF files found in {config.INPUT_DIR}")
        return
    
    print(f"[i] Found {len(pdf_files)} PDF files")
    
    # Filter out already processed files if in resume mode
    if config.RESUME_MODE:
        remaining_files = [f for f in pdf_files if not progress_tracker.is_completed(f.stem)]
        print(f"[i] {len(pdf_files) - len(remaining_files)} files already processed")
        pdf_files = remaining_files
    
    if not pdf_files:
        print("[i] All files already processed!")
        return
    
    # Process files
    start_time = time.time()
    successful = 0
    failed = 0
    
    for i, pdf_file in enumerate(pdf_files):
        print(f"\n[{i+1}/{len(pdf_files)}] Processing: {pdf_file.name}")
        
        if process_single_pdf(str(pdf_file), progress_tracker):
            successful += 1
        else:
            failed += 1
        
        # Periodic cleanup
        if (i + 1) % config.CLEANUP_INTERVAL == 0:
            print(f"[i] Periodic memory cleanup...")
            cleanup_memory()
    
    # Final summary
    elapsed_time = time.time() - start_time
    print(f"\n=== Processing Complete ===")
    print(f"Total time: {elapsed_time/3600:.2f} hours")
    print(f"Successful: {successful}, Failed: {failed}")
    print(f"Total pages processed: {progress_tracker.data['total_pages_processed']}")
    print(f"Average speed: {progress_tracker.data['total_pages_processed']/(elapsed_time/60):.1f} pages/minute")
    print(f"Results saved in: {config.OUTPUT_DIR}")

if __name__ == "__main__":
    main()