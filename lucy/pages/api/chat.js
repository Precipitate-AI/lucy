// pages/api/chat.js
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai'; // For OpenRouter
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai'; // For Google Embeddings

// --- Environment Variables ---
const {
    PINECONE_API_KEY,
    PINECONE_INDEX_NAME,
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL_NAME,
    OPENROUTER_SITE_URL,
    OPENROUTER_APP_NAME,
    GOOGLE_API_KEY,
    GOOGLE_EMBEDDING_MODEL_ID,
    VERCEL_URL
} = process.env;

// --- Initialize Clients ---
let pinecone;
let pineconeIndex;
const initializePinecone = async () => {
    if (pineconeIndex) return true;
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("Chat API: Pinecone JS client initialized for index:", PINECONE_INDEX_NAME);
            return true;
        } catch (error) {
            console.error("Chat API: Pinecone JS client initialization error:", error);
            pineconeIndex = null; return false;
        }
    } else {
        console.error("Chat API: CRITICAL: Pinecone API Key or Index Name missing.");
        return false;
    }
};

let openrouterLlmClient;
if (OPENROUTER_API_KEY) {
    openrouterLlmClient = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: OPENROUTER_API_KEY,
        defaultHeaders: {
            "HTTP-Referer": OPENROUTER_SITE_URL || (VERCEL_URL ? `https://${VERCEL_URL}` : "http://localhost:3000"),
            "X-Title": OPENROUTER_APP_NAME || "LucyWebChat",
        },
    });
} else {
    console.error("Chat API: CRITICAL: OPENROUTER_API_KEY not set.");
}
const llmModelToUse = OPENROUTER_MODEL_NAME || "google/gemini-2.5-pro-preview";

let googleGenAI;
let googleEmbeddingGenAIModel;
if (GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("Chat API: Google AI JS client initialized for embeddings model:", embeddingModelId);
    } catch (error) {
        console.error("Chat API: Error initializing Google AI JS client for embeddings:", error);
        googleEmbeddingGenAIModel = null;
    }
} else {
    console.error("Chat API: CRITICAL: GOOGLE_API_KEY not set.");
}

async function getGoogleEmbeddingForQueryJS(text) {
    if (!googleEmbeddingGenAIModel) {
        console.error("Chat API: Google AI embedding model not initialized.");
        throw new Error("Embedding service (Google JS) not configured.");
    }
    try {
        // Using simple embedContent(text) which should default to query-type or be adaptable
        const result = await googleEmbeddingGenAIModel.embedContent(text);
        const embedding = result.embedding;
        if (embedding && embedding.values && Array.isArray(embedding.values)) {
            return embedding.values;
        } else {
            console.error("Chat API: Unexpected embedding format from Google AI:", JSON.stringify(result, null, 2));
            throw new Error("Failed to extract embedding values from Google AI JS response.");
        }
    } catch (error) {
        console.error("Chat API: Error getting embedding for query from Google AI:", error.message);
        throw error;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { query: userQuery, propertyId, chatHistory } = req.body; // Added chatHistory

    if (!userQuery || !propertyId) {
        return res.status(400).json({ error: 'Missing query or propertyId in request body.' });
    }

    if (!openrouterLlmClient || !googleEmbeddingGenAIModel || !PINECONE_API_KEY || !PINECONE_INDEX_NAME) {
        console.error("Chat API: One or more critical services are not initialized.");
        return res.status(503).json({ error: "Service Temporarily Unavailable: Core components not ready." });
    }
    
    await initializePinecone();
    if (!pineconeIndex) {
        console.error("Chat API: Pinecone index not available after initialization attempt.");
        return res.status(503).json({ error: "Service Temporarily Unavailable: Knowledge base connection failed." });
    }

    console.log(`Chat API: Received query for property "${propertyId}": "${userQuery}"`);

    let contextChunks = [];
    if (googleEmbeddingGenAIModel) { // Check if model is available
        try {
            const queryEmbedding = await getGoogleEmbeddingForQueryJS(userQuery);
            const queryResponse = await pineconeIndex.query({
                vector: queryEmbedding,
                topK: 3,
                filter: { propertyId: propertyId },
                includeMetadata: true,
            });

            if (queryResponse.matches && queryResponse.matches.length > 0) {
                contextChunks = queryResponse.matches.map(match => match.metadata && match.metadata.text ? match.metadata.text : "");
            }
        } catch (error) {
            console.error(`Chat API: Error during RAG for property '${propertyId}':`, error.message);
        }
    } else {
        console.warn("Chat API: Google Embedding Model not available. Proceeding without RAG context.");
    }


    const contextForLLM = contextChunks.filter(Boolean).join("\n\n---\n\n");
    const systemPrompt = `You are Lucy, a friendly and concise AI assistant for property "${propertyId}".
Answer guest questions based ONLY on the "Property Information Context" provided below.
If the answer isn't in the context, clearly state that you don't have that specific information for this property. Do not invent information.
Keep answers brief.

Property Information Context for "${propertyId}":
---
${contextForLLM || `No specific information was found in our knowledge base for property "${propertyId}" related to your query.`}
---`;

    let llmResponseText = `I'm sorry, I encountered an issue processing your request for property "${propertyId}".`;

    if (openrouterLlmClient) { // Check if client is available
        try {
            const messagesForLLM = [
                { role: "system", content: systemPrompt }
            ];
            // Add chat history if provided
            if (Array.isArray(chatHistory)) {
                chatHistory.forEach(msg => {
                    messagesForLLM.push({ role: msg.sender === 'user' ? 'user' : 'assistant', content: msg.text });
                });
            }
            messagesForLLM.push({ role: "user", content: `Guest Question (about property "${propertyId}"): "${userQuery}"` });


            const completion = await openrouterLlmClient.chat.completions.create({
                model: llmModelToUse,
                messages: messagesForLLM,
                temperature: 0.2,
                max_tokens: 300,
            });
            if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
                llmResponseText = completion.choices[0].message.content.trim();
            } else {
                console.error("Chat API: No response content from OpenRouter.");
            }
        } catch (error) {
            console.error("Chat API: Error calling OpenRouter API:", error.response ? JSON.stringify(error.response.data) : error.message);
        }
    } else {
         console.error("Chat API: OpenRouter client not initialized.");
    }

    return res.status(200).json({ response: llmResponseText });
}
