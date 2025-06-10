// pages/api/whatsapp_meta.js
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';

// Environment Variables
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
    META_WHATSAPP_TOKEN,
    META_VERIFY_TOKEN,
    META_PHONE_NUMBER_ID
} = process.env;

const GROUP_CHAT_TRIGGER_WORD = "@lucy";

// Helper function to get readable property name
function getReadablePropertyName(propertyId) {
    const propertyMap = {
        'Casa_Nalani': 'Casa Nalani',
        'Unit_1B_Nelayan_Reef_Apartment_copy': 'Unit 1B Nelayan Reef Apartment',
        'Unit_4B_Nelayan_Reef_Apartment': 'Unit 4B Nelayan Reef Apartment',
        'Villa_Breeze': 'Villa Breeze',
        'Villa_Loka': 'Villa Loka',
        'Villa_Timur': 'Villa Timur',
    };
    return propertyMap[propertyId] || propertyId.replace(/_/g, ' ');
}

// Initialize clients (same as in chat.js)
let pinecone;
let pineconeIndex;
const initializePinecone = async () => {
    if (pineconeIndex) return true;
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("WhatsApp API: Pinecone initialized");
            return true;
        } catch (error) {
            console.error("WhatsApp API: Pinecone initialization error:", error);
            pineconeIndex = null;
            return false;
        }
    }
    return false;
};

let openrouterLlmClient;
if (OPENROUTER_API_KEY) {
    openrouterLlmClient = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: OPENROUTER_API_KEY,
        defaultHeaders: {
            "HTTP-Referer": OPENROUTER_SITE_URL || (VERCEL_URL ? `https://${VERCEL_URL}` : "http://localhost:3000"),
            "X-Title": OPENROUTER_APP_NAME || "LucyWhatsApp",
        },
    });
}

const llmModelToUse = OPENROUTER_MODEL_NAME || "google/gemini-flash-2.5-preview-05-20";

let googleGenAI;
let googleEmbeddingGenAIModel;
if (GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("WhatsApp API: Google AI initialized");
    } catch (error) {
        console.error("WhatsApp API: Error initializing Google AI:", error);
    }
}

// Use the same embeddings and cleaning functions from chat.js
async function getGoogleEmbeddingForQueryJS(text) {
    if (!googleEmbeddingGenAIModel) {
        console.error("WhatsApp API: Google AI embedding model not initialized.");
        throw new Error("Embedding service (Google JS) not configured.");
    }
    try {
        const result = await googleEmbeddingGenAIModel.embedContent({
            content: { parts: [{ text: text }] },
            taskType: TaskType.RETRIEVAL_QUERY
        });
        const embedding = result.embedding;
        if (embedding && embedding.values && Array.isArray(embedding.values)) {
            return embedding.values;
        } else {
            if (Array.isArray(embedding) && embedding.every(v => typeof v === 'number')) return embedding;
            throw new Error("Failed to extract embedding values from Google AI JS response.");
        }
    } catch (error) {
        console.error("WhatsApp API: Error getting embedding for query:", error.message);
        throw error;
    }
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
            console.error('WhatsApp API: Send error:', result.error);
            return false;
        }
        return true;
    } catch (error) {
        console.error('WhatsApp API: Send error:', error);
        return false;
    }
}

// Process query (similar to chat.js logic)
async function processQuery(fromNumber, userQuery, propertyId = 'Casa_Nalani') {
    try {
        await initializePinecone();
        
        // Get context from Pinecone (same as chat.js)
        let contextChunks = [];
        let hasPropertyContextForLLM = false;
        
        if (googleEmbeddingGenAIModel && pineconeIndex) {
            try {
                const queryEmbedding = await getGoogleEmbeddingForQueryJS(userQuery);
                
                const queryResponse = await pineconeIndex.query({
                    vector: queryEmbedding,
                    topK: 5,
                    filter: { propertyId: propertyId },
                    includeMetadata: true,
                });

                if (queryResponse.matches && queryResponse.matches.length > 0) {
                    contextChunks = queryResponse.matches
                        .map(match => match.metadata && match.metadata.text ? match.metadata.text.trim() : "")
                        .filter(Boolean);
                    if (contextChunks.length > 0) {
                        hasPropertyContextForLLM = true;
                    }
                }
            } catch (error) {
                console.error(`WhatsApp API: Error during RAG:`, error.message);
            }
        }
        
        const contextForLLM = hasPropertyContextForLLM ? contextChunks.join("\n\n---\n\n") : "No specific property information was retrieved for this query.";
        const readablePropertyName = getReadablePropertyName(propertyId);
        
        // Use similar system prompt but adapted for WhatsApp
        const systemPrompt = `You are Lucy, a remarkably charming, kind, and warm AI assistant. You have years of experience living in and exploring Bali, making you a true local expert. You are currently assisting a guest at property "${readablePropertyName}". Your goal is to be exceptionally helpful and make their stay wonderful.

The guest's current question is: "${userQuery}"

Your primary task is to determine the NATURE of the guest's question and respond accordingly:

TYPE 1: PROPERTY-SPECIFIC QUESTION
- This is a question directly about property "${readablePropertyName}".
- IF the question is Type 1:
   1. You HAVE BEEN PROVIDED with the following "Property Information Context" for "${readablePropertyName}":
   ---
   ${contextForLLM}
   ---
   2. Answer USING ONLY information found within this "Property Information Context".
   3. If the context DOES NOT contain the answer, state: "I'm sorry, I'm unsure about that. You might need to ask one of my human teammates for more help here."

TYPE 2: GENERAL BALI/LOCATION QUESTION
- This is a question about Bali or specific areas within Bali.
- Answer using your general knowledge as a helpful Bali expert.

TYPE 3: OTHER GENERAL KNOWLEDGE QUESTION
- Answer using your general knowledge.

CRITICAL:
- Keep responses concise for WhatsApp (under 300 words).
- Use emoji sparingly but warmly 😊
- Break long responses into paragraphs for readability.
- PROVIDE ONLY THE FINAL ANSWER, not your reasoning process.`;

        // Get LLM response
        const completion = await openrouterLlmClient.chat.completions.create({
            model: llmModelToUse,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userQuery }
            ],
            temperature: 0.3,
            max_tokens: 400,
        });
        
        const response = completion.choices[0]?.message?.content || "I'm sorry, I couldn't process that. Please try again.";
        
        // Send response
        await sendWhatsAppMessage(fromNumber, response);
        
    } catch (error) {
        console.error("WhatsApp API: Error processing query:", error);
        await sendWhatsAppMessage(fromNumber, "Sorry, I encountered an error. Please try again later. 🙏");
    }
}

// Main webhook handler
export default async function handler(req, res) {
    console.log("\n--- WhatsApp Webhook Request ---");
    console.log("Method:", req.method);
    
    // Handle webhook verification
    if (req.method === 'GET') {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        
        if (mode && token) {
            if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
                console.log('WhatsApp: Webhook verified successfully');
                return res.status(200).send(challenge);
            } else {
                return res.status(403).send('Forbidden');
            }
        }
        return res.status(400).send('Bad Request');
    }
    
    // Handle incoming messages
    if (req.method === 'POST') {
        const body = req.body;
        
        if (body.entry && body.entry.length > 0) {
            for (const entry of body.entry) {
                const changes = entry.changes;
                if (changes && changes.length > 0) {
                    for (const change of changes) {
                        const value = change.value;
                        
                        if (value.messages && value.messages.length > 0) {
                            const message = value.messages[0];
                            const fromNumber = message.from;
                            const messageText = message.text?.body || '';
                            const messageType = message.type;
                            
                            // Only process text messages
                            if (messageType !== 'text') {
                                continue;
                            }
                            
                            console.log(`WhatsApp: Message from ${fromNumber}: "${messageText}"`);
                            
                            // Check if it's a group message by looking for trigger word
                            const isGroupTrigger = messageText.toLowerCase().includes(GROUP_CHAT_TRIGGER_WORD.toLowerCase());
                            
                            if (isGroupTrigger) {
                                // Extract query after trigger word
                                const match = messageText.match(new RegExp(`${GROUP_CHAT_TRIGGER_WORD}\\s+(.+)`, 'i'));
                                if (!match || !match[1]) {
                                    await sendWhatsAppMessage(fromNumber, "Hi! How can I help you today? 😊");
                                    return res.status(200).send('OK');
                                }
                                
                                const userQuery = match[1].trim();
                                await processQuery(fromNumber, userQuery);
                            } else {
                                // For 1:1 chats, process all messages
                                await processQuery(fromNumber, messageText);
                            }
                        }
                    }
                }
            }
        }
        
        return res.status(200).send('OK');
    }
    
    return res.status(405).json({ error: 'Method Not Allowed' });
}
