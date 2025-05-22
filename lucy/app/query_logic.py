import os
import logging
from dotenv import load_dotenv
from pinecone import Pinecone
import google.generativeai as genai
import requests # For calling OpenRouter API

# --- Configuration & Initialization ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Load environment variables from lucy_app/.env
dotenv_path = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(dotenv_path):
    logging.info(f"Loading environment variables from: {dotenv_path}")
    load_dotenv(dotenv_path=dotenv_path)
else:
    logging.warning(f".env file not found at {dotenv_path}. Relying on system environment variables.")

PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME")

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
GOOGLE_EMBEDDING_MODEL_ID = os.getenv("GOOGLE_EMBEDDING_MODEL_ID")

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_MODEL_NAME = os.getenv("OPENROUTER_MODEL_NAME")
OPENROUTER_SITE_URL = os.getenv("OPENROUTER_SITE_URL") # Optional
OPENROUTER_SITE_NAME = os.getenv("OPENROUTER_SITE_NAME") # Optional

# Initialize Pinecone
pc = None
pinecone_index = None
if PINECONE_API_KEY and PINECONE_INDEX_NAME:
    try:
        pc = Pinecone(api_key=PINECONE_API_KEY)
        if PINECONE_INDEX_NAME in [index.name for index in pc.list_indexes().indexes]:
            pinecone_index = pc.Index(PINECONE_INDEX_NAME)
            logging.info(f"Successfully connected to Pinecone index '{PINECONE_INDEX_NAME}'.")
        else:
            logging.error(f"Pinecone index '{PINECONE_INDEX_NAME}' not found.")
            pinecone_index = None # Ensure it's None if not found
    except Exception as e:
        logging.error(f"Failed to initialize Pinecone: {e}", exc_info=True)
else:
    logging.warning("Pinecone API Key or Index Name not configured. Pinecone integration disabled.")

# Initialize Google AI
if GOOGLE_API_KEY:
    try:
        genai.configure(api_key=GOOGLE_API_KEY)
        logging.info("Google AI client configured successfully.")
    except Exception as e:
        logging.error(f"Failed to configure Google AI client: {e}", exc_info=True)
else:
    logging.warning("Google API Key not configured. Google AI embedding disabled.")


def get_embedding_for_query(text_query: str):
    """Generates embedding for a single text query."""
    if not GOOGLE_API_KEY or not GOOGLE_EMBEDDING_MODEL_ID:
        logging.error("Google API key or model ID not configured for embeddings.")
        return None
    try:
        # For models/embedding-001 with a single query, content is a string
        response = genai.embed_content(
            model=GOOGLE_EMBEDDING_MODEL_ID,
            content=text_query,
            task_type="RETRIEVAL_QUERY" # Important: Use RETRIEVAL_QUERY for queries
        )
        return response['embedding']
    except Exception as e:
        logging.error(f"Error getting Google embedding for query '{text_query[:50]}...': {e}", exc_info=True)
        return None

def query_pinecone(query_embedding, top_k=3):
    """Queries Pinecone index to retrieve relevant text chunks."""
    if not pinecone_index:
        logging.error("Pinecone index not initialized.")
        return []
    if not query_embedding:
        logging.error("No query embedding provided to Pinecone.")
        return []
    try:
        results = pinecone_index.query(
            vector=query_embedding,
            top_k=top_k,
            include_metadata=True
        )
        # Extract text from metadata
        contexts = [match['metadata']['text'] for match in results['matches'] if 'metadata' in match and 'text' in match['metadata']]
        return contexts
    except Exception as e:
        logging.error(f"Error querying Pinecone: {e}", exc_info=True)
        return []

def get_llm_response(question: str, context_chunks: list):
    """Gets a response from the LLM (via OpenRouter) using the question and context."""
    if not OPENROUTER_API_KEY or not OPENROUTER_MODEL_NAME:
        logging.error("OpenRouter API key or model name not configured.")
        return "Sorry, I'm having trouble connecting to my brain right now."

    context_str = "\n\n---\n\n".join(context_chunks)
    if not context_str:
        logging.info("No context found from Pinecone. Answering question without specific property context.")
        context_str = "No specific property information was found for this question."

    prompt = f"""You are Lucy, a friendly and helpful AI assistant for guests staying at a property.
Your goal is to answer guest questions based *only* on the provided "Property Information Context" below.
If the answer is not found in the context, clearly state that you don't have that specific information from the property details available.
Do not make up answers or use external knowledge beyond the provided context. Be concise and directly answer a specific question.

Property Information Context:
---
{context_str}
---

Guest Question: {question}

Answer:"""

    logging.info(f"Sending prompt to OpenRouter with model: {OPENROUTER_MODEL_NAME}")
    # logging.debug(f"Full prompt being sent:\n{prompt}") # Can be noisy

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json"
    }
    # Optional headers for tracking/moderation if your app is registered with OpenRouter
    if OPENROUTER_SITE_URL:
        headers["HTTP-Referer"] = OPENROUTER_SITE_URL
    if OPENROUTER_SITE_NAME:
        headers["X-Title"] = OPENROUTER_SITE_NAME

    data = {
        "model": OPENROUTER_MODEL_NAME,
        "messages": [
            {"role": "user", "content": prompt} # Simple user message with full context in prompt
        ],
        "temperature": 0.3, # Adjust for creativity vs. factuality
        "max_tokens": 300   # Adjust as needed
    }

    try:
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=data,
            timeout=90 # 90 seconds timeout for the LLM response
        )
        response.raise_for_status()  # Raise an exception for HTTP errors
        api_response_json = response.json()

        if api_response_json and 'choices' in api_response_json and len(api_response_json['choices']) > 0:
            llm_answer = api_response_json['choices'][0]['message']['content'].strip()
            # logging.debug(f"LLM Raw Full Response: {api_response_json}")
            logging.info(f"LLM Answer: {llm_answer[:100]}...") # Log start of answer
            return llm_answer
        else:
            logging.error(f"Unexpected response structure from OpenRouter: {api_response_json}")
            return "Sorry, I received an unusual response. Please try again."

    except requests.exceptions.RequestException as e:
        logging.error(f"Error calling OpenRouter API: {e}", exc_info=True)
        if e.response is not None:
            logging.error(f"OpenRouter Response Status Code: {e.response.status_code}")
            logging.error(f"OpenRouter Response Body: {e.response.text}")
        return "Sorry, there was an error communicating with the AI. Please try again later."
    except Exception as e:
        logging.error(f"An unexpected error occurred while getting LLM response: {e}", exc_info=True)
        return "An unexpected error occurred. Please try asking again."


def ask_lucy(question: str):
    """Main function to process a question and get Lucy's answer."""
    logging.info(f"\n--- New Question for Lucy ---")
    logging.info(f"Received question: {question}")

    if not all([PINECONE_API_KEY, PINECONE_INDEX_NAME, GOOGLE_API_KEY, GOOGLE_EMBEDDING_MODEL_ID, OPENROUTER_API_KEY, OPENROUTER_MODEL_NAME]):
        logging.error("One or more critical API keys or configurations are missing in .env")
        return "I'm sorry, I'm not fully configured to answer questions right now. Please contact support."
    if not pinecone_index:
        logging.error("Pinecone is not available.")
        return "I'm sorry, I can't access the property information database at the moment."


    # 1. Get embedding for the user's question
    query_embedding = get_embedding_for_query(question)
    if not query_embedding:
        return "I'm sorry, I couldn't understand your question for searching. Could you rephrase?"

    # 2. Query Pinecone to find relevant context
    logging.info("Querying Pinecone for relevant context...")
    context_chunks = query_pinecone(query_embedding, top_k=3) # Get top 3 chunks
    if context_chunks:
        logging.info(f"Retrieved {len(context_chunks)} context chunks from Pinecone.")
        # for i, chunk in enumerate(context_chunks):
        #     logging.debug(f"Context chunk {i+1}: {chunk[:100]}...")
    else:
        logging.info("No specific context chunks found in Pinecone for this query.")

    # 3. Get response from LLM
    logging.info("Getting response from LLM...")
    answer = get_llm_response(question, context_chunks)
    return answer

if __name__ == '__main__':
    # This is for direct testing of this script
    # For the API, Flask will call ask_lucy
    print("Testing query_logic.py directly...")
    # Ensure your .env file in lucy_app is configured correctly
    test_question = "What is the wifi password?"
    # test_question = "Tell me about the local amenities."
    # test_question = "How does the AC work?"

    response = ask_lucy(test_question)
    print(f"\nQuestion: {test_question}")
    print(f"Lucy's Answer: {response}")

    test_question_2 = "Is there a swimming pool?"
    response_2 = ask_lucy(test_question_2)
    print(f"\nQuestion: {test_question_2}")
    print(f"Lucy's Answer: {response_2}")
