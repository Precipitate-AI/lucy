# lucy_app/test_query_script.py
from query_logic import ask_lucy
import logging

# Optional: If you want to see INFO logs from query_logic when running this script
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def run_test():
    print("--- Running Test Script for Lucy's Query Logic ---")

    questions = [
        "What is the wifi password?",
        "How do I check out?",
        "Are pets allowed?",
        "Tell me about the AC unit.",
        "What time is breakfast?" # Example of a question that might not be in context
    ]

    for q in questions:
        print(f"\nUser Question: {q}")
        answer = ask_lucy(q)
        print(f"Lucy's Answer: {answer}")
        print("--------------------------------------------------")

if __name__ == "__main__":
    # Make sure your lucy_app/.env file is correctly configured with your API keys!
    run_test()
