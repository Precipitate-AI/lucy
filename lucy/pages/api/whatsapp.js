// Using JavaScript (not TypeScript) to match the file you provided.
// If you prefer TypeScript, we can convert it.
import { Twilio } from 'twilio';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai'; // For OpenRouter
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai'; // HarmCategory/BlockThreshold not needed for embed

// --- Environment Variables (Ensure these are set in Vercel and .env.local) ---
const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_SENDER, // Your Twilio WhatsApp number
    PINECONE_API_KEY,
    PINECONE_INDEX_NAME,
    OPENROUTER_API_KEY,
    OPENROUTER_GEMINI_MODEL, // e.g., "google/gemini-pro" or "google/gemini-1.5-pro-latest"
    OPENROUTER_SITE_URL,    // Optional: e.g., https://your-app.vercel.app
    OPENROUTER_APP_NAME,    // Optional: e.g., "LucyWhatsAppBot"
    GOOGLE_API_KEY,         // For embeddings
    GOOGLE_EMBEDDING_MODEL_ID // e.g., "models/embedding-001"
} = process.env;

const GROUP_CHAT_TRIGGER_WORD = "@lucy"; // Or whatever you prefer

// --- Initialize Clients (with error checking) ---
let twilioClient;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
    console.error("CRITICAL: Twilio Account SID or Auth Token not set. WhatsApp replies will fail.");
}

let pinecone;
let pineconeIndex;
const initializePinecone = async () => {
    if (pineconeIndex) return true; // Already initialized
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats(); // Test connection
            console.log("Pinecone client initialized and connected to index:", PINECONE_INDEX_NAME);
            return true;
        } catch (error) {
            console.error("Pinecone JS client initialization error:", error);
            pineconeIndex = null;
            return false;
        }
    } else {
        console.error("CRITICAL: Pinecone API Key or Index Name missing for JS webhook.");
        return false;
    }
};

let openrouterLlmClient;
if (OPENROUTER_API_KEY) {
    openrouterLlmClient = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: OPENROUTER_API_KEY,
        defaultHeaders: {
            "HTTP-Referer": OPENROUTER_SITE_URL || "http://localhost:3000",
            "X-Title": OPENROUTER_APP_NAME || "LucyWhatsAppBot",
        },
    });
} else {
    console.error("CRITICAL: OPENROUTER_API_KEY not set. LLM calls will fail for JS webhook.");
}
const llmModelToUse = OPENROUTER_GEMINI_MODEL || "google/gemini-pro"; // Fallback

let googleGenAI;
let googleEmbeddingGenAIModel;
if (GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("Google AI JS client initialized for embeddings with model:", embeddingModelId);
    } catch (error) {
        console.error("Error initializing Google AI JS client for embeddings:", error);
        googleEmbeddingGenAIModel = null;
    }
} else {
    console.error("CRITICAL: GOOGLE_API_KEY not set for JS webhook. Embedding generation will fail.");
}

// --- Helper Functions ---
async function getGoogleEmbeddingForQueryJS(text) {
    if (!googleEmbeddingGenAIModel) {
        console.error("JS Webhook: Google AI embedding model not initialized.");
        throw new Error("Embedding service (Google JS) not configured.");
    }
    try {
        const result = await googleEmbeddingGenAIModel.embedContent(
             text,
             TaskType.RETRIEVAL_QUERY
        );
        const embedding = result.embedding;
        if (embedding && embedding.values && Array.isArray(embedding.values)) {
            return embedding.values;
        } else {
            console.error("JS Webhook: Unexpected embedding format from Google AI:", JSON.stringify(result, null, 2));
            throw new Error("Failed to extract embedding values from Google AI JS response.");
        }
    } catch (error) {
        console.error("JS Webhook: Error getting embedding for query from Google AI:", error.message);
        throw error;
    }
}

// This property ID extraction logic was in your webhook.js. We can refine it.
// For now, a simple placeholder. You'll need to define how to get 'propertyId'
// For example, from a group name, a keyword in the message, or user profile.
function extractPropertyIdFromMessage(twilioRequestBody, userMessage) {
    // Example: if user says "@lucy for propertyUnitA", extract "propertyUnitA"
    // Or map from twilioRequestBody.From if it's a known group JID
    // const fromJid = twilioRequestBody.From; // whatsapp:+1234567890@g.us
    // This is simplified - you'll need more robust logic here.
    const match = userMessage.match(/for property (\w+)/i);
    if (match && match[1]) {
        return match[1];
    }
    // If you have a fixed property for now, you can hardcode it FOR TESTING:
    // return "Unit4BNelayanReefApartment";
    return "default_property"; // Fallback or request clarification
}


// --- Main Handler ---
export default async function handler(req, res) {
    console.log("\n--- JS WhatsApp Webhook Request Received ---");
    if (req.method !== 'POST') {
        console.log("JS Webhook: Request is not POST.");
        res.setHeader('Allow', 'POST');
        return res.status(405).end('Method Not Allowed');
    }

    // Basic check for essential clients
    if (!twilioClient || !OPENROUTER_API_KEY || !GOOGLE_API_KEY || !PINECONE_API_KEY || !PINECONE_INDEX_NAME ) {
        console.error("JS Webhook: One or more critical environment variables/clients are missing.");
        // Avoid sending Twilio message if Twilio client itself is broken
        if (twilioClient && TWILIO_WHATSAPP_SENDER && req.body.From){
             try {
                await twilioClient.messages.create({
                    to: req.body.From,
                    from: TWILIO_WHATSAPP_SENDER,
                    body: "I'm having some technical difficulties with my core configuration. Please contact support.",
                });
             } catch (twilioError) {
                console.error("JS Webhook: Failed to send config error message via Twilio:", twilioError.message);
             }
        }
        return res.status(500).json({ error: "Server configuration error prevented processing." });
    }


    // Parse Twilio request body (Next.js does this automatically for urlencoded)
    const { Body: incomingMsg, From: fromNumber, To: twilioSystemNumber, ProfileName: profileName } = req.body;

    console.log(`JS Webhook: From ${fromNumber} (${profileName || 'N/A'}) to ${twilioSystemNumber}, Msg: "${incomingMsg}"`);

    // Twilio Signature Validation (IMPORTANT for production)
    const twilioSignature = req.headers['x-twilio-signature'];
    const webhookUrl = (process.env.NEXT_PUBLIC_SITE_URL || `https://${req.headers.host}`) + req.url;
    // console.log("Validating with URL:", webhookUrl) // For debugging
    const params = req.body;

    if (process.env.NODE_ENV === 'production') { // Typically only validate in prod
        if (!Twilio.validateRequest(TWILIO_AUTH_TOKEN, twilioSignature, webhookUrl, params)) {
            console.warn("JS Webhook: Invalid Twilio signature.");
            return res.status(403).send('Authentication failed. Invalid Twilio signature.');
        }
        console.log("JS Webhook: Twilio signature validated.");
    }


    let userQuery = incomingMsg;
    const isGroupMessage = fromNumber && fromNumber.includes('@g.us');

    if (isGroupMessage) {
        if (!incomingMsg.toLowerCase().startsWith(GROUP_CHAT_TRIGGER_WORD.toLowerCase())) {
            console.log(`JS Webhook: Group message ignored (no trigger "${GROUP_CHAT_TRIGGER_WORD}").`);
            const twiml = new Twilio.twiml.MessagingResponse(); // Empty TwiML to acknowledge
            return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
        }
        userQuery = incomingMsg.substring(GROUP_CHAT_TRIGGER_WORD.length).trim();
        if (!userQuery) {
            const helpMsg = `You called, ${profileName || 'friend'}! What can I help you with after "${GROUP_CHAT_TRIGGER_WORD}"?`;
            // No need to await this specific message if we're sending TwiML
            twilioClient.messages.create({ body: helpMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
            const twiml = new Twilio.twiml.MessagingResponse(); // Empty TwiML
            return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
        }
    }

    // Attempt to initialize Pinecone (idempotent)
    const pineconeReady = await initializePinecone();
    if (!pineconeReady || !pineconeIndex) {
         console.error("JS Webhook: Pinecone index not available. Cannot proceed with RAG.");
         const pineconeErrorMsg = "I'm having trouble accessing the property information right now. Please try again later.";
         twilioClient.messages.create({ body: pineconeErrorMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
         const twiml = new Twilio.twiml.MessagingResponse();
         return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
    }

    // You need a way to associate the message with a specific property's data.
    // This could be based on the group chat ID, a keyword in the message, etc.
    const propertyId = extractPropertyIdFromMessage(req.body, userQuery); // Implement this!
    if (!propertyId || propertyId === "default_property") {
         const noPropIdMsg = `To help you best, which property are you asking about? (e.g., "${GROUP_CHAT_TRIGGER_WORD} for property XYZ what is the wifi?")`;
         twilioClient.messages.create({ body: noPropIdMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
         const twiml = new Twilio.twiml.MessagingResponse();
         return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
    }
    console.log(`JS Webhook: Processing for Property ID: ${propertyId}`);


    let contextChunks = [];
    try {
        const queryEmbedding = await getGoogleEmbeddingForQueryJS(userQuery);
        const queryResponse = await pineconeIndex.query({
            vector: queryEmbedding,
            topK: 3,
            filter: { propertyId: propertyId }, // Assuming your Pinecone vectors have 'propertyId' in metadata
            includeMetadata: true,
        });

        if (queryResponse.matches && queryResponse.matches.length > 0) {
            contextChunks = queryResponse.matches.map(match => match.metadata.text);
            console.log(`JS Webhook: Retrieved ${contextChunks.length} context chunks for property '${propertyId}'.`);
        } else {
            console.log(`JS Webhook: No specific context found in Pinecone for property '${propertyId}' and query: "${userQuery.substring(0,50)}"`);
        }
    } catch (error) {
        console.error(`JS Webhook: Error during embedding or Pinecone query for '${propertyId}':`, error.message);
        // Fall through, LLM will be informed about lack of context.
    }

    const contextForLLM = contextChunks.join("\n\n---\n\n") || `No specific information was found in our knowledge base for property "${propertyId}" related to your query.`;
    const systemPrompt = `You are Lucy, a friendly AI assistant for property "${propertyId}".
Answer guest questions based ONLY on the "Property Information Context" below.
If the answer isn't in the context, state that clearly. Do not invent.

Property Information Context for "${propertyId}":
---
${contextForLLM}
---`;

    let llmResponseText = `I'm sorry, I couldn't find an answer for that regarding property "${propertyId}". Please try rephrasing or contact the manager.`;

    if (!openrouterLlmClient) {
        console.error("JS Webhook: OpenRouter client not initialized. Cannot get LLM response.");
    } else {
        try {
            console.log(`JS Webhook: Sending prompt to OpenRouter (${llmModelToUse}) for property ${propertyId}. Context length: ${contextForLLM.length}`);
            const completion = await openrouterLlmClient.chat.completions.create({
                model: llmModelToUse,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Guest Question (about property "${propertyId}"): "${userQuery}"` }
                ],
                temperature: 0.3,
                max_tokens: 400,
            });
            if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
                llmResponseText = completion.choices[0].message.content.trim();
                console.log(`JS Webhook: LLM response received: "${llmResponseText.substring(0,100)}..."`);
            } else {
                console.error("JS Webhook: No response content from OpenRouter:", JSON.stringify(completion));
            }
        } catch (error) {
            console.error("JS Webhook: Error calling OpenRouter API:", error.response ? JSON.stringify(error.response.data) : error.message);
        }
    }

    // Send reply via Twilio (using direct API call, not TwiML for async RAG)
    // Using async IIFE to send reply and then acknowledge Twilio quickly.
    (async () => {
        try {
            await twilioClient.messages.create({
                body: llmResponseText,
                from: TWILIO_WHATSAPP_SENDER,
                to: fromNumber,
            });
            console.log(`JS Webhook: Successfully sent reply to ${fromNumber}.`);
        } catch (sendError) {
            console.error("JS Webhook: Error sending final Twilio message:", sendError.message);
        }
    })();

    // Acknowledge Twilio's HTTP request quickly
    const twiml = new Twilio.twiml.MessagingResponse();
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
}
