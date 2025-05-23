// lucy/pages/api/whatsapp.js
import twilio from 'twilio';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';

// --- Environment Variables ---
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

// --- Initialize Clients ---
let twilioClient;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
    console.error("CRITICAL: Twilio Account SID or Auth Token not set.");
}

// ... (Pinecone, OpenRouter, Google AI client initializations remain the same) ...
let pinecone;
let pineconeIndex;
const initializePinecone = async () => {
    if (pineconeIndex) return true;
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("Pinecone JS client initialized for index:", PINECONE_INDEX_NAME);
            return true;
        } catch (error) {
            console.error("Pinecone JS client initialization error:", error);
            pineconeIndex = null; return false;
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
            "HTTP-Referer": OPENROUTER_SITE_URL || (VERCEL_URL ? `https://${VERCEL_URL}` : "http://localhost:3000"),
            "X-Title": OPENROUTER_APP_NAME || "LucyWhatsAppBot",
        },
    });
} else {
    console.error("CRITICAL: OPENROUTER_API_KEY not set for JS webhook.");
}
const llmModelToUse = OPENROUTER_MODEL_NAME || "google/gemini-2.5-pro-preview";

let googleGenAI;
let googleEmbeddingGenAIModel;
if (GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("Google AI JS client initialized for embeddings model:", embeddingModelId);
    } catch (error) {
        console.error("Error initializing Google AI JS client for embeddings:", error);
        googleEmbeddingGenAIModel = null;
    }
} else {
    console.error("CRITICAL: GOOGLE_API_KEY not set for JS webhook.");
}


// --- Helper Functions ---
async function getGoogleEmbeddingForQueryJS(text) {
    // ... (embedding function remains the same) ...
    if (!googleEmbeddingGenAIModel) {
        console.error("JS Webhook: Google AI embedding model not initialized.");
        throw new Error("Embedding service (Google JS) not configured.");
    }
    try {
        const result = await googleEmbeddingGenAIModel.embedContent(text);
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

function extractPropertyIdFromMessage(twilioRequestBody, userMessage) {
    // ... (extractPropertyIdFromMessage function remains the same) ...
    const match = userMessage.match(/for property (\w+)/i);
    if (match && match[1]) {
        return match[1];
    }
    return "default_property";
}

// --- Retry Logic for Twilio Send ---
const RETRYABLE_TWILIO_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPIPE']; // Add more as needed
const MAX_SEND_RETRIES = 2; // Try initial send + 2 retries = 3 attempts total
const INITIAL_RETRY_DELAY_MS = 500; // Start with 500ms delay

async function sendTwilioMessageWithRetry(messagePayload, attempt = 1) {
    if (!twilioClient || !TWILIO_WHATSAPP_SENDER) {
        console.error("JS Webhook (sendTwilioMessageWithRetry): Twilio client or sender not available.");
        return false;
    }

    try {
        console.log(`JS Webhook (sendTwilioMessageWithRetry): Attempt ${attempt} to send message to ${messagePayload.to}.`);
        await twilioClient.messages.create(messagePayload);
        console.log(`JS Webhook (sendTwilioMessageWithRetry): Successfully sent reply to ${messagePayload.to} on attempt ${attempt}.`);
        return true;
    } catch (sendError) {
        let errorDetails = sendError.message;
        if (sendError.code) errorDetails += ` (Code: ${sendError.code})`;

        console.error(`JS Webhook (sendTwilioMessageWithRetry): Error on attempt ${attempt} for ${messagePayload.to}:`, errorDetails);
        if (sendError.moreInfo) console.error("Twilio More Info:", sendError.moreInfo);

        // Check if error is retryable and we haven't exceeded max retries
        if (RETRYABLE_TWILIO_ERROR_CODES.includes(sendError.code) && attempt <= MAX_SEND_RETRIES) {
            const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
            console.warn(`JS Webhook (sendTwilioMessageWithRetry): Retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_SEND_RETRIES + 1})...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return sendTwilioMessageWithRetry(messagePayload, attempt + 1);
        } else {
            console.error(`JS Webhook (sendTwilioMessageWithRetry): Failed to send message after ${attempt} attempts or error not retryable.`);
            return false;
        }
    }
}


// --- Main Handler ---
export default async function handler(req, res) {
    console.log("\n--- JS WhatsApp Webhook Request Received ---");
    // ... (initial logs and method check remain the same) ...
    console.log("Timestamp:", new Date().toISOString());
    console.log("Request Method:", req.method);
    console.log("Request Body Keys:", req.body ? Object.keys(req.body).join(', ') : 'No Body');

    if (req.method !== 'POST') {
        console.log("JS Webhook: Request is not POST.");
        res.setHeader('Allow', 'POST');
        return res.status(405).end('Method Not Allowed');
    }

    // Basic check for essential clients
    if (!twilioClient || !openrouterLlmClient || !googleEmbeddingGenAIModel || !PINECONE_INDEX_NAME || !PINECONE_API_KEY) {
        // ... (client check and error response remain the same) ...
        console.error("JS Webhook: One or more critical environment variables/clients are missing or not initialized.");
        const errorMessage = "I'm having some technical difficulties with my core configuration. Please contact support.";
        if (twilioClient && TWILIO_WHATSAPP_SENDER && req.body && req.body.From) {
             try {
                // Use the retry mechanism even for this error message if possible, though it might also fail if Twilio client itself is the issue
                await sendTwilioMessageWithRetry({
                    to: req.body.From,
                    from: TWILIO_WHATSAPP_SENDER,
                    body: errorMessage,
                });
             } catch (twilioError) { /* Already logged by sendTwilioMessageWithRetry */ }
        } else {
            console.log("JS Webhook: Cannot send Twilio error message due to missing Twilio client or sender info.");
        }
        return res.status(500).json({ error: "Server configuration error prevented processing." });
    }

    const { Body: incomingMsg, From: fromNumber, To: twilioSystemNumber, ProfileName: profileName } = req.body;
    if (!incomingMsg || !fromNumber) {
        // ... (missing body/from check remains the same) ...
        console.warn("JS Webhook: Missing 'Body' or 'From' in request. Cannot process.");
        return res.status(400).send("Bad Request: Missing required fields.");
    }
    console.log(`JS Webhook: From ${fromNumber} (${profileName || 'N/A'}) to ${twilioSystemNumber}, Msg: "${incomingMsg}"`);

    // --- Twilio Signature Validation ---
    const twilioSignature = req.headers['x-twilio-signature'];
    let webhookUrlForValidation;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const isVercelEnvironment = process.env.NODE_ENV === 'production' || VERCEL_URL;

    if (isVercelEnvironment) {
        console.log("JS Webhook: Vercel environment detected. Using req.headers.host for URL construction.");
        webhookUrlForValidation = `${protocol}://${req.headers.host}${req.url}`;
    } else {
        console.log("JS Webhook: Local/Non-Vercel environment detected. Using local URL construction logic.");
        if (process.env.NEXT_PUBLIC_SITE_URL) {
            let siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
            if (siteUrl.endsWith('/') && req.url.startsWith('/')) {
                siteUrl = siteUrl.slice(0, -1);
            }
            webhookUrlForValidation = `${siteUrl}${req.url}`;
        } else {
            webhookUrlForValidation = `${protocol}://${req.headers.host}${req.url}`;
        }
    }
    const params = req.body;
    // ... (signature validation logging and logic remain the same) ...
    console.log("JS Webhook: ---- Signature Validation Data ----");
    console.log("JS Webhook: TWILIO_AUTH_TOKEN (is set):", !!TWILIO_AUTH_TOKEN);
    console.log("JS Webhook: Received X-Twilio-Signature:", twilioSignature);
    console.log("JS Webhook: Constructed webhookUrl for validation:", webhookUrlForValidation);
    console.log("JS Webhook: process.env.NODE_ENV:", process.env.NODE_ENV);
    console.log("JS Webhook: System VERCEL_URL:", VERCEL_URL);
    console.log("JS Webhook: Env NEXT_PUBLIC_SITE_URL:", process.env.NEXT_PUBLIC_SITE_URL);
    console.log("JS Webhook: Header req.headers.host:", req.headers.host);
    console.log("JS Webhook: Path req.url:", req.url);
    console.log("JS Webhook: DEBUG_SKIP_TWILIO_VALIDATION value:", DEBUG_SKIP_TWILIO_VALIDATION);
    console.log("JS Webhook: ---- End Signature Validation Data ----");

    const forceSkipValidation = DEBUG_SKIP_TWILIO_VALIDATION === "true";
    const shouldValidate = !forceSkipValidation && isVercelEnvironment; // Simplified: always validate on Vercel unless skipped

    if (shouldValidate) {
        if (!TWILIO_AUTH_TOKEN || !twilioSignature) {
            console.warn("JS Webhook: Missing Auth Token or Signature for validation. Failing request.");
            return res.status(401).send('Authentication failed. Missing credentials for validation.');
        }
        try {
            const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, twilioSignature, webhookUrlForValidation, params);
            if (!isValid) {
                console.warn(`JS Webhook: Invalid Twilio signature. URL used: ${webhookUrlForValidation}.`);
                return res.status(403).send('Authentication failed. Invalid Twilio signature.');
            }
            console.log("JS Webhook: Twilio signature validated successfully with URL:", webhookUrlForValidation);
        } catch (validationError) {
            console.error("JS Webhook: Error during Twilio.validateRequest execution:", validationError);
            return res.status(500).send('Server error during signature validation.');
        }
    } else {
        let skipReason = "";
        if (forceSkipValidation) {
            skipReason = "DEBUG_SKIP_TWILIO_VALIDATION is true";
        } else if (!isVercelEnvironment) { // If not on Vercel and not forced skip
            skipReason = "Not a Vercel environment (NODE_ENV not 'production' AND VERCEL_URL not set)";
        } else { // Should not be hit if logic is correct
             skipReason = "Unexpected skip condition";
        }
        console.log(`JS Webhook: SKIPPING Twilio signature validation (${skipReason}).`);
    }

    // ... (Group message handling, Pinecone init, propertyId logic, RAG query, LLM call remain the same) ...
    let userQuery = incomingMsg;
    const isGroupMessage = fromNumber && fromNumber.includes('@g.us');

    if (isGroupMessage) {
        if (!userQuery.toLowerCase().startsWith(GROUP_CHAT_TRIGGER_WORD.toLowerCase())) {
            console.log(`JS Webhook: Group message from ${fromNumber} ignored (no trigger "${GROUP_CHAT_TRIGGER_WORD}").`);
            const twiml = new twilio.twiml.MessagingResponse();
            return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
        }
        userQuery = userQuery.substring(GROUP_CHAT_TRIGGER_WORD.length).trim();
        if (!userQuery) {
            const helpMsg = `You called, ${profileName || 'friend'}! What can I help you with after "${GROUP_CHAT_TRIGGER_WORD}"?`;
            if(twilioClient) { // No need to await this, it's a fire-and-forget response
                 sendTwilioMessageWithRetry({ body: helpMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
            }
            const twiml = new twilio.twiml.MessagingResponse();
            return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
        }
    }

    const pineconeReady = await initializePinecone();
    if (!pineconeReady || !pineconeIndex) {
         console.error("JS Webhook: Pinecone index not available/initialized for RAG.");
         const pineconeErrorMsg = "I'm having trouble accessing the property information right now. Please try again later.";
         if(twilioClient) { // No need to await this
            sendTwilioMessageWithRetry({ body: pineconeErrorMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
         }
         const twiml = new twilio.twiml.MessagingResponse();
         return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
    }

    let propertyId = "Unit4BNelayanReefApartment";
    console.log(`JS Webhook: Using Property ID: ${propertyId} (Currently hardcoded for testing).`);

    let contextChunks = [];
    if (!googleEmbeddingGenAIModel) {
        console.error("JS Webhook: Google Embedding Model not available. Cannot perform RAG query.");
    } else {
        try {
            console.log(`JS Webhook: Getting embedding for query: "${userQuery.substring(0,50)}..." for property "${propertyId}"`);
            const queryEmbedding = await getGoogleEmbeddingForQueryJS(userQuery);
            console.log(`JS Webhook: Querying Pinecone index '${PINECONE_INDEX_NAME}' for property '${propertyId}'.`);
            const queryResponse = await pineconeIndex.query({
                vector: queryEmbedding,
                topK: 3,
                filter: { propertyId: propertyId },
                includeMetadata: true,
            });
            if (queryResponse.matches && queryResponse.matches.length > 0) {
                contextChunks = queryResponse.matches.map(match => match.metadata && match.metadata.text ? match.metadata.text : "");
                console.log(`JS Webhook: Retrieved ${contextChunks.length} context chunks for property '${propertyId}'.`);
            } else {
                console.log(`JS Webhook: No specific context found in Pinecone for property '${propertyId}' and query: "${userQuery.substring(0,50)}"`);
            }
        } catch (error) {
            console.error(`JS Webhook: Error during embedding generation or Pinecone query for property '${propertyId}':`, error.message);
        }
    }

    const contextForLLM = contextChunks.filter(chunk => chunk).join("\n\n---\n\n");
    const systemPrompt = `You are Lucy, a friendly and concise AI assistant for property "${propertyId}".
Answer guest questions based ONLY on the "Property Information Context" provided below.
If the answer isn't in the context, clearly state that you don't have that specific information in the knowledge base for this property. Do not invent or infer information beyond the provided context.
Keep your answers brief and to the point.

Property Information Context for "${propertyId}":
---
${contextForLLM || `No specific information was found in our knowledge base for property "${propertyId}" related to your query.`}
---`;

    let llmResponseText = `I'm sorry, I couldn't find an answer for that regarding property "${propertyId}" in my current knowledge. Please try rephrasing or contact the manager for assistance.`;

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
                temperature: 0.2,
                max_tokens: 300,
            });
            if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
                llmResponseText = completion.choices[0].message.content.trim();
                console.log(`JS Webhook: LLM response received: "${llmResponseText.substring(0,100)}..."`);
            } else {
                console.error("JS Webhook: No response content from OpenRouter:", JSON.stringify(completion, null, 2));
            }
        } catch (error) {
            console.error("JS Webhook: Error calling OpenRouter API:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        }
    }

    // Asynchronously send reply via Twilio REST API using the retry mechanism
    // This function is now async, so we await its completion (or final failure after retries)
    // before sending the 200 OK. This is important because we want to know if it ultimately failed.
    // However, for user experience, we still send 200 OK to Twilio quickly.
    // The `sendTwilioMessageWithRetry` is "fire-and-forget" in the context of the main handler's response to *Twilio's incoming webhook*.
    // We don't make THIS handler await the final outcome of sendTwilioMessageWithRetry before returning 200 OK.
    // The `await` was removed from the IIFE.
    (async () => {
        await sendTwilioMessageWithRetry({
            body: llmResponseText,
            from: TWILIO_WHATSAPP_SENDER,
            to: fromNumber,
        });
    })();


    const twiml = new twilio.twiml.MessagingResponse();
    res.setHeader('Content-Type', 'text/xml');
    console.log("JS Webhook: --- Request Processing Complete. Sending 200 OK (empty TwiML) to Twilio. ---");
    return res.status(200).send(twiml.toString());
}
