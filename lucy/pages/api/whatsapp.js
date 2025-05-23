// lucy/pages/api/whatsapp.js
import { Twilio } from 'twilio';
import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai'; // For OpenRouter
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';

// --- Environment Variables ---
const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_WHATSAPP_SENDER,
    PINECONE_API_KEY,
    PINECONE_INDEX_NAME,
    OPENROUTER_API_KEY,
    OPENROUTER_GEMINI_MODEL,
    OPENROUTER_SITE_URL,
    OPENROUTER_APP_NAME,
    GOOGLE_API_KEY,
    GOOGLE_EMBEDDING_MODEL_ID,
    // This is the Vercel System Environment Variable that provides the full URL for the current deployment.
    // It's generally more reliable than NEXT_PUBLIC_SITE_URL for preview/branch URLs.
    // Ensure it's available to your function (Vercel usually makes it available).
    VERCEL_URL, // e.g., lucy-git-test-precipitate.vercel.app (without https://)
    DEBUG_SKIP_TWILIO_VALIDATION // Set this to "true" (as a string) in Vercel env vars to temporarily skip validation
} = process.env;

const GROUP_CHAT_TRIGGER_WORD = "@lucy";

// --- Initialize Clients ---
let twilioClient;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
    console.error("CRITICAL: Twilio Account SID or Auth Token not set.");
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
const llmModelToUse = OPENROUTER_GEMINI_MODEL || "google/gemini-pro";

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
    // ... (same as your provided version, no changes needed here)
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

function extractPropertyIdFromMessage(twilioRequestBody, userMessage) {
    // ... (same as your provided version, no changes needed here for now)
    // For testing, you might still want to hardcode this temporarily if it's causing issues.
    const match = userMessage.match(/for property (\w+)/i);
    if (match && match[1]) {
        return match[1];
    }
     // FOR TESTING: return "Unit4BNelayanReefApartment";
    return "default_property";
}

// --- Main Handler ---
export default async function handler(req, res) {
    console.log("\n--- JS WhatsApp Webhook Request Received ---");
    console.log("Timestamp:", new Date().toISOString());
    console.log("Request Method:", req.method);
    // Only log body keys for security, not full body initially.
    console.log("Request Body Keys:", req.body ? Object.keys(req.body).join(', ') : 'No Body');
    // console.log("Full Request Headers:", JSON.stringify(req.headers, null, 2)); // Can be very verbose

    if (req.method !== 'POST') {
        console.log("JS Webhook: Request is not POST.");
        res.setHeader('Allow', 'POST');
        return res.status(405).end('Method Not Allowed');
    }

    // Basic check for essential clients
    if (!twilioClient || !OPENROUTER_API_KEY || !GOOGLE_API_KEY || !PINECONE_API_KEY || !PINECONE_INDEX_NAME ) {
        // ... (same critical client check as your version)
        console.error("JS Webhook: One or more critical environment variables/clients are missing.");
        if (twilioClient && TWILIO_WHATSAPP_SENDER && req.body && req.body.From){
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

    const { Body: incomingMsg, From: fromNumber, To: twilioSystemNumber, ProfileName: profileName } = req.body;
    console.log(`JS Webhook: From ${fromNumber} (${profileName || 'N/A'}) to ${twilioSystemNumber}, Msg: "${incomingMsg}"`);

    // --- Twilio Signature Validation ---
    const twilioSignature = req.headers['x-twilio-signature'];
    let webhookUrlForValidation;

    // Construct the URL Vercel uses. VERCEL_URL provides the hostname.
    // req.url contains the path and query string (e.g., /api/whatsapp)
    if (VERCEL_URL) {
        webhookUrlForValidation = `https://${VERCEL_URL}${req.url}`;
    } else if (process.env.NEXT_PUBLIC_SITE_URL) { // Fallback to NEXT_PUBLIC_SITE_URL if VERCEL_URL isn't there
        // Ensure NEXT_PUBLIC_SITE_URL does not have a trailing slash if req.url starts with one.
        let siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
        if (siteUrl.endsWith('/') && req.url.startsWith('/')) {
            siteUrl = siteUrl.slice(0, -1);
        }
        webhookUrlForValidation = siteUrl + req.url;
    } else {
        // Fallback for local dev or if other vars aren't set - may not work on Vercel for validation
        webhookUrlForValidation = `https://${req.headers.host}${req.url}`;
    }

    const params = req.body; // Next.js parsed body object

    console.log("JS Webhook: ---- Signature Validation Data ----");
    console.log("JS Webhook: TWILIO_AUTH_TOKEN (is set):", !!TWILIO_AUTH_TOKEN);
    console.log("JS Webhook: Received X-Twilio-Signature:", twilioSignature);
    console.log("JS Webhook: Constructed webhookUrl for validation:", webhookUrlForValidation);
    // console.log("JS Webhook: Params for validation (full body):", JSON.stringify(params, null, 2)); // Can be verbose
    console.log("JS Webhook: process.env.NODE_ENV:", process.env.NODE_ENV);
    console.log("JS Webhook: System VERCEL_URL:", VERCEL_URL);
    console.log("JS Webhook: Env NEXT_PUBLIC_SITE_URL:", process.env.NEXT_PUBLIC_SITE_URL);
    console.log("JS Webhook: Header req.headers.host:", req.headers.host);
    console.log("JS Webhook: Path req.url:", req.url);
    console.log("JS Webhook: DEBUG_SKIP_TWILIO_VALIDATION value:", DEBUG_SKIP_TWILIO_VALIDATION);
    console.log("JS Webhook: ---- End Signature Validation Data ----");

    // Check for the debug flag to skip validation
    const skipValidation = DEBUG_SKIP_TWILIO_VALIDATION === "true";

    if (!skipValidation && (process.env.NODE_ENV === 'production' || VERCEL_URL) ) { // Always validate in Vercel prod-like envs unless skipped
        if (!TWILIO_AUTH_TOKEN || !twilioSignature) {
            console.warn("JS Webhook: Missing Auth Token or Signature for validation. Failing request.");
            return res.status(401).send('Authentication failed. Missing credentials for validation.'); // Use 401 more explicitly
        }
        try {
            const isValid = Twilio.validateRequest(TWILIO_AUTH_TOKEN, twilioSignature, webhookUrlForValidation, params);
            if (!isValid) {
                console.warn(`JS Webhook: Invalid Twilio signature. URL used: ${webhookUrlForValidation}. For Signature: ${twilioSignature}. Params (keys): ${Object.keys(params).join(', ')}`);
                return res.status(403).send('Authentication failed. Invalid Twilio signature.');
            }
            console.log("JS Webhook: Twilio signature validated successfully with URL:", webhookUrlForValidation);
        } catch (validationError) {
            console.error("JS Webhook: Error during Twilio.validateRequest execution:", validationError);
            return res.status(500).send('Server error during signature validation.');
        }
    } else {
        console.log("JS Webhook: SKIPPING Twilio signature validation (NODE_ENV not 'production' OR VERCEL_URL not set OR DEBUG_SKIP_TWILIO_VALIDATION is true).");
    }
    // --- End Twilio Signature Validation ---

    // ... (rest of your logic: userQuery, group message handling, Pinecone init, etc.)
    let userQuery = incomingMsg;
    const isGroupMessage = fromNumber && fromNumber.includes('@g.us');

    if (isGroupMessage) {
        if (!incomingMsg.toLowerCase().startsWith(GROUP_CHAT_TRIGGER_WORD.toLowerCase())) {
            console.log(`JS Webhook: Group message ignored (no trigger "${GROUP_CHAT_TRIGGER_WORD}").`);
            const twiml = new Twilio.twiml.MessagingResponse();
            return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
        }
        userQuery = incomingMsg.substring(GROUP_CHAT_TRIGGER_WORD.length).trim();
        if (!userQuery) {
            const helpMsg = `You called, ${profileName || 'friend'}! What can I help you with after "${GROUP_CHAT_TRIGGER_WORD}"?`;
            if(twilioClient) twilioClient.messages.create({ body: helpMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
            const twiml = new Twilio.twiml.MessagingResponse();
            return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
        }
    }

    const pineconeReady = await initializePinecone();
    if (!pineconeReady || !pineconeIndex) {
         console.error("JS Webhook: Pinecone index not available for RAG.");
         const pineconeErrorMsg = "I'm having trouble accessing the property information right now. Please try again later.";
         if(twilioClient) twilioClient.messages.create({ body: pineconeErrorMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
         const twiml = new Twilio.twiml.MessagingResponse();
         return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
    }

    // const propertyId = extractPropertyIdFromMessage(req.body, userQuery);
    // HARDCODE propertyId for focused testing of RAG pipeline + Twilio validation
    const propertyId = "Unit4BNelayanReefApartment"; // <<<---- HARDCODED FOR TESTING. Make sure this ID exists in your Pinecone.
    console.log(`JS Webhook: HARDCODED Property ID for testing: ${propertyId}`);
    // if (!propertyId || propertyId === "default_property") { //Temporarily bypass original propertyId check logic
    //      const noPropIdMsg = `To help you best, which property are you asking about? (e.g., "${GROUP_CHAT_TRIGGER_WORD} for property XYZ what is the wifi?")`;
    //      if(twilioClient) twilioClient.messages.create({ body: noPropIdMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
    //      const twiml = new Twilio.twiml.MessagingResponse();
    //      return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
    // }
    // console.log(`JS Webhook: Processing for Property ID: ${propertyId}`);


    let contextChunks = [];
    if (!googleEmbeddingGenAIModel) { // Added check before trying to use it
        console.error("JS Webhook: Google Embedding Model not available, cannot perform RAG.");
        // Fall through, context will be empty, LLM will respond based on that.
    } else {
        try {
            console.log(`JS Webhook: Getting embedding for query: "${userQuery.substring(0,50)}..."`);
            const queryEmbedding = await getGoogleEmbeddingForQueryJS(userQuery);
            console.log(`JS Webhook: Querying Pinecone for property '${propertyId}'.`);
            const queryResponse = await pineconeIndex.query({
                vector: queryEmbedding,
                topK: 3,
                filter: { propertyId: propertyId },
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
        }
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

    // Send reply via Twilio
    (async () => {
        if (!twilioClient) {
            console.error("JS Webhook: Twilio client not available to send reply.");
            return;
        }
        try {
            await twilioClient.messages.create({
                body: llmResponseText,
                from: TWILIO_WHATSAPP_SENDER,
                to: fromNumber,
            });
            console.log(`JS Webhook: Successfully sent reply to ${fromNumber}.`);
        } catch (sendError) {
            console.error("JS Webhook: Error sending final Twilio message:", sendError.message, sendError.code, sendError.moreInfo);
        }
    })();

    const twiml = new Twilio.twiml.MessagingResponse();
    res.setHeader('Content-Type', 'text/xml');
    console.log("JS Webhook: --- Request Processing Complete. Sending 200 OK to Twilio. ---");
    return res.status(200).send(twiml.toString());
}
