# lucy_app/app.py
from flask import Flask, request, jsonify
from query_logic import ask_lucy, PINECONE_API_KEY # Import necessary items
import logging
import os

# Load environment variables (Flask might not do this automatically from .env in some contexts)
# query_logic.py already loads it, but this ensures Flask app itself is aware if needed directly
from dotenv import load_dotenv
dotenv_path_app = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(dotenv_path_app):
    load_dotenv(dotenv_path=dotenv_path_app)


app = Flask(__name__)

# Configure logging for Flask app if not already configured by query_logic
if not logging.getLogger().hasHandlers():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

@app.route('/')
def home():
    return "Lucy Query API is running!"

@app.route('/api/ask', methods=['POST'])
def handle_ask_lucy():
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    question = data.get('question')

    if not question:
        return jsonify({"error": "Missing 'question' in JSON payload"}), 400

    if not PINECONE_API_KEY: # Quick check if fundamental config is missing
         logging.error("API called but Pinecone API Key is not configured server-side.")
         return jsonify({"error": "Server configuration error. Cannot process request."}), 500

    logging.info(f"API /api/ask received question: {question}")
    try:
        answer = ask_lucy(question)
        return jsonify({"answer": answer})
    except Exception as e:
        logging.error(f"Error in /api/ask endpoint: {e}", exc_info=True)
        return jsonify({"error": "An internal server error occurred."}), 500

# This is for Vercel deployment. When Vercel builds, it looks for an `app` object.
# For local development: `python app.py`
if __name__ == '__main__':
    # Make sure your .env file in lucy_app is configured!
    # The port 5001 is just an example, Vercel will manage the port in production.
    # For Vercel, you typically don't run app.run() like this in the main script.
    # Vercel uses a WSGI server (like Gunicorn) to run the 'app' object.
    # However, for local testing, this is useful.
    # On Vercel, it will typically pick up 'app = Flask(__name__)'
    logging.info("Starting Flask app for local development...")
    app.run(debug=True, port=os.getenv("PORT", 5001))

