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
const TOP_K_RESULTS = 10;
const DEFAULT_PROPERTY_ID = "Unit4BNelayanReefApartment";

// Initialize OpenRouter
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
    console.log('Meta WhatsApp: OpenRouter initialized');
}

// Initialize Google AI
let googleGenAI;
let googleEmbeddingGenAIModel;
if (GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("Meta WhatsApp: Google AI initialized");
    } catch (error) {
        console.error("Meta WhatsApp: Error initializing Google AI:", error);
    }
}

// Initialize Pinecone
let pinecone;
let pineconeIndex;
const initializePinecone = async () => {
    if (pineconeIndex) return true;
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("Meta WhatsApp: Pinecone initialized");
            return true;
        } catch (error) {
            console.error("Meta WhatsApp: Pinecone initialization error:", error);
            pineconeIndex = null;
            return false;
        }
    }
    return false;
};

// Helper functions
async function getGoogleEmbeddingForQueryJS(text) {
    if (!googleEmbeddingGenAIModel || !text?.trim()) {
        console.error("Missing Google embedding model or text");
        return null;
    }
    try {
        const result = await googleEmbeddingGenAIModel.embedContent({
            content: { parts: [{ text: text }] },
            taskType: TaskType.RETRIEVAL_QUERY
        });
        return result.embedding.values;
    } catch (error) {
        console.error("Error getting Google embedding:", error);
        return null;
    }
}

function cleanLLMResponse(response) {
    return response
        .replace(/【\d+(:\d+)?】/g, '')
        .replace(/\[\d+(:\d+)?\]/g, '')
        .replace(/\(\d+(:\d+)?\)/g, '')
        .replace(/\d+\.\s*/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\*{2,}/g, '*')
        .trim();
}

// Send message via Meta API
async function sendWhatsAppMessage(to, text) {
    const url = `https://graph.facebook.com/v22.0/${META_PHONE_NUMBER_ID}/messages`;
    
    // Remove @g.us suffix if present for sending
    const recipientNumber = to.replace('@g.us', '');
    
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
                to: recipientNumber,
                type: 'text',
                text: { body: text }
            })
        });
        
        const result = await response.json();
        if (result.error) {
            console.error('Meta WhatsApp: Send error:', result.error);
            return false;
        }
        console.log('Meta WhatsApp: Message sent successfully');
        return true;
    } catch (error) {
        console.error('Meta WhatsApp: Send error:', error);
        return false;
    }
}

// Process the query with RAG
async function processQuery(fromNumber, userQuery, propertyId) {
    try {
        // Initialize services
        const pineconeReady = await initializePinecone();
        if (!pineconeReady) {
            await sendWhatsAppMessage(fromNumber, "I'm having trouble accessing property information right now. Please try again later.");
            return;
        }
        
        // Generate embedding for the query
        const embedding = await getGoogleEmbeddingForQueryJS(userQuery);
        if (!embedding) {
            await sendWhatsAppMessage(fromNumber, "Sorry, I'm having trouble processing your question. Please try again.");
            return;
        }
        
        // Query Pinecone
        const queryResponse = await pineconeIndex.namespace(propertyId).query({
            vector: embedding,
            topK: TOP_K_RESULTS,
            includeMetadata: true
        });
        
        // Extract context from results
        const contexts = [];
        for (const match of queryResponse.matches) {
            const content = match.metadata?.content || match.metadata?.text || '';
            if (content && match.score > 0.5) {
                contexts.push(content);
            }
        }
        
        if (contexts.length === 0) {
            await sendWhatsAppMessage(fromNumber, "I couldn't find specific information about that. Could you please rephrase your question?");
            return;
        }
        
        const context = contexts.join('\n\n');
        
        // Prepare LLM prompt
        const systemPrompt = `You are Lucy, a helpful AI assistant for property inquiries. 
        You're responding in a WhatsApp group chat where you were mentioned.
        Be friendly, concise, and helpful. Keep responses under 300 words.
        Only answer based on the provided context. If information isn't in the context, say so politely.`;
        
        const userPrompt = `Context about the property:\n${context}\n\nQuestion: ${userQuery}`;
        
        // Get LLM response
        const completion = await openrouterLlmClient.chat.completions.create({
            model: OPENROUTER_MODEL_NAME || "meta-llama/llama-3-8b-instruct",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            max_tokens: 500,
            temperature: 0.7
        });
        
        let response = completion.choices[0]?.message?.content || "I couldn't generate a response. Please try again.";
        
        // Clean and send response
        await sendWhatsAppMessage(fromNumber, cleanLLMResponse(response));
        
    } catch (error) {
        console.error("Meta WhatsApp: Error processing query:", error);
        await sendWhatsAppMessage(fromNumber, "Sorry, I encountered an error processing your question. Please try again later.");
    }
}

// Main webhook handler
export default async function handler(req, res) {
    console.log("\n--- Meta WhatsApp API Request ---");
    console.log("Method:", req.method);
    console.log("Headers:", req.headers);
    
    // Handle webhook verification (GET request)
    if (req.method === 'GET') {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        
        console.log('Webhook verification attempt:', { mode, token, challenge });
        
        if (mode && token) {
            if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
                console.log('Meta WhatsApp: Webhook verified successfully');
                return res.status(200).send(challenge);
            } else {
                console.log('Meta WhatsApp: Webhook verification failed - token mismatch');
                return res.status(403).send('Forbidden');
            }
        }
        return res.status(400).send('Bad Request');
    }
    
    // Handle incoming messages (POST request)
    if (req.method === 'POST') {
        const body = req.body;
        console.log('Incoming webhook body:', JSON.stringify(body, null, 2));
        
        // Check if this is a WhatsApp message
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
                            
                            console.log(`Meta WhatsApp: Message from ${fromNumber}: "${messageText}"`);
                            
                            // Check if it's a group message
                            const isGroupMessage = fromNumber.includes('@g.us') || 
                                                 value.contacts?.[0]?.wa_id !== fromNumber;
                            
                            if (isGroupMessage) {
                                console.log('Meta WhatsApp: Group message detected');
                                
                                // Check for trigger word
                                if (!messageText.toLowerCase().includes(GROUP_CHAT_TRIGGER_WORD.toLowerCase())) {
                                    console.log('Meta WhatsApp: Group message ignored (no trigger)');
                                    return res.status(200).send('OK');
                                }
                                
                                // Extract query after trigger word
                                const match = messageText.match(new RegExp(`${GROUP_CHAT_TRIGGER_WORD}\\s+(.+)`, 'i'));
                                if (!match || !match[1]) {
                                    await sendWhatsAppMessage(fromNumber, "You called? What can I help you with? 😊");
                                    return res.status(200).send('OK');
                                }
                                
                                const userQuery = match[1].trim();
                                console.log('Meta WhatsApp: Processing query:', userQuery);
                                
                                // Process the query
                                await processQuery(fromNumber, userQuery, DEFAULT_PROPERTY_ID);
                                
                            } else {
                                // 1:1 message - also process it
                                console.log('Meta WhatsApp: 1:1 message');
                                await processQuery(fromNumber, messageText, DEFAULT_PROPERTY_ID);
                            }
                        }
                        
                        // Handle status updates
                        if (value.statuses && value.statuses.length > 0) {
                            const status = value.statuses[0];
                            console.log('Meta WhatsApp: Status update:', status);
                        }
                    }
                }
            }
        }
        
        return res.status(200).send('OK');
    }
    
    return res.status(405).json({ error: 'Method Not Allowed' });
}
