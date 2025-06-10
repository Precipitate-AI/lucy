import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function Home() {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [propertyId, setPropertyId] = useState('Casa_Nalani'); // Default property
  const [isBotTyping, setIsBotTyping] = useState(false); // For typing indicator

  const messagesEndRef = useRef(null); // For auto-scrolling

  // Property mapping for display names
  const propertyOptions = [
    { id: 'Casa_Nalani', name: 'Casa Nalani' },
    { id: 'Unit_1B_Nelayan_Reef_Apartment', name: 'Unit 1B Nelayan Reef Apartment' },
    { id: 'Unit_4B_Nelayan_Reef_Apartment', name: 'Unit 4B Nelayan Reef Apartment' },
    { id: 'Villa_Breeze', name: 'Villa Breeze' },
    { id: 'Villa_Loka', name: 'Villa Loka' },
    { id: 'Villa_Timur', name: 'Villa Timur' },
  ];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isBotTyping]); // Scroll when messages or typing status changes

  const handleInputChange = (e) => {
    setQuery(e.target.value);
  };

  const handlePropertyChange = (e) => {
    setPropertyId(e.target.value);
    setMessages([]); // Clear messages when property changes
    setQuery(''); // Clear query input
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    const userMessage = { sender: 'user', text: query };
    setMessages(prevMessages => [...prevMessages, userMessage]);
    
    const currentQuery = query; // Store query as it will be cleared
    setQuery('');
    setIsBotTyping(true); // Bot starts "typing"
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: currentQuery, propertyId, chatHistory: messages.slice(-6) }),
      });

      setIsBotTyping(false); // Bot stops "typing"

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const botMessage = { sender: 'bot', text: data.response };
      setMessages(prevMessages => [...prevMessages, botMessage]);

    } catch (error) {
      console.error("Error fetching chat response:", error);
      const errorMessage = { sender: 'bot', text: `Sorry, I encountered an error: ${error.message}` };
      setMessages(prevMessages => [...prevMessages, errorMessage]);
      setIsBotTyping(false);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Lucy - Your AI Assistant</title>
        <meta name="description" content="AI Assistant for your property" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="flex flex-col h-screen bg-gray-100">
        {/* Header */}
        <header className="bg-indigo-600 text-white p-4 shadow-md">
          <h1 className="text-2xl font-semibold text-center">Lucy AI Assistant</h1>
          <div className="mt-2 text-center">
            <label htmlFor="propertySelect" className="mr-2 text-sm">Property:</label>
            <select
              id="propertySelect"
              value={propertyId}
              onChange={handlePropertyChange}
              className="p-1 rounded text-gray-800 text-sm bg-indigo-100 border-indigo-300 focus:ring-indigo-500 focus:border-indigo-500"
            >
              {propertyOptions.map(property => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </div>
        </header>

        {/* Chat Messages Area */}
        <main className="flex-grow p-4 overflow-y-auto space-y-2 bg-white shadow-inner">
          {messages.map((msg, index) => (
            <div
              key={index}
              className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-xl lg:max-w-2xl px-4 py-2 rounded-2xl shadow-md ${
                  msg.sender === 'user'
                    ? 'bg-indigo-500 text-white rounded-br-none'
                    : 'bg-gray-200 text-gray-800 rounded-bl-none prose prose-sm max-w-none'
                }`}
              >
                {msg.sender === 'bot' ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.text}
                  </ReactMarkdown>
                ) : (
                  msg.text
                )}
              </div>
            </div>
          ))}
          {isBotTyping && (
            <div className="flex justify-start">
                <div className="px-4 py-2 rounded-2xl shadow-md bg-gray-200 text-gray-600 rounded-bl-none italic">
                    Lucy is typing...
                </div>
            </div>
          )}
          <div ref={messagesEndRef} /> {/* Anchor for scrolling */}
        </main>

        {/* Input Area */}
        <footer className="bg-gray-50 p-3 border-t border-gray-300 shadow-md">
          <form onSubmit={handleSubmit} className="flex items-center space-x-2">
            <input
              type="text"
              value={query}
              onChange={handleInputChange}
              placeholder="Ask Lucy anything..."
              className="flex-grow p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-shadow"
              disabled={isLoading}
            />
            <button
              type="submit"
              className="px-6 py-3 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 transition-colors"
              disabled={isLoading}
            >
              {isLoading ? 'Sending...' : 'Send'}
            </button>
          </form>
        </footer>
      </div>
    </>
  );
}
