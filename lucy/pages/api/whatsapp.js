// pages/api/whatsapp.js
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import twilio from 'twilio';

// Environment Variables
const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    MESSAGING_SERVICE_SID,
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

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Constants
const GROUP_CHAT_TRIGGER_WORD = "@lucy";
const TOP_K_RESULTS = 10;
const DEFAULT_PROPERTY_ID = "Unit4BNelayanReefApartment";

// Initialize OpenRouter client
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
    console.log('OpenRouter LLM Client initialized with model: ', OPENROUTER_MODEL_NAME || 'default model');
}

// Initialize Google AI
let googleGenAI;
let googleEmbeddingGenAIModel;
if (GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("Google AI client initialized successfully.");
    } catch (error) {
        console.error("Error initializing Google AI:", error);
    }
}

// Initialize Pinecone
let pinecone;
let pineconeIndex;
const initializePinecone = async () => {
    if (pineconeIndex) return true;
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) {
                pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            }
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("Pinecone JS client initialized successfully.");
            return true;
        } catch (error) {
            console.error("Pinecone JS client initialization error:", error);
            pineconeIndex = null;
            return false;
        }
    }
    console.warn("Pinecone JS client initialization skipped. Missing API key or index name.");
    return false;
};

// Helper Functions
async function getGoogleEmbeddingForQueryJS(text) {
    if (!googleEmbeddingGenAIModel || !text?.trim()) {
        console.error("Missing Google embedding model or text");
        return null;
    }
    try {
        const result = await googleEmbeddingGenAIModel.embedContent(text);
        return result.embedding.values;
    } catch (error) {
        console.error("Error getting Google embedding:", error);
        return null;
    }
}

const removeSourceNumbers = (text) => {
    return text
        .replace(/【\d+(:\d+)?】/g, '')
        .replace(/\[\d+(:\d+)?\]/g, '')
        .replace(/\(\d+(:\d+)?\)/g, '')
        .replace(/\d+\.\s*/g, '')
        .trim();
};

function cleanLLMResponse(response) {
    return removeSourceNumbers(response)
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\*{2,}/g, '*')
        .trim();
}

function createContextAwareQuery(userQuery, chatHistory) {
    const contextRelevantQueries = [];
    
    // Original user query
    contextRelevantQueries.push({ 
        query: userQuery, 
        weight: 1.0 
    });
    
    // Recent messages for context
    const recentMessages = chatHistory.slice(-3);
    if (recentMessages.length > 0) {
        const recentContext = recentMessages
            .map(entry => `${entry.role}: ${entry.content}`)
            .join('\n');
        contextRelevantQueries.push({ 
            query: recentContext, 
            weight: 0.3 
        });
    }
    
    // If query is very short, add expanded version
    if (userQuery.split(' ').length <= 3) {
        contextRelevantQueries.push({ 
            query: `${userQuery} details information`, 
            weight: 0.2 
        });
    }
    
    return contextRelevantQueries;
}

// Main webhook handler
export default async function handler(req, res) {
    console.log("\n--- WhatsApp API Request ---");
    console.log("Method:", req.method);
    
    if (req.method === 'POST') {
        const { 
            From, 
            Body, 
            To, 
            MessageSid,
            NumMedia,
            MessagingServiceSid 
        } = req.body;
        
        console.log("Message details:", {
            From,
            To,
            Body: Body?.substring(0, 100),
            MessagingServiceSid
        });
        
        // Check if it's a group message
        const isGroupMessage = From && (
            From.includes('-') || 
            From.length > 30 ||
            From.includes('@g.us') ||
            From.includes('group')
        );
        
        if (isGroupMessage) {
            console.log("GROUP MESSAGE DETECTED");
            
            // Check for @lucy mention
            if (!Body || !Body.toLowerCase().includes(GROUP_CHAT_TRIGGER_WORD.toLowerCase())) {
                console.log("Group message without @lucy, ignoring");
                return res.status(200).send('OK');
            }
            
            // Extract the query after @lucy
            const match = Body.match(new RegExp(`${GROUP_CHAT_TRIGGER_WORD}\\s+(.+)`, 'i'));
            if (!match || !match[1]) {
                // Someone just said @lucy without a question
                await twilioClient.messages.create({
                    body: "You called? Ask me anything about the property! 😊",
                    from: To,
                    to: From,
                    messagingServiceSid: MESSAGING_SERVICE_SID
                });
                return res.status(200).send('OK');
            }
            
            const userQuery = match[1].trim();
            console.log("Group query:", userQuery);
            
            // Process the query
            try {
                const pineconeReady = await initializePinecone();
                if (!pineconeReady) {
                    await twilioClient.messages.create({
                        body: "I'm having trouble accessing property information right now. Please try again later.",
                        from: To,
                        to: From,
                        messagingServiceSid: MESSAGING_SERVICE_SID
                    });
                    return res.status(200).send('OK');
                }
                
                // Generate embedding for the query
                const embedding = await getGoogleEmbeddingForQueryJS(userQuery);
                if (!embedding) {
                    throw new Error("Failed to generate embedding");
                }
                
                // Query Pinecone
                const queryResponse = await pineconeIndex.namespace(DEFAULT_PROPERTY_ID).query({
                    vector: embedding,
                    topK: TOP_K_RESULTS,
                    includeMetadata: true
                });
                
                // Extract context from results
                const contexts = [];
                const sourcesSet = new Set();
                
                for (const match of queryResponse.matches) {
                    const content = match.metadata?.content || match.metadata?.text || '';
                    if (content && match.score > 0.5) {
                        contexts.push(content);
                        if (match.metadata?.url) {
                            sourcesSet.add(match.metadata.url);
                        }
                    }
                }
                
                const context = contexts.join('\n\n');
                
                // Prepare LLM prompt
                const systemPrompt = `You are Lucy, a helpful AI assistant for property inquiries. 
                You're responding in a WhatsApp group chat where you were mentioned.
                Be friendly, concise, and helpful. Keep responses under 300 words.
                Only answer based on the provided context. If information isn't in the context, say so politely.`;
                
                const userPrompt = `Context:\n${context}\n\nQuestion: ${userQuery}`;
                
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
                
                let response = completion.choices[0]?.message?.content || "I couldn't generate a response.";
                
                // Clean and send response
                await twilioClient.messages.create({
                    body: cleanLLMResponse(response),
                    from: To,
                    to: From,
                    messagingServiceSid: MESSAGING_SERVICE_SID
                });
                
                console.log("Sent group response");
                
            } catch (error) {
                console.error("Error processing group message:", error);
                await twilioClient.messages.create({
                    body: "Sorry, I encountered an error processing your question. Please try again.",
                    from: To,
                    to: From,
                    messagingServiceSid: MESSAGING_SERVICE_SID
                });
            }
            
        } else {
            // Handle 1:1 messages with existing logic
            console.log("1:1 MESSAGE");
            
            // Initialize chat history for new users
            global.chatHistories = global.chatHistories || {};
            global.propertyContexts = global.propertyContexts || {};
            
            const phoneNumber = From?.replace('whatsapp:', '');
            
            if (!global.chatHistories[phoneNumber]) {
                global.chatHistories[phoneNumber] = [];
                global.propertyContexts[phoneNumber] = { propertyId: null };
            }
            
            // Rest of your existing 1:1 message handling code...
            // (Copy the rest of your existing handler code here for 1:1 messages)
            
            try {
                const pineconeReady = await initializePinecone();
                
                // Add your existing 1:1 message processing logic here
                // This is where your property detection, RAG, and response generation goes
                
                // For now, just echo back (replace with your actual logic)
                await twilioClient.messages.create({
                    body: "I received your message: " + Body,
                    from: To,
                    to: From
                });
                
            } catch (error) {
                console.error("Error processing 1:1 message:", error);
                await twilioClient.messages.create({
                    body: "Sorry, I encountered an error. Please try again.",
                    from: To,
                    to: From
                });
            }
        }
        
        return res.status(200).send('OK');
    }
    
    return res.status(405).send('Method Not Allowed');
}
