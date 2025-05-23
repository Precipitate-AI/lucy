// pages/admin/index.js
import Head from 'next/head';
import Link from 'next/link'; // For the link back to chat
import { useState } from 'react';

const adminStyles = `
  .admin-page-container {
    padding: 20px;
    font-family: Arial, sans-serif;
  }
  .admin-page-container h1, .admin-page-container h2 {
    color: #333;
  }
  .admin-section {
    margin-bottom: 30px;
    padding: 15px;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    background-color: #fdfdfd;
  }
  .admin-section label, .admin-section input, .admin-section select, .admin-section button {
    display: block;
    margin-bottom: 10px;
  }
  .admin-section input[type="file"] {
    border: 1px solid #ccc;
    padding: 5px;
  }
  .admin-section input[type="checkbox"] + label {
    display: inline-block;
    margin-left: 5px;
  }
  .admin-section button {
    padding: 10px 15px;
    background-color: #28a745;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
  }
  .admin-section button:disabled {
    background-color: #aaa;
  }
  .message-area {
    margin-top: 15px;
    padding: 10px;
    border-radius: 5px;
  }
  .message-success {
    background-color: #d4edda;
    color: #155724;
    border: 1px solid #c3e6cb;
  }
  .message-error {
    background-color: #f8d7da;
    color: #721c24;
    border: 1px solid #f5c6cb;
  }
  .message-info {
    background-color: #d1ecf1;
    color: #0c5460;
    border: 1px solid #bee5eb;
  }
  .home-link {
    display: inline-block;
    margin-bottom: 20px;
    color: #007bff;
    text-decoration: none;
  }
  .home-link:hover {
    text-decoration: underline;
  }
`;


export default function AdminDashboard() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [vectorizing, setVectorizing] = useState(false);
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info'); // 'info', 'success', 'error'
  
  const [currentPropertyIdForUpload, setCurrentPropertyIdForUpload] = useState('Unit4BNelayanReefApartment');
  const [currentPropertyIdForVectorize, setCurrentPropertyIdForVectorize] = useState('Unit4BNelayanReefApartment');
  const [clearBeforeVectorize, setClearBeforeVectorize] = useState(false);

  const availableProperties = [
    { id: 'Unit4BNelayanReefApartment', name: 'Nelayan Reef Apt Unit 4B' },
    { id: 'VillaSunrise', name: 'Villa Sunrise' },
    { id: 'CityLoft101', name: 'City Loft 101' },
    // Add more properties as they become available
  ];

  const displayMessage = (text, type = 'info') => {
    setMessage(text);
    setMessageType(type);
  };

  const handleFileChange = (event) => {
    setSelectedFile(event.target.files[0]);
    displayMessage(''); // Clear previous message
  };

  const handleUpload = async () => {
    if (!selectedFile || !currentPropertyIdForUpload) {
      displayMessage('Please select a file and property ID.', 'error');
      return;
    }
    setUploading(true);
    displayMessage('Uploading...', 'info');

    try {
      const res = await fetch('/api/admin/upload-doc', {
        method: 'POST',
        headers: {
          'X-Property-Id': currentPropertyIdForUpload,
          'X-Filename': selectedFile.name,
        },
        body: selectedFile,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      displayMessage(`File uploaded: ${data.blob.pathname}. URL: ${data.blob.url}`, 'success');
      setSelectedFile(null); 
      document.getElementById('file-upload-input').value = null; // Reset file input
    } catch (error) {
      displayMessage(`Upload error: ${error.message}`, 'error');
      console.error(error);
    } finally {
      setUploading(false);
    }
  };

  const handleVectorize = async () => {
    if (!currentPropertyIdForVectorize) {
        displayMessage('Please select a property ID to vectorize.', 'error');
        return;
    }
    setVectorizing(true);
    displayMessage(`Vectorizing ${currentPropertyIdForVectorize}... This might take some time.`, 'info');
    try {
      const res = await fetch('/api/admin/vectorize-property', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: currentPropertyIdForVectorize, clearFirst: clearBeforeVectorize }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Vectorization failed');
      displayMessage(data.message || 'Vectorization process completed.', 'success');
    } catch (error) {
      displayMessage(`Vectorization error: ${error.message}`, 'error');
      console.error(error);
    } finally {
      setVectorizing(false);
    }
  };

  return (
    <div className="admin-page-container">
      <Head>
        <title>Lucy Admin</title>
        <link rel="icon" href="/favicon.ico" />
        <style>{adminStyles}</style>
      </Head>
      
      <Link href="/" className="home-link">
        &larr; Back to Chat Interface
      </Link>

      <h1>Lucy Admin Dashboard</h1>
      {message && <div className={`message-area message-${messageType}`}>{message}</div>}

      <section className="admin-section">
        <h2>Upload Property Document (.txt)</h2>
        <div>
          <label htmlFor="property-select-upload">Property for Upload: </label>
          <select
            id="property-select-upload"
            value={currentPropertyIdForUpload}
            onChange={(e) => setCurrentPropertyIdForUpload(e.target.value)}
          >
            {availableProperties.map(prop => (
              <option key={prop.id} value={prop.id}>{prop.name} ({prop.id})</option>
            ))}
          </select>
        </div>
        <input id="file-upload-input" type="file" accept=".txt" onChange={handleFileChange} disabled={uploading} />
        <button onClick={handleUpload} disabled={uploading || !selectedFile}>
          {uploading ? 'Uploading...' : 'Upload TXT'}
        </button>
      </section>

      <section className="admin-section">
        <h2>Vectorize Property Documents</h2>
         <div>
          <label htmlFor="property-select-vectorize">Property to Vectorize: </label>
          <select
            id="property-select-vectorize"
            value={currentPropertyIdForVectorize}
            onChange={(e) => setCurrentPropertyIdForVectorize(e.target.value)}
          >
            {availableProperties.map(prop => (
              <option key={prop.id} value={prop.id}>{prop.name} ({prop.id})</option>
            ))}
          </select>
        </div>
        <div>
            <input
                type="checkbox"
                id="clear-vectors"
                checked={clearBeforeVectorize}
                onChange={(e) => setClearBeforeVectorize(e.target.checked)}
                disabled={vectorizing}
            />
            <label htmlFor="clear-vectors"> Clear existing vectors for this property before vectorizing (USE WITH CAUTION)</label>
        </div>
        <button onClick={handleVectorize} disabled={vectorizing || !currentPropertyIdForVectorize}>
          {vectorizing ? 'Vectorizing...' : `Vectorize ${currentPropertyIdForVectorize}`}
        </button>
      </section>
    </div>
  );
}
