//pages/api/whatsapp.js

import twilio from 'twilio';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';

// --- Environment Variables (same) ---
const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_SENDER,
    PINECONE_API_KEY,
    PINECONE_INDEX_NAME,
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL_NAME,
    OPENROUTER_SITE_URL,
    OPENROUTER_APP_NAME,
    GOOGLE_API_KEY,
    GOOGLE_EMBEDDING_MODEL_ID,
    VERCEL_URL,
    DEBUG_SKIP_TWILIO_VALIDATION
} = process.env;

const GROUP_CHAT_TRIGGER_WORD = "@lucy";

// --- Initialize Clients (same) ---
let twilioClient;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
    console.error("WhatsApp API: CRITICAL: Twilio Account SID or Auth Token not set.");
}

let pinecone;
let pineconeIndex;
const initializePinecone = async () => {
    if (pineconeIndex) return true;
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("WhatsApp API: Pinecone JS client initialized for index:", PINECONE_INDEX_NAME);
            return true;
        } catch (error) {
            console.error("WhatsApp API: Pinecone JS client initialization error:", error);
            pineconeIndex = null; return false;
        }
    } else {
        console.error("WhatsApp API: CRITICAL: Pinecone API Key or Index Name missing.");
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
            "X-Title": OPENROUTER_APP_NAME || "LucyWhatsAppBot",
        },
    });
} else {
    console.error("WhatsApp API: CRITICAL: OPENROUTER_API_KEY not set.");
}
const llmModelToUse = OPENROUTER_MODEL_NAME || "google/gemini-flash-1.5";

let googleGenAI;
let googleEmbeddingGenAIModel;
if (GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("WhatsApp API: Google AI JS client initialized for embeddings model:", embeddingModelId);
    } catch (error) {
        console.error("WhatsApp API: Error initializing Google AI JS client for embeddings:", error);
        googleEmbeddingGenAIModel = null;
    }
} else {
    console.error("WhatsApp API: CRITICAL: GOOGLE_API_KEY not set.");
}

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
            console.error("WhatsApp API: Unexpected embedding format from Google AI:", JSON.stringify(result, null, 2));
            throw new Error("Failed to extract embedding values from Google AI JS response.");
        }
    } catch (error) {
        console.error("WhatsApp API: Error getting embedding for query from Google AI:", error.message, error.stack);
        throw error;
    }
}

// Helper function to create an enhanced query that includes recent context (from chat.js)
function createContextAwareQuery(userQuery, chatHistory) {
    if (!chatHistory || chatHistory.length === 0) {
        return userQuery;
    }
    
    // Get last few messages for context (limit to prevent token overflow)
    const recentHistory = chatHistory.slice(-4); // Last 4 messages (2 exchanges)
    
    // Check if the current query might be referring to previous context
    const referentialWords = ['it', 'that', 'this', 'they', 'them', 'there', 'those', 'these'];
    const hasReference = referentialWords.some(word => 
        userQuery.toLowerCase().includes(` ${word} `) || 
        userQuery.toLowerCase().startsWith(`${word} `)
    );
    
    if (hasReference) {
        // Build context from recent messages
        const contextParts = [];
        recentHistory.forEach(msg => {
            if (msg.sender === 'user') {
                contextParts.push(`Previous question: ${msg.text}`);
            }
        });
        
        if (contextParts.length > 0) {
            // Create an enhanced query for better embedding search
            return `${contextParts.join('. ')}. Current question: ${userQuery}`;
        }
    }
    
    return userQuery;
}

function extractPropertyIdFromMessage(twilioRequestBody, userMessage) {
    const lowerMessage = userMessage.toLowerCase();
    const propertyKeywords = ["property", "unit", "villa", "apt", "apartment", "house", "staying at"];
    for (const keyword of propertyKeywords) {
        const regex = new RegExp(`${keyword}\\s+([a-zA-Z0-9_-]+)`, 'i');
        const match = lowerMessage.match(regex);
        if (match && match[1]) {
            console.log(`WhatsApp API: Extracted propertyId '${match[1]}' from message.`);
            return match[1];
        }
    }
    return null;
}

// sendTwilioMessageWithRetry - same as before
const RETRYABLE_TWILIO_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPIPE'];
const MAX_SEND_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;

async function sendTwilioMessageWithRetry(messagePayload, attempt = 1) {
    if (!twilioClient || !TWILIO_WHATSAPP_SENDER) {
        console.error("WhatsApp API (sendTwilioMessageWithRetry): Twilio client or sender not available.");
        return false;
    }
    try {
        console.log(`WhatsApp API (sendTwilioMessageWithRetry): Attempt ${attempt} to send to ${messagePayload.to}.`);
        await twilioClient.messages.create(messagePayload);
        console.log(`WhatsApp API (sendTwilioMessageWithRetry): Sent reply to ${messagePayload.to} on attempt ${attempt}.`);
        return true;
    } catch (sendError) {
        let errorDetails = sendError.message;
        if (sendError.code) errorDetails += ` (Code: ${sendError.code})`;
        console.error(`WhatsApp API (sendTwilioMessageWithRetry): Error on attempt ${attempt} for ${messagePayload.to}:`, errorDetails);
        if (sendError.moreInfo) console.error("Twilio More Info:", sendError.moreInfo);

        if (RETRYABLE_TWILIO_ERROR_CODES.includes(sendError.code) && attempt <= MAX_SEND_RETRIES) {
            const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            console.warn(`WhatsApp API (sendTwilioMessageWithRetry): Retrying in ${delayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return sendTwilioMessageWithRetry(messagePayload, attempt + 1);
        } else {
            console.error(`WhatsApp API (sendTwilioMessageWithRetry): Failed after ${attempt} attempts or error not retryable.`);
            return false;
        }
    }
}

export default async function handler(req, res) {
    console.log("\n--- WhatsApp API Request Received ---");
    console.log("Timestamp:", new Date().toISOString());
    console.log("Method:", req.method);

    if (req.method !== 'POST') {
        console.log("WhatsApp API: Not POST.");
        res.setHeader('Allow', 'POST');
        return res.status(405).end('Method Not Allowed');
    }
    
    if (!twilioClient || !openrouterLlmClient || !googleEmbeddingGenAIModel || !PINECONE_INDEX_NAME || !PINECONE_API_KEY) {
        console.error("WhatsApp API: CRITICAL: One or more core services not initialized.");
        const errorMessage = "I'm sorry, I'm having some technical difficulties. Please ask one of my human teammates in this group chat for help here.";
        if (twilioClient && TWILIO_WHATSAPP_SENDER && req.body && req.body.From) {
             sendTwilioMessageWithRetry({ to: req.body.From, from: TWILIO_WHATSAPP_SENDER, body: errorMessage });
        }
        return res.status(500).json({ error: "Server configuration error." });
    }

    const { Body: incomingMsg, From: fromNumber, To: twilioSystemNumber, ProfileName: profileName = "Guest" } = req.body;
    if (!incomingMsg || !fromNumber) {
        console.warn("WhatsApp API: Missing 'Body' or 'From'.");
        return res.status(400).send("Bad Request: Missing required fields.");
    }
    console.log(`WhatsApp API: From ${fromNumber} (${profileName}) to ${twilioSystemNumber}, Msg: "${incomingMsg}"`);

    const twilioSignature = req.headers['x-twilio-signature'];
    let webhookUrlForValidation;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const isVercelEnvironment = process.env.NODE_ENV === 'production' || VERCEL_URL;

    if (isVercelEnvironment) {
        webhookUrlForValidation = `${protocol}://${req.headers.host}${req.url}`;
    } else {
        webhookUrlForValidation = `${process.env.NEXT_PUBLIC_SITE_URL || `${protocol}://${req.headers.host}`}${req.url}`;
    }
    const params = req.body;

    const forceSkipValidation = DEBUG_SKIP_TWILIO_VALIDATION === "true";
    const shouldValidate = !forceSkipValidation && (isVercelEnvironment || process.env.NEXT_PUBLIC_SITE_URL);

    if (shouldValidate) {
        if (!TWILIO_AUTH_TOKEN || !twilioSignature) {
            console.warn("WhatsApp API: Missing Auth Token or Signature for validation.");
            return res.status(401).send('Authentication failed (validation credentials missing).');
        }
        try {
            const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, twilioSignature, webhookUrlForValidation, params);
            if (!isValid) {
                console.warn(`WhatsApp API: Invalid Twilio signature. URL: ${webhookUrlForValidation}.`);
                return res.status(403).send('Authentication failed (Invalid Twilio signature).');
            }
            console.log("WhatsApp API: Twilio signature validated.");
        } catch (validationError) {
            console.error("WhatsApp API: Error during Twilio.validateRequest:", validationError);
            return res.status(500).send('Server error during signature validation.');
        }
    } else {
        console.log(`WhatsApp API: SKIPPING Twilio signature validation.`);
    }

    let userQuery = incomingMsg;
    const isGroupMessage = fromNumber && fromNumber.includes('@g.us');

    if (isGroupMessage) {
        if (!userQuery.toLowerCase().startsWith(GROUP_CHAT_TRIGGER_WORD.toLowerCase())) {
            console.log(`WhatsApp API: Group msg from ${fromNumber} ignored (no trigger).`);
            return res.status(200).setHeader('Content-Type', 'text/xml').send(new twilio.twiml.MessagingResponse().toString());
        }
        userQuery = userQuery.substring(GROUP_CHAT_TRIGGER_WORD.length).trim();
        if (!userQuery) {
            const helpMsg = `You called, ${profileName}! What can I help you with after "${GROUP_CHAT_TRIGGER_WORD}"?`;
            sendTwilioMessageWithRetry({ body: helpMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
            return res.status(200).setHeader('Content-Type', 'text/xml').send(new twilio.twiml.MessagingResponse().toString());
        }
    }

    const pineconeReady = await initializePinecone();
    if (!pineconeReady || !pineconeIndex) {
         console.error("WhatsApp API: Pinecone index not available for RAG.");
         const pineconeErrorMsg = "I'm sorry, I'm having trouble accessing property info. You might need to ask one of my human teammates in this group chat for more help here.";
         sendTwilioMessageWithRetry({ body: pineconeErrorMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
         return res.status(200).setHeader('Content-Type', 'text/xml').send(new twilio.twiml.MessagingResponse().toString());
    }
    
    // Extract propertyId
    let propertyId = extractPropertyIdFromMessage(req.body, userQuery) || "Unit4BNelayanReefApartment";
    console.log(`WhatsApp API: Using Property ID: ${propertyId} for query.`);
    
    // Extract chatHistory if provided (for future WhatsApp context support)
    const { chatHistory } = req.body;
    console.log(`WhatsApp API: Chat history length: ${chatHistory ? chatHistory.length : 0}`);

    let contextChunks = [];
    let hasPropertyContextForLLM = false;

    if (!googleEmbeddingGenAIModel) {
        console.error("WhatsApp API: Google Embedding Model not available. Cannot perform RAG.");
    } else {
        try {
            // Create context-aware query for better RAG results (matching chat.js)
            const enhancedQuery = createContextAwareQuery(userQuery, chatHistory);
            console.log(`WhatsApp API: Enhanced query for embedding: "${enhancedQuery.substring(0,100)}..."`);
            
            const queryEmbedding = await getGoogleEmbeddingForQueryJS(enhancedQuery);
            
            console.log(`WhatsApp API: Querying Pinecone for P-ID '${propertyId}'.`);
            const queryResponse = await pineconeIndex.query({
                vector: queryEmbedding,
                topK: 5, // Increased from 2 to match chat.js
                filter: { propertyId: propertyId },
                includeMetadata: true,
            });
            
            if (queryResponse.matches && queryResponse.matches.length > 0) {
                contextChunks = queryResponse.matches
                    .map(match => match.metadata && match.metadata.text ? match.metadata.text.trim() : "")
                    .filter(Boolean);
                if (contextChunks.length > 0) {
                    hasPropertyContextForLLM = true;
                    console.log(`WhatsApp API: Retrieved ${contextChunks.length} context chunks for P-ID '${propertyId}'.`);
                } else {
                    console.log(`WhatsApp API: Pinecone query for P-ID '${propertyId}' had matches but no text.`);
                }
            } else {
                console.log(`WhatsApp API: No specific context in Pinecone for P-ID '${propertyId}'.`);
            }
        } catch (error) {
            console.error(`WhatsApp API: Error during RAG for P-ID '${propertyId}':`, error.message);
            contextChunks = [];
            hasPropertyContextForLLM = false;
        }
    }

    const contextForLLM = hasPropertyContextForLLM ? contextChunks.join("\n\n---\n\n") : "No specific property information was retrieved for this query.";
    
    let cityFromProperty = "the current location";
    const pidLower = propertyId.toLowerCase();
    if (pidLower.includes("bali") || pidLower.includes("nelayan") || pidLower.includes("seminyak") || pidLower.includes("ubud") || pidLower.includes("canggu")) {
        cityFromProperty = "Bali";
    } else if (pidLower.includes("dubai")) {
        cityFromProperty = "Dubai";
    }
    console.log(`WhatsApp API: Property's city: ${cityFromProperty}. Has RAG context for LLM: ${hasPropertyContextForLLM}`);

    // Enhanced system prompt with conversation awareness (matching chat.js)
    const systemPrompt = `You are Lucy, a remarkably charming, kind, and warm AI assistant. You have years of experience living in and exploring Bali, making you a true local expert. You are currently assisting a guest at property "${propertyId}". Your goal is to be exceptionally helpful and make their stay wonderful.

IMPORTANT CONVERSATION CONTEXT:
- You are engaged in an ongoing conversation with the guest via WhatsApp
- Pay attention to the chat history to understand the full context
- Reference previous topics naturally when relevant
- Remember what the guest has already asked about to avoid repetition
- If the guest refers to "it", "that", "there" etc., understand they're referring to something from earlier in the conversation

The guest's current question is: "${userQuery}"

Your primary task is to determine the NATURE of the guest's question and respond accordingly:

TYPE 1: PROPERTY-SPECIFIC QUESTION
- This is a question directly about property "${propertyId}" (e.g., "wifi password?", "how does the AC work?", "what's the address for ${propertyId}?").
- IF the question is Type 1:
   1. You HAVE BEEN PROVIDED with the following "Property Information Context" for "${propertyId}":
   ---
   ${contextForLLM}
   ---
   (Note: If the context above says "No specific property information was retrieved", it means RAG found nothing relevant from the database for this query for this property.)
   2. Answer the question ("${userQuery}") USING ONLY information found within this "Property Information Context".
   3. If the "Property Information Context" (especially if it's not "No specific property information...") DOES NOT contain the answer for "${propertyId}", then state: "I'm sorry, I'm unsure about that. You might need to ask one of my human teammates in this group chat for more help here." DO NOT use your general knowledge for Type 1 questions if the context is missing the answer or says no info was retrieved.

TYPE 2: GENERAL CITY/LOCATION QUESTION
- This is a question about ${cityFromProperty} (the city where "${propertyId}" is located) or ANOTHER city/location explicitly mentioned in "${userQuery}" (e.g., "things to do in ${cityFromProperty}", "best restaurants in Uluwatu", "how to get to the airport?").
- IF the question is Type 2 AND it is NOT successfully answered as a Type 1 question (because context was missing, context said no info retrieved, or context was irrelevant to the question):
   1. Answer the question ("${userQuery}") using your general knowledge as a helpful city/travel expert or use internet search results.

TYPE 3: OTHER GENERAL KNOWLEDGE QUESTION
- This is a question not fitting Type 1 or Type 2 (e.g., "what's the capital of France?").
- IF the question is Type 3:
   1. Answer using your general knowledge or internet search results.

IF YOU CANNOT ANSWER or are unsure after considering these types:
- State: "I'm sorry, I'm unsure about that. You might need to ask one of my human teammates in this group chat for more help here. Can I help you with anything else?"

CRITICAL:
- Prioritize answering as Type 1 if the question seems property-specific and the provided context (if any) helps.
- If Type 1 fails due to lack of specific context in the retrieved info, then consider Type 2.
- For WhatsApp, keep answers brief but complete. Use short sentences and clear formatting.
- Always maintain a friendly, polite, and warm conversational tone. Offer a little extra helpful tip or suggestion if appropriate, especially for general city questions.
- Be concise but complete.
- Build upon the conversation naturally - don't repeat information you've already provided unless specifically asked.`;

    let llmResponseText = `I'm sorry, I encountered an issue processing your request for property "${propertyId}".`;

    if (!openrouterLlmClient) {
        console.error("WhatsApp API: OpenRouter client not initialized.");
        llmResponseText = "My connection to the AI brain is offline for '${propertyId}'. Please inform support.";
    } else {
        try {
            const messagesForLLM = [{ role: "system", content: systemPrompt }];
            
            // Process chat history if available (for future context support)
            if (Array.isArray(chatHistory) && chatHistory.length > 0) {
                // Limit history to prevent token overflow while maintaining context
                const maxHistoryItems = 10; // Last 10 messages (5 exchanges)
                const recentHistory = chatHistory.slice(-maxHistoryItems);
                
                recentHistory.forEach(msg => {
                    let role = 'user';
                    if (msg.sender === 'bot' || msg.sender === 'assistant' || msg.sender === 'lucy') {
                        role = 'assistant';
                    } else if (msg.sender === 'user') {
                        role = 'user';
                    }
                    
                    if ((role === 'user' || role === 'assistant') && msg.text) {
                        messagesForLLM.push({ role: role, content: msg.text });
                    }
                });
                
                console.log(`WhatsApp API: Added ${recentHistory.length} history messages to context`);
            }
            
            messagesForLLM.push({ role: "user", content: userQuery });
            
            console.log(`WhatsApp API: Sending to OpenRouter (${llmModelToUse}). Total messages: ${messagesForLLM.length}, History items included: ${messagesForLLM.length - 2}`);
            
            const completion = await openrouterLlmClient.chat.completions.create({
                model: llmModelToUse,
                messages: messagesForLLM,
                temperature: 0.3, // Aligned with chat.js (was 0.2)
                max_tokens: 600, // Increased to match chat.js (was 300)
            });
            
            if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
                llmResponseText = completion.choices[0].message.content.trim();
                console.log(`WhatsApp API: LLM response: "${llmResponseText.substring(0,100)}..."`);
            } else {
                console.error("WhatsApp API: No response content from OpenRouter:", JSON.stringify(completion, null, 2));
                llmResponseText = `I received an unusual response from my AI brain for '${propertyId}'.`;
            }
        } catch (error) {
            console.error("WhatsApp API: Error calling OpenRouter API:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message, error.stack);
            llmResponseText = `Sorry, I'm having trouble connecting to my AI brain right now for '${propertyId}'. Please try again.`;
        }
    }

    sendTwilioMessageWithRetry({
        body: llmResponseText,
        from: TWILIO_WHATSAPP_SENDER,
        to: fromNumber,
    });

    const twiml = new twilio.twiml.MessagingResponse();
    res.setHeader('Content-Type', 'text/xml');
    console.log("WhatsApp API: --- Request Processing Complete. Sending 200 OK to Twilio. ---");
    return res.status(200).send(twiml.toString());
}
