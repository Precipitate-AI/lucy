// pages/api/webhook.js
import { Twilio } from 'twilio';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai'; // For OpenRouter (Gemini LLM)
import { GoogleGenerativeAI, TaskType, HarmCategory, HarmBlockThreshold } from '@google/generative-ai'; // For Google Embeddings

// --- Initialize Clients ---
// Twilio
const twilioClient = new Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_SENDER;

// Pinecone
let pinecone = null;
let pineconeIndex = null;
const initializePinecone = async () => {
    if (!pinecone && process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_NAME) {
        try {
            pinecone = new Pinecone({
                apiKey: process.env.PINECONE_API_KEY,
            });
            pineconeIndex = pinecone.index(process.env.PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats(); // Test connection
            console.log("Pinecone client initialized and connected to index:", process.env.PINECONE_INDEX_NAME);
        } catch (error) {
            console.error("Pinecone initialization error:", error);
            pineconeIndex = null; // Ensure it's null if init fails
        }
    } else if (!pineconeIndex && process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_NAME) {
        // This case might occur if previous init failed and is retried
        console.warn("Pinecone client not initialized, attempting re-initialization.");
         try {
            pinecone = new Pinecone({apiKey: process.env.PINECONE_API_KEY,});
            pineconeIndex = pinecone.index(process.env.PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("Pinecone client re-initialized successfully.");
        } catch (error) {
            console.error("Pinecone re-initialization error:", error);
            pineconeIndex = null;
        }
    }
     else if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME) {
        console.error("Pinecone API key or Index Name missing. Pinecone not initialized.");
    }
};

// OpenRouter (for LLM - Gemini Pro)
let openrouterLlmClient = null;
if (process.env.OPENROUTER_API_KEY) {
    openrouterLlmClient = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        defaultHeaders: {
            "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost:3000", // sensible default
            "X-Title": process.env.OPENROUTER_APP_NAME || "LucyBot", // sensible default
        },
    });
} else {
    console.error("OPENROUTER_API_KEY not set. LLM calls will fail.");
}
const openRouterGeminiModel = process.env.OPENROUTER_GEMINI_MODEL || "google/gemini-1.5-pro-latest";


// Google AI (for Embeddings)
let googleGenAI = null;
let googleEmbeddingGenAIModel = null;
if (process.env.GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
        const embeddingModelId = process.env.GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("Google AI client initialized for embeddings with model:", embeddingModelId);
    } catch (error) {
        console.error("Error initializing Google AI client for embeddings:", error);
        googleEmbeddingGenAIModel = null;
    }
} else {
    console.error("GOOGLE_API_KEY not set. Embedding generation will fail.");
}

// Safety settings for Google Generative AI (LLM part, if used directly, not OpenRouter)
// For embeddings, safety isn't usually an issue, but for content generation it is.
const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];


// --- Helper Functions ---
async function getGoogleEmbeddingForQuery(text) {
    if (!googleEmbeddingGenAIModel) {
        console.error("Google AI embedding model not initialized. Cannot get embedding.");
        throw new Error("Embedding service (Google) not configured.");
    }
    try {
        // For query, use "RETRIEVAL_QUERY" task type
        const result = await googleEmbeddingGenAIModel.embedContent(
             text, // Direct string for single text
             TaskType.RETRIEVAL_QUERY // Specify task type for query
        );
        const embedding = result.embedding; // This is { values: [...] }
        if (embedding && embedding.values && Array.isArray(embedding.values)) {
            return embedding.values;
        } else {
            console.error("Unexpected embedding format from Google AI:", JSON.stringify(result, null, 2));
            throw new Error("Failed to extract embedding values from Google AI response.");
        }
    } catch (error) {
        console.error("Error getting embedding for query from Google AI:", error.message);
        if (error.cause) console.error("Cause:", error.cause);
        throw error;
    }
}


function extractPropertyId(twilioRequestBody, userMessage) {
    const groupJidToPropertyIdMap = {
        // "whatsapp:+12345EXAMPLE@g.us": "AlphaVista", // Example: Replace with REAL JID
    };

    const fromField = twilioRequestBody.From; // e.g., "whatsapp:+123456789012@g.us" OR "whatsapp:+14155238886"

    if (fromField && fromField.endsWith('@g.us')) { // Message from a group
        const propertyId = groupJidToPropertyIdMap[fromField];
        if (propertyId) {
            console.log(`Extracted propertyId '${propertyId}' from mapped group JID '${fromField}'`);
            return propertyId;
        } else {
            console.warn(`Unmapped group JID: ${fromField}. Trying message body parsing.`);
        }
    }

    if (userMessage) {
        const messageMatch = userMessage.match(/(?:Property_|\bproperty\s+)([a-zA-Z0-9_-]+)|info(?: for| about)?\s+([a-zA-Z0-9_-]+)(?:\s+property)?/i);
        if (messageMatch) {
            const extractedId = messageMatch[1] || messageMatch[2];
            if (extractedId) {
                console.log(`Extracted propertyId '${extractedId}' from message body.`);
                return extractedId;
            }
        }
    }
    
    console.warn("Could not determine Property ID for message:", userMessage, "from:", fromField);
    return null;
}


// --- Main Handler ---
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        console.log("Received non-POST request");
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!googleEmbeddingGenAIModel || !openrouterLlmClient) {
        console.error("A critical client (Google AI Embeddings or OpenRouter LLM) is not initialized. Check API keys & server logs.");
        return res.status(500).json({ error: "Lucy's brain is not fully configured. Please contact support." });
    }

    await initializePinecone(); // Ensure Pinecone is ready
    if (!pineconeIndex) {
         console.error("Pinecone index not available. Cannot proceed.");
         return res.status(500).json({ error: "Lucy cannot access property information store. Please contact support." });
    }

    const incomingMsg = req.body.Body;
    const from = req.body.From;
    const to = req.body.To;

    console.log(`Received message: "${incomingMsg}" from: ${from} to: ${to}`);

    const propertyId = extractPropertyId(req.body, incomingMsg);

    if (!propertyId) {
        const replyBody = "I'm Lucy! To help you, I need to know which property you're asking about. Please ensure I'm in a group chat for the property, or mention the property ID (e.g., 'wifi for Property_BeachHouse').";
        try {
            if (twilioClient && twilioWhatsAppNumber && from) {
                await twilioClient.messages.create({ to: from, from: twilioWhatsAppNumber, body: replyBody });
                console.log("Sent clarification request for property ID.");
            } else {
                console.error("Twilio client misconfigured, cannot send clarification.");
            }
            return res.status(200).send('Replied with property clarification request.');
        } catch (error) {
            console.error("Twilio error sending clarification:", error.message);
            return res.status(500).json({ error: 'Failed to send clarification message' });
        }
    }
    console.log(`Handling request for Property ID: ${propertyId}`);

    let context = "";
    const queryTopK = 3; // Number of relevant chunks to retrieve
    try {
        const queryEmbedding = await getGoogleEmbeddingForQuery(incomingMsg);
        console.log(`Querying Pinecone for property '${propertyId}' with topK=${queryTopK}.`);
        const queryResponse = await pineconeIndex.query({
            topK: queryTopK,
            vector: queryEmbedding,
            filter: { propertyId: propertyId },
            includeMetadata: true,
        });

        if (queryResponse.matches && queryResponse.matches.length > 0) {
            context = queryResponse.matches.map(match => match.metadata.text).join("\n\n---\n\n");
            console.log(`Retrieved ${queryResponse.matches.length} context chunks for '${propertyId}'. First chunk (preview): ${queryResponse.matches[0].metadata.text.substring(0,100)}...`);
        } else {
            console.log(`No specific context found in Pinecone for property '${propertyId}' and query: "${incomingMsg.substring(0,50)}"`);
        }
    } catch (error) {
        console.error(`Error during embedding or Pinecone query for property '${propertyId}':`, error.message);
    }

    let botResponse = `I'm sorry, I couldn't find specific information for "${propertyId}" regarding your question. You might want to contact the property manager for assistance.`; // Default
    try {
        const systemPrompt = `You are Lucy, a friendly and helpful AI assistant for guests at the rental property named "${propertyId}".
Your primary goal is to answer guest questions accurately using ONLY the information provided in the "Property Information Context" section below.
If the context does not contain the answer for property "${propertyId}", clearly state that you don't have that specific detail and suggest contacting the property manager.
Do NOT invent information or use external knowledge for property-specific questions. Be concise and polite.
If the context section is empty or explicitly states "No specific information was found...", reflect that directly in your answer.

Property Information Context for "${propertyId}":
---
${context || `No specific information was found in our knowledge base for property "${propertyId}" related to your query.`}
---`;

        const userPrompt = `Guest's Question (about property "${propertyId}"): "${incomingMsg}"`;

        console.log(`Sending prompt to OpenRouter (${openRouterGeminiModel}). Context length: ${context.length} chars.`);
        const completion = await openrouterLlmClient.chat.completions.create({
            model: openRouterGeminiModel,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.3,
            max_tokens: 500,
        });
        
        if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
            botResponse = completion.choices[0].message.content.trim();
        } else {
            console.error("No response content from OpenRouter/Gemini:", JSON.stringify(completion, null, 2));
            botResponse = `I apologize, I had a little trouble thinking about that for property "${propertyId}". Could you try rephrasing your question?`;
        }
    } catch (error) {
        console.error("Error calling OpenRouter/Gemini API:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message, error.stack);
        botResponse = `There was an issue contacting my brain for property "${propertyId}". Please try again in a moment. If the problem persists, please let the property manager know.`;
    }

    try {
        if (twilioClient && twilioWhatsAppNumber && from) {
            await twilioClient.messages.create({ to: from, from: twilioWhatsAppNumber, body: botResponse });
            console.log(`Sent final response to ${from}: "${botResponse.substring(0,100)}..."`);
        } else {
            console.error("Twilio client misconfigured, cannot send final response.");
        }
        return res.status(200).send('Message processed and reply sent.');
    } catch (error) {
        console.error("Error sending Twilio message:", error.message, error.code, error.moreInfo);
        return res.status(500).json({ error: 'Failed to send message via Twilio' });
    }
}
