//pages/api/whatsapp_mets.js

import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';

// Environment Variables (reuse existing ones)
const {
    PINECONE_API_KEY,
    PINECONE_INDEX_NAME,
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL_NAME,
    OPENROUTER_SITE_URL,
    OPENROUTER_APP_NAME,
    GOOGLE_API_KEY,
    GOOGLE_EMBEDDING_MODEL_ID,
    VERCEL_URL,
    META_WHATSAPP_TOKEN, // Add this to your .env
    META_VERIFY_TOKEN,   // Add this to your .env
    META_PHONE_NUMBER_ID // Add this to your .env
} = process.env;

const GROUP_CHAT_TRIGGER_WORD = "@lucy";

// Initialize clients (copy from your whatsapp.js file)
let pinecone;
let pineconeIndex;
const initializePinecone = async () => {
    if (pineconeIndex) return true;
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("Meta WhatsApp API: Pinecone JS client initialized");
            return true;
        } catch (error) {
            console.error("Meta WhatsApp API: Pinecone JS client initialization error:", error);
            pineconeIndex = null;
            return false;
        }
    }
    return false;
};

// Initialize OpenRouter and Google AI (same as before)
let openrouterLlmClient;
if (OPENROUTER_API_KEY) {
    openrouterLlmClient = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: OPENROUTER_API_KEY,
        defaultHeaders: {
            "HTTP-Referer": OPENROUTER_SITE_URL || (VERCEL_URL ? `https://${VERCEL_URL}` : "http://localhost:3000"),
            "X-Title": OPENROUTER_APP_NAME || "LucyWhatsAppBot",
        },
    });
}

let googleGenAI;
let googleEmbeddingGenAIModel;
if (GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
    } catch (error) {
        console.error("Meta WhatsApp API: Error initializing Google AI:", error);
    }
}

// Copy helper functions from whatsapp.js
async function getGoogleEmbeddingForQueryJS(text) {
    // Copy from whatsapp.js
}

function createContextAwareQuery(userQuery, chatHistory) {
    // Copy from whatsapp.js
}

function cleanLLMResponse(response) {
    // Copy from whatsapp.js
}

// Send message via Meta API
async function sendWhatsAppMessage(to, text) {
    const url = `https://graph.facebook.com/v22.0/${META_PHONE_NUMBER_ID}/messages`;
    
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${META_WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: to,
                type: 'text',
                text: { body: text }
            })
        });
        
        const result = await response.json();
        if (result.error) {
            console.error('Meta WhatsApp API: Send error:', result.error);
            return false;
        }
        console.log('Meta WhatsApp API: Message sent successfully');
        return true;
    } catch (error) {
        console.error('Meta WhatsApp API: Send error:', error);
        return false;
    }
}

export default async function handler(req, res) {
    console.log("\n--- Meta WhatsApp API Request ---");
    console.log("Method:", req.method);
    
    // Handle webhook verification (GET request)
    if (req.method === 'GET') {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        
        if (mode && token) {
            if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
                console.log('Meta WhatsApp API: Webhook verified');
                return res.status(200).send(challenge);
            } else {
                return res.status(403).send('Forbidden');
            }
        }
    }
    
    // Handle incoming messages (POST request)
    if (req.method === 'POST') {
        const body = req.body;
        
        // Check if this is a WhatsApp status update
        if (body.entry && body.entry.length > 0) {
            for (const entry of body.entry) {
                const changes = entry.changes;
                if (changes && changes.length > 0) {
                    for (const change of changes) {
                        const value = change.value;
                        
                        // Check if we have messages
                        if (value.messages && value.messages.length > 0) {
                            const message = value.messages[0];
                            const fromNumber = message.from;
                            const messageText = message.text?.body || '';
                            const messageType = message.type;
                            
                            console.log(`Meta WhatsApp API: Message from ${fromNumber}: "${messageText}"`);
                            
                            // Check if it's a group message
                            const isGroupMessage = fromNumber.includes('@g.us');
                            
                            if (isGroupMessage) {
                                // Check for trigger word
                                if (!messageText.toLowerCase().startsWith(GROUP_CHAT_TRIGGER_WORD.toLowerCase())) {
                                    console.log('Meta WhatsApp API: Group message ignored (no trigger)');
                                    return res.status(200).send('OK');
                                }
                                
                                // Extract query after trigger word
                                const userQuery = messageText.substring(GROUP_CHAT_TRIGGER_WORD.length).trim();
                                if (!userQuery) {
                                    await sendWhatsAppMessage(fromNumber, `You called? What can I help you with? 😊`);
                                    return res.status(200).send('OK');
                                }
                                
                                // Process the query (similar to your existing logic)
                                await processQuery(fromNumber, userQuery, "Unit4BNelayanReefApartment");
                            } else {
                                // For 1:1 messages, let Twilio handle them
                                console.log('Meta WhatsApp API: 1:1 message - deferring to Twilio');
                            }
                        }
                    }
                }
            }
        }
        
        return res.status(200).send('OK');
    }
    
    return res.status(405).send('Method Not Allowed');
}

async function processQuery(fromNumber, userQuery, propertyId) {
    // Initialize services
    const pineconeReady = await initializePinecone();
    if (!pineconeReady) {
        await sendWhatsAppMessage(fromNumber, "I'm having trouble accessing property information right now. Please try again later.");
        return;
    }
    
    // Your existing RAG and LLM logic here
    // (Copy the relevant parts from your whatsapp.js)
    
    let llmResponseText = "I'm processing your request...";
    
    // ... (implement your existing logic)
    
    // Send response
    await sendWhatsAppMessage(fromNumber, llmResponseText);
}
