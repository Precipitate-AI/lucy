// pages/index.js
import Head from 'next/head';
import { useState, useEffect, useRef } from 'react';

// Simple CSS for chat bubbles
const styles = `
  .page-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 20px;
    font-family: Arial, sans-serif;
    min-height: 100vh;
  }
  .admin-link {
    position: absolute;
    top: 10px;
    right: 10px;
    padding: 8px 12px;
    background-color: #f0f0f0;
    border: 1px solid #ccc;
    border-radius: 5px;
    text-decoration: none;
    color: #333;
  }
  .chat-wrapper {
    width: 100%;
    max-width: 700px;
    margin-top: 20px; /* Space for admin link */
  }
  .chat-container {
    border: 1px solid #ccc;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    height: 70vh; /* Or adjust as needed */
    background-color: #f9f9f9;
  }
  .messages-list {
    flex-grow: 1;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
  }
  .message-bubble {
    padding: 8px 12px;
    border-radius: 18px;
    margin-bottom: 8px;
    max-width: 70%;
    word-wrap: break-word;
    line-height: 1.4;
  }
  .user-message {
    background-color: #007bff;
    color: white;
    align-self: flex-end;
  }
  .bot-message {
    background-color: #e9e9eb;
    color: black;
    align-self: flex-start;
  }
  .chat-input-form {
    display: flex;
    padding: 10px;
    border-top: 1px solid #ccc;
  }
  .chat-input-form input[type="text"] {
    flex-grow: 1;
    padding: 10px;
    border: 1px solid #ddd;
    border-radius: 20px;
    margin-right: 10px;
  }
  .chat-input-form button {
    padding: 10px 15px;
    background-color: #007bff;
    color: white;
    border: none;
    border-radius: 20px;
    cursor: pointer;
  }
  .chat-input-form button:disabled {
    background-color: #aaa;
  }
  .property-selector-container {
    margin-bottom: 15px;
    display: flex;
    align-items: center;
  }
  .property-selector-container label {
    margin-right: 10px;
  }
  .property-selector {
    padding: 10px;
    border-radius: 5px;
    border: 1px solid #ccc;
  }
  .loading-indicator {
    align-self: flex-start;
    color: #777;
    font-style: italic;
    padding: 8px 12px;
  }
`;

export default function ChatPage() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [currentPropertyId, setCurrentPropertyId] = useState('Unit4BNelayanReefApartment');
  const messagesEndRef = useRef(null);

  const availableProperties = [
    { id: 'Unit4BNelayanReefApartment', name: 'Nelayan Reef Apt Unit 4B' },
    { id: 'VillaSunrise', name: 'Villa Sunrise' },
    { id: 'CityLoft101', name: 'City Loft 101' },
    // Add more properties as they are known/managed
  ];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(scrollToBottom, [messages]);

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const newUserMessage = { sender: 'user', text: input };
    const currentMessages = [...messages, newUserMessage];
    setMessages(currentMessages);
    setInput('');
    setIsLoading(true);

    try {
      // Send last N messages as history (e.g., last 5 pairs / 10 messages) for context
      const historyForAPI = currentMessages.slice(-10).map(m => ({ sender: m.sender, text: m.text }));


      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: input, propertyId: currentPropertyId, chatHistory: historyForAPI.slice(0, -1) }), // Don't send current query in history
      });

      // Remove temporary "thinking..." message if you added one
      // setMessages(prev => prev.filter(msg => msg.sender !== 'bot-loading'));

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to get response');
      }

      const data = await res.json();
      setMessages(prev => [...prev, { sender: 'bot', text: data.response }]);
    } catch (error) {
      console.error("Chat error:", error);
      setMessages(prev => [...prev, { sender: 'bot', text: `Error: ${error.message}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="page-container">
      <Head>
        <title>Lucy Chat Test</title>
        <meta name="description" content="Test Lucy Bot Responses" />
        <link rel="icon" href="/favicon.ico" />
        <style>{styles}</style>
      </Head>

      <a href="/admin" className="admin-link">Admin Panel</a>

      <h1>Lucy Chat Tester</h1>
      
      <div className="chat-wrapper">
        <div className="property-selector-container">
          <label htmlFor="property-select">Select Property: </label>
          <select
            id="property-select"
            className="property-selector"
            value={currentPropertyId}
            onChange={(e) => {
                setCurrentPropertyId(e.target.value);
                setMessages([]); // Clear messages when property changes
            }}
          >
            {availableProperties.map(prop => (
              <option key={prop.id} value={prop.id}>{prop.name} ({prop.id})</option>
            ))}
          </select>
        </div>
        
        <div className="chat-container">
          <div className="messages-list">
            {messages.map((msg, index) => (
              <div key={index} className={`message-bubble ${msg.sender === 'user' ? 'user-message' : 'bot-message'}`}>
                {msg.text}
              </div>
            ))}
            {isLoading && <div className="loading-indicator message-bubble bot-message">Lucy is thinking...</div>}
            <div ref={messagesEndRef} />
          </div>
          <form onSubmit={handleSendMessage} className="chat-input-form">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Chat about ${availableProperties.find(p=>p.id === currentPropertyId)?.name || 'selected property'}...`}
              disabled={isLoading}
            />
            <button type="submit" disabled={isLoading}>
              {isLoading ? '...' : 'Send'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
