// lucy/pages/admin.js
import { useState } from 'react';
import Head from 'next/head';

export default function AdminPage() {
const [question, setQuestion] = useState('');
const [answer, setAnswer] = useState('');
const [isLoading, setIsLoading] = useState(false);
const [error, setError] = useState('');

const handleSubmit = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;

    setIsLoading(true);
    setError('');
    setAnswer('');

    try {
        // This calls the /api/ask endpoint which is your Python function
        const response = await fetch('/api/ask', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ question }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: "An unexpected error occurred."}));
            throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        setAnswer(data.answer);
    } catch (err) {
        console.error("Error fetching answer:", err);
        setError(err.message || "Failed to get an answer.");
    } finally {
        setIsLoading(false);
    }
};

return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif', maxWidth: '600px', margin: 'auto' }}>
        <Head>
            <title>Lucy Admin - Test Chat</title>
        </Head>

        <h1>Lucy Admin - Test Chat</h1>

        <form onSubmit={handleSubmit}>
            <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="Ask Lucy a question..."
                rows={4}
                style={{ width: '100%', padding: '10px', marginBottom: '10px', boxSizing: 'border-box', border: '1px solid #ccc', borderRadius: '4px' }}
                disabled={isLoading}
            />
            <button type="submit" disabled={isLoading} style={{ padding: '10px 15px', backgroundColor: '#0070f3', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                {isLoading ? 'Asking...' : 'Ask Lucy'}
            </button>
        </form>

        {error && <p style={{ color: 'red', marginTop: '15px' }}>Error: {error}</p>}

        {answer && (
            <div style={{ marginTop: '20px', padding: '15px', border: '1px solid #eee', borderRadius: '4px', backgroundColor: '#f9f9f9' }}>
                <strong>Lucy's Answer:</strong>
                <p>{answer}</p>
            </div>
        )}
    </div>
);
}