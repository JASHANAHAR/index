# cloud_batch_ocr.py
# High-performance batch OCR using Google Cloud Vision API and AWS Textract
# Optimized for 200+ PDFs with 200+ pages each
#
# Setup:
# pip install google-cloud-vision boto3 pdf2image pillow tqdm python-dotenv

import os
import sys
import json
import time
import asyncio
import io
import base64
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Union
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from datetime import datetime
import logging

import boto3
from google.cloud import vision
from pdf2image import convert_from_path
from pdf2image.pdf2image import pdfinfo_from_path
from PIL import Image
from tqdm import tqdm
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# ============ CONFIGURATION ============
@dataclass
class CloudConfig:
    # Input/Output paths
    INPUT_DIR: str = r"E:\Projects\pdfs"
    OUTPUT_DIR: str = r"E:\Projects\cloud_ocr_results"
    POPPLER_DIR: str = r"E:\tools\poppler-25.07.0\Library\bin"
    
    # Cloud provider preference
    PRIMARY_PROVIDER: str = "google"  # "google", "aws", or "both"
    FALLBACK_ENABLED: bool = True     # Use fallback provider if primary fails
    
    # Processing parameters
    DPI: int = 200                    # Lower DPI for cloud (they handle scaling)
    MAX_WORKERS: int = 10             # Concurrent API requests (adjust based on quota)
    BATCH_SIZE: int = 20              # Pages per batch for memory management
    THREAD_COUNT: int = 4             # pdf2image threads
    
    # Quality control
    MIN_CONFIDENCE: float = 0.7       # Minimum confidence for text acceptance
    MIN_PAGE_CHARS: int = 20          # Minimum characters per page
    
    # Cost optimization
    MAX_REQUESTS_PER_MINUTE: int = 1800  # API rate limiting
    ENABLE_CACHING: bool = True          # Cache results to avoid re-processing
    
    # Resume functionality  
    RESUME_MODE: bool = True
    PROGRESS_FILE: str = "cloud_ocr_progress.json"
    
    # Google Cloud Vision settings
    GOOGLE_FEATURES: List = None      # Will be set in __post_init__
    GOOGLE_IMAGE_CONTEXT: Dict = None
    
    # AWS Textract settings
    AWS_REGION: str = "us-east-1"
    
    def __post_init__(self):
        if self.GOOGLE_FEATURES is None:
            self.GOOGLE_FEATURES = [vision.Feature(type_=vision.Feature.Type.DOCUMENT_TEXT_DETECTION)]
        
        if self.GOOGLE_IMAGE_CONTEXT is None:
            self.GOOGLE_IMAGE_CONTEXT = {
                "language_hints": ["en"]  # Add more languages as needed: ["en", "es", "fr"]
            }

config = CloudConfig()

# ============ CLOUD PROVIDERS SETUP ============
class CloudOCRProviders:
    def __init__(self):
        self.google_client = None
        self.aws_client = None
        self.setup_providers()
    
    def setup_providers(self):
        """Initialize cloud provider clients"""
        try:
            # Google Cloud Vision setup
            if config.PRIMARY_PROVIDER in ["google", "both"]:
                # Method 1: Using service account key file
                if os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
                    self.google_client = vision.ImageAnnotatorClient()
                    print("[✓] Google Cloud Vision initialized with service account")
                
                # Method 2: Using service account key from environment variable
                elif os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON"):
                    import json
                    from google.oauth2 import service_account
                    
                    service_account_info = json.loads(os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON"))
                    credentials = service_account.Credentials.from_service_account_info(service_account_info)
                    self.google_client = vision.ImageAnnotatorClient(credentials=credentials)
                    print("[✓] Google Cloud Vision initialized with JSON credentials")
                
                else:
                    print("[!] Google Cloud credentials not found. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON")
        
        except Exception as e:
            print(f"[!] Google Cloud Vision setup failed: {e}")
            self.google_client = None
        
        try:
            # AWS Textract setup
            if config.PRIMARY_PROVIDER in ["aws", "both"]:
                # Uses AWS credentials from ~/.aws/credentials, environment variables, or IAM roles
                self.aws_client = boto3.client(
                    'textract',
                    region_name=config.AWS_REGION,
                    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
                    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY")
                )
                print("[✓] AWS Textract initialized")
        
        except Exception as e:
            print(f"[!] AWS Textract setup failed: {e}")
            self.aws_client = None
        
        # Validate at least one provider is available
        if not self.google_client and not self.aws_client:
            print("[!] No cloud providers available! Please check your credentials.")
            sys.exit(1)

class RateLimiter:
    """Simple rate limiter for API requests"""
    
    def __init__(self, max_requests_per_minute: int):
        self.max_requests = max_requests_per_minute
        self.requests = []
        self.lock = asyncio.Lock() if asyncio.iscoroutinefunction(self.__init__) else None
    
    def wait_if_needed(self):
        current_time = time.time()
        # Remove requests older than 1 minute
        self.requests = [req_time for req_time in self.requests if current_time - req_time < 60]
        
        if len(self.requests) >= self.max_requests:
            sleep_time = 60 - (current_time - self.requests[0]) + 1
            if sleep_time > 0:
                print(f"[i] Rate limit reached, sleeping for {sleep_time:.1f} seconds...")
                time.sleep(sleep_time)
        
        self.requests.append(current_time)

# ============ PROGRESS TRACKING ============
class CloudProgressTracker:
    def __init__(self, progress_file: str):
        self.progress_file = Path(config.OUTPUT_DIR) / progress_file
        self.data = self.load_progress()
        self.rate_limiter = RateLimiter(config.MAX_REQUESTS_PER_MINUTE)
    
    def load_progress(self) -> Dict:
        if self.progress_file.exists():
            try:
                with open(self.progress_file, 'r') as f:
                    return json.load(f)
            except Exception as e:
                print(f"[!] Could not load progress file: {e}")
        
        return {
            "completed_files": {},  # filename: {pages: int, provider: str, timestamp: str}
            "failed_files": [],
            "start_time": datetime.now().isoformat(),
            "total_pages_processed": 0,
            "total_api_calls": 0,
            "estimated_cost": {"google": 0.0, "aws": 0.0}
        }
    
    def save_progress(self):
        try:
            self.progress_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.progress_file, 'w') as f:
                json.dump(self.data, f, indent=2)
        except Exception as e:
            print(f"[!] Could not save progress: {e}")
    
    def mark_completed(self, filename: str, pages_count: int, provider: str):
        self.data["completed_files"][filename] = {
            "pages": pages_count,
            "provider": provider,
            "timestamp": datetime.now().isoformat()
        }
        self.data["total_pages_processed"] += pages_count
        self.data["total_api_calls"] += pages_count
        
        # Estimate costs (approximate)
        if provider == "google":
            self.data["estimated_cost"]["google"] += pages_count * 0.0015  # $1.50 per 1000 requests
        elif provider == "aws":
            self.data["estimated_cost"]["aws"] += pages_count * 0.0010    # $1.00 per 1000 requests
        
        self.save_progress()
    
    def mark_failed(self, filename: str, error: str):
        self.data["failed_files"].append({
            "file": filename,
            "error": str(error),
            "timestamp": datetime.now().isoformat()
        })
        self.save_progress()
    
    def is_completed(self, filename: str) -> bool:
        return filename in self.data["completed_files"]

# ============ CLOUD OCR FUNCTIONS ============
def pil_to_bytes(pil_image: Image.Image, format: str = 'PNG') -> bytes:
    """Convert PIL image to bytes"""
    img_byte_arr = io.BytesIO()
    pil_image.save(img_byte_arr, format=format)
    return img_byte_arr.getvalue()

def ocr_with_google_vision(image_bytes: bytes, providers: CloudOCRProviders) -> Tuple[str, float]:
    """Perform OCR using Google Cloud Vision API"""
    try:
        image = vision.Image(content=image_bytes)
        
        # Create request with language hints
        image_context = vision.ImageContext(**config.GOOGLE_IMAGE_CONTEXT)
        request = vision.AnnotateImageRequest(
            image=image,
            features=config.GOOGLE_FEATURES,
            image_context=image_context
        )
        
        response = providers.google_client.annotate_image(request=request)
        
        if response.error.message:
            raise Exception(f"Google Vision API error: {response.error.message}")
        
        # Extract text and confidence
        if response.full_text_annotation:
            text = response.full_text_annotation.text
            # Calculate average confidence from text annotations
            confidences = []
            for page in response.full_text_annotation.pages:
                for block in page.blocks:
                    if hasattr(block, 'confidence'):
                        confidences.append(block.confidence)
            
            avg_confidence = sum(confidences) / len(confidences) if confidences else 0.9
            return text.strip(), avg_confidence
        
        return "", 0.0
        
    except Exception as e:
        raise Exception(f"Google Vision OCR failed: {str(e)}")

def ocr_with_aws_textract(image_bytes: bytes, providers: CloudOCRProviders) -> Tuple[str, float]:
    """Perform OCR using AWS Textract"""
    try:
        response = providers.aws_client.detect_document_text(
            Document={'Bytes': image_bytes}
        )
        
        # Extract text and confidence
        text_blocks = []
        confidences = []
        
        for block in response.get('Blocks', []):
            if block['BlockType'] == 'LINE':
                text_blocks.append(block.get('Text', ''))
                if 'Confidence' in block:
                    confidences.append(block['Confidence'] / 100.0)  # Convert to 0-1 scale
        
        text = '\n'.join(text_blocks)
        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.9
        
        return text.strip(), avg_confidence
        
    except Exception as e:
        raise Exception(f"AWS Textract OCR failed: {str(e)}")

def ocr_single_page_cloud(args) -> Tuple[int, str, float, str]:
    """OCR a single page using cloud providers"""
    page_num, pil_image, providers, progress_tracker = args
    
    try:
        progress_tracker.rate_limiter.wait_if_needed()
        
        # Convert image to bytes
        image_bytes = pil_to_bytes(pil_image, 'PNG')
        
        text = ""
        confidence = 0.0
        provider_used = ""
        
        # Try primary provider
        if config.PRIMARY_PROVIDER == "google" and providers.google_client:
            try:
                text, confidence = ocr_with_google_vision(image_bytes, providers)
                provider_used = "google"
            except Exception as e:
                if not config.FALLBACK_ENABLED:
                    raise e
                print(f"    [!] Google failed for page {page_num}, trying AWS...")
        
        elif config.PRIMARY_PROVIDER == "aws" and providers.aws_client:
            try:
                text, confidence = ocr_with_aws_textract(image_bytes, providers)
                provider_used = "aws"
            except Exception as e:
                if not config.FALLBACK_ENABLED:
                    raise e
                print(f"    [!] AWS failed for page {page_num}, trying Google...")
        
        # Fallback provider
        if not text and config.FALLBACK_ENABLED:
            if provider_used != "google" and providers.google_client:
                text, confidence = ocr_with_google_vision(image_bytes, providers)
                provider_used = "google_fallback"
            elif provider_used != "aws" and providers.aws_client:
                text, confidence = ocr_with_aws_textract(image_bytes, providers)
                provider_used = "aws_fallback"
        
        # Quality check
        if len(text) < config.MIN_PAGE_CHARS or confidence < config.MIN_CONFIDENCE:
            print(f"    [!] Page {page_num} low quality: chars={len(text)}, conf={confidence:.2f}")
        
        return page_num, text, confidence, provider_used
        
    except Exception as e:
        return page_num, f"[CLOUD OCR ERROR: {str(e)}]", 0.0, "error"

def process_pdf_batch_cloud(pdf_path: str, start_page: int, end_page: int, providers: CloudOCRProviders, progress_tracker: CloudProgressTracker) -> List[Tuple[int, str, float, str]]:
    """Process a batch of PDF pages using cloud OCR"""
    try:
        print(f"    [i] Converting pages {start_page}-{end_page} to images...")
        
        # Convert pages to images
        pages = convert_from_path(
            pdf_path,
            dpi=config.DPI,
            first_page=start_page,
            last_page=end_page,
            poppler_path=config.POPPLER_DIR,
            thread_count=config.THREAD_COUNT
        )
        
        print(f"    [i] Performing cloud OCR on {len(pages)} pages...")
        
        # Prepare OCR tasks
        ocr_tasks = [(start_page + i, page, providers, progress_tracker) for i, page in enumerate(pages)]
        
        # Process with cloud OCR
        results = []
        with ThreadPoolExecutor(max_workers=config.MAX_WORKERS) as executor:
            future_to_page = {executor.submit(ocr_single_page_cloud, task): task[0] for task in ocr_tasks}
            
            for future in tqdm(as_completed(future_to_page), desc="    Cloud OCR", total=len(ocr_tasks)):
                try:
                    result = future.result(timeout=60)  # 1-minute timeout per page
                    results.append(result)
                except Exception as e:
                    page_num = future_to_page[future]
                    print(f"    [!] Page {page_num} failed: {str(e)}")
                    results.append((page_num, f"[TIMEOUT: {str(e)}]", 0.0, "error"))
        
        return sorted(results, key=lambda x: x[0])
        
    except Exception as e:
        print(f"    [!] Batch processing failed: {str(e)}")
        return []

def process_single_pdf_cloud(pdf_path: str, providers: CloudOCRProviders, progress_tracker: CloudProgressTracker) -> bool:
    """Process a single PDF using cloud OCR"""
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
        
        # Create output files
        output_dir = Path(config.OUTPUT_DIR) / "texts"
        output_dir.mkdir(parents=True, exist_ok=True)
        
        output_path = output_dir / f"{pdf_name}.txt"
        stats_path = Path(config.OUTPUT_DIR) / "stats" / f"{pdf_name}_stats.json"
        stats_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Process in batches
        all_results = []
        total_batches = (total_pages + config.BATCH_SIZE - 1) // config.BATCH_SIZE
        
        for batch_num in range(total_batches):
            start_page = batch_num * config.BATCH_SIZE + 1
            end_page = min((batch_num + 1) * config.BATCH_SIZE, total_pages)
            
            print(f"    [i] Batch {batch_num + 1}/{total_batches}")
            
            batch_results = process_pdf_batch_cloud(pdf_path, start_page, end_page, providers, progress_tracker)
            all_results.extend(batch_results)
        
        # Write results
        with open(output_path, 'w', encoding='utf-8') as f:
            provider_counts = {}
            total_confidence = 0
            valid_pages = 0
            
            for page_num, text, confidence, provider in sorted(all_results, key=lambda x: x[0]):
                # Track provider usage
                provider_counts[provider] = provider_counts.get(provider, 0) + 1
                
                if confidence > 0:
                    total_confidence += confidence
                    valid_pages += 1
                
                f.write(f"\n--- Page {page_num} (Provider: {provider}, Confidence: {confidence:.3f}) ---\n")
                f.write(text)
                if not text.endswith('\n'):
                    f.write('\n')
        
        # Calculate statistics
        avg_confidence = total_confidence / valid_pages if valid_pages > 0 else 0.0
        
        stats = {
            "pdf_name": pdf_name,
            "total_pages": total_pages,
            "processed_pages": len(all_results),
            "avg_confidence": avg_confidence,
            "provider_usage": provider_counts,
            "total_characters": sum(len(r[1]) for r in all_results),
            "low_confidence_pages": len([r for r in all_results if r[2] < config.MIN_CONFIDENCE]),
            "processing_time": datetime.now().isoformat(),
            "estimated_cost": {
                "google": len([r for r in all_results if r[3].startswith("google")]) * 0.0015,
                "aws": len([r for r in all_results if r[3].startswith("aws")]) * 0.0010
            }
        }
        
        with open(stats_path, 'w') as f:
            json.dump(stats, f, indent=2)
        
        # Mark as completed
        primary_provider = max(provider_counts.keys(), key=lambda k: provider_counts[k]) if provider_counts else config.PRIMARY_PROVIDER
        progress_tracker.mark_completed(pdf_name, total_pages, primary_provider)
        
        print(f"    [✓] Completed! Avg confidence: {avg_confidence:.3f}")
        print(f"    [✓] Provider usage: {provider_counts}")
        print(f"    [✓] Text saved to: {output_path}")
        
        return True
        
    except Exception as e:
        error_msg = f"Failed to process {pdf_name}: {str(e)}"
        print(f"    [!] {error_msg}")
        progress_tracker.mark_failed(pdf_name, error_msg)
        return False

def setup_logging():
    """Setup logging configuration"""
    log_dir = Path(config.OUTPUT_DIR) / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s',
        handlers=[
            logging.FileHandler(log_dir / f"cloud_ocr_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log"),
            logging.StreamHandler()
        ]
    )

def main():
    """Main function"""
    print("=== Cloud-Based Batch OCR Processor ===")
    print(f"Primary Provider: {config.PRIMARY_PROVIDER.upper()}")
    print(f"Max Workers: {config.MAX_WORKERS}, DPI: {config.DPI}, Batch Size: {config.BATCH_SIZE}")
    
    # Setup
    setup_logging()
    
    # Initialize cloud providers
    providers = CloudOCRProviders()
    
    # Initialize progress tracking  
    progress_tracker = CloudProgressTracker(config.PROGRESS_FILE)
    
    # Find PDF files
    pdf_files = list(Path(config.INPUT_DIR).glob("*.pdf"))
    if not pdf_files:
        print(f"[!] No PDF files found in {config.INPUT_DIR}")
        return
    
    print(f"[i] Found {len(pdf_files)} PDF files")
    
    # Filter already processed files
    if config.RESUME_MODE:
        remaining_files = [f for f in pdf_files if not progress_tracker.is_completed(f.stem)]
        print(f"[i] {len(pdf_files) - len(remaining_files)} files already processed")
        pdf_files = remaining_files
    
    if not pdf_files:
        print("[i] All files already processed!")
        print(f"[i] Estimated total cost so far: Google ${progress_tracker.data['estimated_cost']['google']:.2f}, AWS ${progress_tracker.data['estimated_cost']['aws']:.2f}")
        return
    
    # Process files
    start_time = time.time()
    successful = 0
    failed = 0
    
    for i, pdf_file in enumerate(pdf_files):
        print(f"\n[{i+1}/{len(pdf_files)}] Processing: {pdf_file.name}")
        
        if process_single_pdf_cloud(str(pdf_file), providers, progress_tracker):
            successful += 1
        else:
            failed += 1
    
    # Final summary
    elapsed_time = time.time() - start_time
    print(f"\n=== Processing Complete ===")
    print(f"Total time: {elapsed_time/3600:.2f} hours")
    print(f"Successful: {successful}, Failed: {failed}")
    print(f"Total pages processed: {progress_tracker.data['total_pages_processed']}")
    print(f"Average speed: {progress_tracker.data['total_pages_processed']/(elapsed_time/60):.1f} pages/minute")
    print(f"Estimated costs: Google ${progress_tracker.data['estimated_cost']['google']:.2f}, AWS ${progress_tracker.data['estimated_cost']['aws']:.2f}")
    print(f"Results saved in: {config.OUTPUT_DIR}")

if __name__ == "__main__":
    main()