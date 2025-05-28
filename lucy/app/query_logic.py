# app.query_logic.py

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

def query_pinecone(query_embedding, top_k=3, property_id_filter=None):
    """Queries Pinecone index to retrieve relevant text chunks."""
    if not pinecone_index:
        logging.error("Pinecone index not initialized.")
        return []
    if not query_embedding:
        logging.error("No query embedding provided to Pinecone.")
        return []
    try:
        query_params = {
            "vector": query_embedding,
            "top_k": top_k,
            "include_metadata": True
        }
        if property_id_filter:
            query_params["filter"] = {"propertyId": property_id_filter}
            logging.info(f"Querying Pinecone with filter: {{'propertyId': '{property_id_filter}'}}")
        else:
            logging.info("Querying Pinecone without propertyId filter (may return results from any property).")


        results = pinecone_index.query(**query_params)
        # Extract text from metadata        
        contexts = [match['metadata']['text'] for match in results['matches'] if 'metadata' in match and 'text' in match['metadata']]
        return contexts
    except Exception as e:
        logging.error(f"Error querying Pinecone: {e}", exc_info=True)
        return []

def get_llm_response(question: str, context_chunks: list, property_id: str = "the current property"):
    """Gets a response from the LLM (via OpenRouter) using the question and context."""
    if not OPENROUTER_API_KEY or not OPENROUTER_MODEL_NAME:
        logging.error("OpenRouter API key or model name not configured.")
        return "Sorry, I'm having trouble connecting to my brain right now."

    context_str = "\n\n---\n\n".join(context_chunks)
    has_property_context = bool(context_chunks and any(chunk.strip() for chunk in context_chunks))

    city_name = "the current location" # Default
    if property_id: # Check if property_id is provided and not None/empty
        pid_lower = property_id.lower()
        if "bali" in pid_lower or "nelayan" in pid_lower or "seminyak" in pid_lower or "ubud" in pid_lower or "canggu" in pid_lower:
            city_name = "Bali"
        elif "dubai" in pid_lower:
            city_name = "Dubai"
    logging.info(f"Determined city: {city_name} for property ID: {property_id}")


    prompt_parts = [
        f"You are Lucy, a friendly, polite, and helpful AI assistant.",
    ]
    if property_id and property_id != "the current property":
         prompt_parts.append(f"You are currently assisting a guest staying at property '{property_id}'.")


    if has_property_context:
        prompt_parts.append(
            "Your primary goal is to answer guest questions based *only* on the provided 'Property Information Context' below."
        )
        prompt_parts.append(
            "If the answer is not found in the property context, clearly state that you don't have that specific information from the property details available."
        )
        prompt_parts.append(
            f"\nProperty Information Context for '{property_id}':\n---\n{context_str}\n---"
        )
    else:
        prompt_parts.append(
            f"No specific property information was found for '{property_id}' related to the guest's question."
        )
        prompt_parts.append(
            f"In this case, OR if the question is clearly a general question about {city_name} (e.g. best beaches, local restaurants, activities), "
            f"act as a knowledgeable local expert for {city_name} and answer using your general knowledge."
        )
        prompt_parts.append(
            f"If the question is not about the property OR {city_name}, and you don't know the answer, clearly state that you don't have information on that topic."
        )

    prompt_parts.append(
        "Do not make up answers or use external knowledge beyond what has been specified. Be concise and directly answer the question if possible."
    )
    prompt_parts.append(f"\nGuest Question: {question}")
    prompt_parts.append("\nAnswer:")

    prompt = "\n".join(prompt_parts)

    logging.info(f"Sending prompt to OpenRouter with model: {OPENROUTER_MODEL_NAME}")
    # logging.debug(f"Full prompt being sent:\n{prompt}") # Can be noisy

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json"
    }
    if OPENROUTER_SITE_URL: headers["HTTP-Referer"] = OPENROUTER_SITE_URL
    if OPENROUTER_SITE_NAME: headers["X-Title"] = OPENROUTER_SITE_NAME

    data = {
        "model": OPENROUTER_MODEL_NAME,
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.4, 
        "max_tokens": 400
    }

    try:
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=data,
            timeout=90
        )
        response.raise_for_status()
        api_response_json = response.json()

        if api_response_json and 'choices' in api_response_json and len(api_response_json['choices']) > 0:
            llm_answer = api_response_json['choices'][0]['message']['content'].strip()
            logging.info(f"LLM Answer: {llm_answer[:100]}...")
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


def ask_lucy(question: str, property_id: str = "Unit4BNelayanReefApartment"): # Default for testing, pass from caller
    """Main function to process a question and get Lucy's answer."""
    logging.info(f"\n--- New Question for Lucy (Property: {property_id}) ---")
    logging.info(f"Received question: {question}")

    if not all([PINECONE_API_KEY, PINECONE_INDEX_NAME, GOOGLE_API_KEY, GOOGLE_EMBEDDING_MODEL_ID, OPENROUTER_API_KEY, OPENROUTER_MODEL_NAME]):
        logging.error("One or more critical API keys or configurations are missing in .env")
        return "I'm sorry, I'm not fully configured to answer questions right now. Please contact support."
    if not pinecone_index:
        logging.error("Pinecone is not available.")
        return "I'm sorry, I can't access the property information database at the moment."

    query_embedding = get_embedding_for_query(question)
    if not query_embedding:
        return "I'm sorry, I couldn't understand your question for searching. Could you rephrase?"

    logging.info(f"Querying Pinecone for relevant context (property: {property_id})...")
    # Pass property_id to query_pinecone for filtering
    context_chunks = query_pinecone(query_embedding, top_k=3, property_id_filter=property_id) 
    
    if context_chunks:
        logging.info(f"Retrieved {len(context_chunks)} context chunks from Pinecone.")
    else:
        logging.info(f"No specific property context chunks found in Pinecone for property '{property_id}' and query.")

    logging.info("Getting response from LLM...")
    answer = get_llm_response(question, context_chunks, property_id=property_id)
    return answer

if __name__ == '__main__':
    print("Testing query_logic.py directly...")
    
    # Test property-specific question for Bali property
    bali_property_id = "Unit4BNelayanReefApartment"
    test_question_property_bali = "What is the wifi password?"
    response_property_bali = ask_lucy(test_question_property_bali, property_id=bali_property_id)
    print(f"\nQuestion (Property: {bali_property_id}): {test_question_property_bali}")
    print(f"Lucy's Answer: {response_property_bali}")

    # Test general Bali question (context of Bali property)
    test_question_general_bali = "What are some good beaches in Seminyak?"
    response_general_bali = ask_lucy(test_question_general_bali, property_id=bali_property_id)
    print(f"\nQuestion (General Bali, context property: {bali_property_id}): {test_question_general_bali}")
    print(f"Lucy's Answer: {response_general_bali}")

    # Simulate a Dubai property for testing Dubai general questions
    # Ensure you have data for a property_id like 'MyDubaiProperty' or similar in Pinecone,
    # or the RAG property specific part won't find context, which is fine for general questions.
    dubai_property_id = "MyDubaiProperty" # Replace with an actual Dubai property ID you might have
    
    test_question_property_dubai = "Is there a pool at this Dubai property?"
    response_property_dubai = ask_lucy(test_question_property_dubai, property_id=dubai_property_id)
    print(f"\nQuestion (Property: {dubai_property_id}): {test_question_property_dubai}")
    print(f"Lucy's Answer: {response_property_dubai}")

    test_question_general_dubai = "What's the best time to visit the Burj Khalifa?"
    response_general_dubai = ask_lucy(test_question_general_dubai, property_id=dubai_property_id) # Context of Dubai property
    print(f"\nQuestion (General Dubai, context property: {dubai_property_id}): {test_question_general_dubai}")
    print(f"Lucy's Answer: {response_general_dubai}")

    test_question_no_context = "What is the capital of France?"
    response_no_context = ask_lucy(test_question_no_context, property_id=bali_property_id)
    print(f"\nQuestion (No context relevant to property/city): {test_question_no_context}")
    print(f"Lucy's Answer: {response_no_context}")

