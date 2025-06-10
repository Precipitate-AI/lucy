# scripts/vectorize.py
import os
import re
from dotenv import load_dotenv
from pinecone import Pinecone, ServerlessSpec, PodSpec
import google.generativeai as genai
import time
import logging
from tqdm import tqdm

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Load environment variables from scripts/.env
dotenv_path = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(dotenv_path):
    logging.info(f"Loading environment variables from: {dotenv_path}")
    load_dotenv(dotenv_path=dotenv_path)
else:
    logging.error(f".env file not found at {dotenv_path}. Please ensure it exists and is configured.")
    # exit(1) # You might want to exit if .env is critical and not found

# --- Configuration ---
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
# PINECONE_ENVIRONMENT_CONFIG is read from .env and used to determine spec
PINECONE_ENVIRONMENT_CONFIG = os.getenv("PINECONE_ENVIRONMENT") # Reads "PINECONE_ENVIRONMENT" from .env
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME") or "lucy" # Defaulting to lucy as requested

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
GOOGLE_EMBEDDING_MODEL_ID = os.getenv("GOOGLE_EMBEDDING_MODEL_ID") or "models/embedding-001"

EMBEDDING_DIMENSIONS_STR = os.getenv("EMBEDDING_DIMENSIONS")
if not EMBEDDING_DIMENSIONS_STR or not EMBEDDING_DIMENSIONS_STR.isdigit():
    logging.info(f"EMBEDDING_DIMENSIONS not set or invalid in scripts/.env. Defaulting to 768 for {GOOGLE_EMBEDDING_MODEL_ID}.")
    EMBEDDING_DIMENSIONS = 768
else:
    EMBEDDING_DIMENSIONS = int(EMBEDDING_DIMENSIONS_STR)
    if EMBEDDING_DIMENSIONS != 768 and GOOGLE_EMBEDDING_MODEL_ID == "models/embedding-001":
            logging.warning(f"EMBEDDING_DIMENSIONS in .env is {EMBEDDING_DIMENSIONS}, but {GOOGLE_EMBEDDING_MODEL_ID} uses 768. Using 768.")
            EMBEDDING_DIMENSIONS = 768

PROPERTY_DATA_FOLDER = os.path.join(os.path.dirname(__file__), '..', 'property_data')
BATCH_SIZE_GOOGLE_EMBEDDING = 100
BATCH_SIZE_PINECONE_UPSERT = 100

# --- Initialize Clients ---
# Pinecone Client (pc)
pc = None # Initialize to None
if PINECONE_API_KEY:
    try:
        pc = Pinecone(api_key=PINECONE_API_KEY)
        logging.info("Pinecone client initialized.")
    except Exception as e:
        logging.error(f"Failed to initialize Pinecone client: {e}", exc_info=True)
        # pc remains None, checks later will catch this
else:
    logging.warning("PINECONE_API_KEY not found. Pinecone client not initialized.")

# Google AI
if GOOGLE_API_KEY:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        logging.info("Google AI client configured.")
    except Exception as e:
        logging.error(f"Failed to configure Google AI client: {e}", exc_info=True)
else:
    logging.warning("GOOGLE_API_KEY not found. Google AI client not configured.")


def get_google_embeddings_batch(texts, task_type="RETRIEVAL_DOCUMENT"):
    if not GOOGLE_API_KEY:
        logging.error("Google API key not configured. Cannot get embeddings.")
        return [None] * len(texts)
    if not texts:
        return []
    try:
        response = genai.embed_content(
            model=GOOGLE_EMBEDDING_MODEL_ID,
            content=texts,
            task_type=task_type
        )
        if 'embedding' in response and isinstance(response['embedding'], list):
            valid_embeddings = []
            for emb in response['embedding']:
                if isinstance(emb, list) and all(isinstance(val, float) for val in emb):
                    valid_embeddings.append(emb)
                else:
                    logging.warning(f"Received invalid embedding format for one item. Item Text (start): {str(texts[len(valid_embeddings)][:50]) if len(texts) > len(valid_embeddings) else 'N/A'}")
                    valid_embeddings.append(None)
            return valid_embeddings
        else:
            logging.error(f"Unexpected Google embedding response structure: {response}")
            return [None] * len(texts)
    except Exception as e:
        logging.error(f"Error getting Google embeddings batch: {e}", exc_info=True)
        return [None] * len(texts)


def chunk_text(text, max_chunk_length_chars=2000, overlap=200):
    chunks = []
    text_length = len(text)
    if text_length == 0: return []
    if text_length <= max_chunk_length_chars: return [text.strip()]

    start_index = 0
    while start_index < text_length:
        end_index = min(start_index + max_chunk_length_chars, text_length)
        chunk = text[start_index:end_index]
        chunks.append(chunk)
        if end_index == text_length: break
        start_index += (max_chunk_length_chars - overlap)
        if start_index >= text_length: break

    processed_chunks = [c.strip() for c in chunks if len(c.strip()) > 30]
    # Deduplicate while preserving order (Python 3.7+)
    return list(dict.fromkeys(processed_chunks))


def sanitize_property_id(filename):
    """Convert filename to a valid property ID by removing .txt and replacing spaces/special chars"""
    # Remove .txt extension
    property_id = filename.replace('.txt', '')
    # Replace spaces and special characters with underscores
    property_id = re.sub(r'[^\w\-]', '_', property_id)
    # Remove multiple consecutive underscores
    property_id = re.sub(r'_+', '_', property_id)
    # Remove leading/trailing underscores
    property_id = property_id.strip('_')
    return property_id


def process_and_upload_data():
    # Critical configuration check
    if not all([PINECONE_API_KEY, PINECONE_ENVIRONMENT_CONFIG, GOOGLE_API_KEY, PINECONE_INDEX_NAME]):
        missing_configs = []
        if not PINECONE_API_KEY: missing_configs.append("PINECONE_API_KEY")
        if not PINECONE_ENVIRONMENT_CONFIG: missing_configs.append("PINECONE_ENVIRONMENT (in .env)")
        if not GOOGLE_API_KEY: missing_configs.append("GOOGLE_API_KEY")
        if not PINECONE_INDEX_NAME: missing_configs.append("PINECONE_INDEX_NAME (either in .env or default)")
        logging.error(f"Missing critical configuration(s): {', '.join(missing_configs)}. Please set them in scripts/.env. Exiting.")
        return

    if not pc: # Check if Pinecone client was initialized
        logging.error("Pinecone client (pc) is not initialized. Cannot proceed. Check PINECONE_API_KEY.")
        return

    # --- Check/Create Pinecone Index ---
    try:
        index_list_response = pc.list_indexes()
        existing_index_names = [index_info.name for index_info in index_list_response.indexes]
    except Exception as e:
        logging.error(f"Failed to list Pinecone indexes: {e}", exc_info=True)
        return

    if PINECONE_INDEX_NAME not in existing_index_names:
        logging.info(f"Index '{PINECONE_INDEX_NAME}' not found. Creating it with {EMBEDDING_DIMENSIONS} dimensions...")
        spec = None
        env_lower = PINECONE_ENVIRONMENT_CONFIG.lower()
        cloud_provider, region = None, None

        if env_lower.startswith("aws-"):
            cloud_provider, region = "aws", env_lower.split("aws-", 1)[1] if len(env_lower.split("aws-", 1)) > 1 else None
        elif env_lower.startswith("gcp-") and "starter" not in env_lower:
            cloud_provider, region = "gcp", env_lower.split("gcp-", 1)[1] if len(env_lower.split("gcp-", 1)) > 1 else None
        elif env_lower.startswith("azure-"):
            cloud_provider, region = "azure", env_lower.split("azure-", 1)[1] if len(env_lower.split("azure-", 1)) > 1 else None

        if cloud_provider and region:
            logging.info(f"Attempting to create Serverless index: cloud='{cloud_provider}', region='{region}'")
            spec = ServerlessSpec(cloud=cloud_provider, region=region)
        elif "starter" in env_lower:
            logging.info(f"Attempting to create Pod-based index for environment: '{PINECONE_ENVIRONMENT_CONFIG}', pod_type='p1.x1'")
            spec = PodSpec(environment=PINECONE_ENVIRONMENT_CONFIG, pod_type="p1.x1") # Example, adjust if using starter
        else:
            logging.error(f"Could not determine valid spec from PINECONE_ENVIRONMENT='{PINECONE_ENVIRONMENT_CONFIG}'. "
                          "Expected 'aws-<region>', 'gcp-<region>', 'azure-<region>' for Serverless, "
                          "or an environment like 'gcp-starter' for Pod-based. Check scripts/.env.")
            return

        try:
            pc.create_index(
                name=PINECONE_INDEX_NAME,
                dimension=EMBEDDING_DIMENSIONS,
                metric='cosine',
                spec=spec
            )
            timeout_seconds, check_interval = 300, 10 # 5 minutes timeout, check every 10s
            start_time_creation = time.time()
            logging.info("Waiting for index to be ready...")
            while True:
                index_description = pc.describe_index(PINECONE_INDEX_NAME)
                if index_description.status['ready']:
                    logging.info(f"Index '{PINECONE_INDEX_NAME}' created and ready.")
                    break
                if time.time() - start_time_creation > timeout_seconds:
                    logging.error(f"Timeout waiting for index '{PINECONE_INDEX_NAME}' to become ready.")
                    return
                time.sleep(check_interval)
        except Exception as e:
            logging.error(f"Error creating Pinecone index '{PINECONE_INDEX_NAME}': {e}", exc_info=True)
            return
    else:
        logging.info(f"Using existing index: '{PINECONE_INDEX_NAME}'")
        try:
            index_description = pc.describe_index(PINECONE_INDEX_NAME)
            if index_description.dimension != EMBEDDING_DIMENSIONS:
                logging.error(f"Dimension Mismatch: Existing index '{PINECONE_INDEX_NAME}' ({index_description.dimension}D) vs. config ({EMBEDDING_DIMENSIONS}D). Please resolve.")
                return
            if not index_description.status['ready']:
                logging.error(f"Existing index '{PINECONE_INDEX_NAME}' is not ready. Status: {index_description.status}. Check Pinecone console.")
                return
        except Exception as e:
            logging.error(f"Error describing existing index '{PINECONE_INDEX_NAME}': {e}", exc_info=True)
            return

    pinecone_index = pc.Index(PINECONE_INDEX_NAME)
    # </ Check/Create Pinecone Index >

    all_files_chunks_with_metadata = []
    if not os.path.exists(PROPERTY_DATA_FOLDER):
        logging.error(f"Property data folder not found: {PROPERTY_DATA_FOLDER}")
        return

    logging.info(f"Step 1: Reading and chunking files from {PROPERTY_DATA_FOLDER}...")
    
    # Process all .txt files in the directory
    for filename in os.listdir(PROPERTY_DATA_FOLDER):
        if not filename.endswith(".txt"): 
            continue # Skip non-txt files
        
        # Generate property ID from filename
        property_id = sanitize_property_id(filename)
        
        filepath = os.path.join(PROPERTY_DATA_FOLDER, filename)
        logging.info(f"  Processing: {filename} (Property ID: '{property_id}')")
        try:
            with open(filepath, 'r', encoding='utf-8') as f: 
                content = f.read()
        except Exception as e:
            logging.error(f"Could not read {filepath}: {e}")
            continue

        text_chunks = chunk_text(content)
        if not text_chunks:
            logging.warning(f"    No valid chunks for {filename}.")
            continue
        logging.info(f"    Split into {len(text_chunks)} chunks.")

        for i, chunk_content in enumerate(text_chunks):
            all_files_chunks_with_metadata.append({
                "property_id": property_id, 
                "original_file": filename,
                "chunk_index": i, 
                "text": chunk_content
            })

    if not all_files_chunks_with_metadata:
        logging.info("No text chunks to process.")
        return

    logging.info(f"Total chunks to embed: {len(all_files_chunks_with_metadata)}")
    vectors_to_upsert = []

    logging.info(f"\nStep 2: Generating embeddings ('{GOOGLE_EMBEDDING_MODEL_ID}', batch: {BATCH_SIZE_GOOGLE_EMBEDDING})...")
    for i in tqdm(range(0, len(all_files_chunks_with_metadata), BATCH_SIZE_GOOGLE_EMBEDDING), desc="Embedding"):
        batch_metadata = all_files_chunks_with_metadata[i:i + BATCH_SIZE_GOOGLE_EMBEDDING]
        texts_in_batch = [item['text'] for item in batch_metadata]
        if not texts_in_batch: continue

        embeddings_batch = get_google_embeddings_batch(texts_in_batch)
        # Google API rate limits: embedding-001 default is 300 QPM (5 QPS).
        # A batch of 100 is 1 request. Sleeping 0.2s is conservative.
        time.sleep(0.2) 

        for meta_item, vector_values in zip(batch_metadata, embeddings_batch):
            if vector_values and isinstance(vector_values, list) and len(vector_values) == EMBEDDING_DIMENSIONS:
                vector_id = f"{meta_item['property_id']}_chunk_{meta_item['chunk_index']}"
                vectors_to_upsert.append({
                    "id": vector_id, "values": vector_values,
                    "metadata": {
                        "propertyId": meta_item['property_id'], 
                        "text": meta_item['text'],
                        "original_file": meta_item['original_file']
                    }
                })
            else:
                logging.warning(f"Skipping chunk {meta_item['chunk_index']} for {meta_item['property_id']} due to embedding error.")
    
    if not vectors_to_upsert:
        logging.info("No valid vectors generated. Nothing to upsert.")
        return

    logging.info(f"\nTotal vectors to upsert: {len(vectors_to_upsert)}")
    logging.info(f"\nStep 3: Upserting to Pinecone ('{PINECONE_INDEX_NAME}', batch: {BATCH_SIZE_PINECONE_UPSERT})...")
    for i in tqdm(range(0, len(vectors_to_upsert), BATCH_SIZE_PINECONE_UPSERT), desc="Upserting"):
        batch_vectors = vectors_to_upsert[i:i + BATCH_SIZE_PINECONE_UPSERT]
        try:
            pinecone_index.upsert(vectors=batch_vectors)
        except Exception as e:
            logging.error(f"Error upserting batch to Pinecone: {e}", exc_info=True)

    logging.info(f"\nProcessing complete. Total vectors generated: {len(vectors_to_upsert)}.")
    try:
        stats = pinecone_index.describe_index_stats()
        logging.info(f"Final stats for index '{PINECONE_INDEX_NAME}': {stats}")
    except Exception as e:
        logging.error(f"Could not fetch final stats: {e}")

if __name__ == "__main__":
    # The critical check is now at the start of process_and_upload_data()
    # We can add a simpler check here just for PINECONE_ENVIRONMENT_CONFIG
    # as it's used early.
    if not os.getenv("PINECONE_ENVIRONMENT"):
         logging.error("CRITICAL: PINECONE_ENVIRONMENT is not set in scripts/.env and is required. Exiting.")
    else:
        process_and_upload_data()
