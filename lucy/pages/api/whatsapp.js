// lucy/pages/api/whatsapp.js
import twilio from 'twilio'; // Correct: lowercase for default export
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
    twilioClient = new twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN); // Correct: lowercase twilio constructor
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
            await pineconeIndex.describeIndexStats(); // Check connection
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
    if (!googleEmbeddingGenAIModel) {
        console.error("JS Webhook: Google AI embedding model not initialized.");
        throw new Error("Embedding service (Google JS) not configured.");
    }
    try {
        // For retrieval_query, text should be a single string.
        const result = await googleEmbeddingGenAIModel.embedContent(
             text, // Already a string, no need for { content: text, task_type: ... }
             // TaskType here is primarily for models that support multiple task types.
             // For embedding-001, it's specialized. However, being explicit is fine.
             // TaskType.RETRIEVAL_QUERY // This can also be passed as a second argument if the model expects it.
                                       // For embedContent with a single string, explicit TaskType is less common for latest SDKs.
                                       // Check Google SDK docs if `embedContent(string, TaskType)` becomes an issue.
                                       // Often it's `embedContent({ content: string, taskType: TaskType.RETRIEVAL_QUERY })` or within `requests` array.
                                       // Let's stick to what worked for you before. If 'text' is a string and `embedContent(text)` works, that's simpler.
                                       // The SDK is `googleGenerativeAI.getGenerativeModel({ model: embeddingModelId })`
                                       // then `googleEmbeddingGenAIModel.embedContent(text)` if TaskType is implicit or handled by model setup.
                                       // Or `googleEmbeddingGenAIModel.embedContent({ content: text, taskType: TaskType.RETRIEVAL_QUERY })`
                                       // Your existing structure was `embedContent(text, TaskType.RETRIEVAL_QUERY)`
                                       // Let's assume that's how your SDK version/model expects it.
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
    const match = userMessage.match(/for property (\w+)/i);
    if (match && match[1]) {
        return match[1];
    }
    // Default or fallback property ID if not found in the message
    return "default_property"; 
}

// --- Main Handler ---
export default async function handler(req, res) {
    console.log("\n--- JS WhatsApp Webhook Request Received ---");
    console.log("Timestamp:", new Date().toISOString());
    console.log("Request Method:", req.method);
    console.log("Request Body Keys:", req.body ? Object.keys(req.body).join(', ') : 'No Body');

    if (req.method !== 'POST') {
        console.log("JS Webhook: Request is not POST.");
        res.setHeader('Allow', 'POST');
        return res.status(405).end('Method Not Allowed');
    }

    // Basic check for essential clients
    if (!twilioClient || !openrouterLlmClient || !googleEmbeddingGenAIModel || !PINECONE_INDEX_NAME || !PINECONE_API_KEY) { // Check actual client instances
        console.error("JS Webhook: One or more critical environment variables/clients are missing or not initialized.");
        const errorMessage = "I'm having some technical difficulties with my core configuration. Please contact support.";
        if (twilioClient && TWILIO_WHATSAPP_SENDER && req.body && req.body.From) {
             try {
                await twilioClient.messages.create({
                    to: req.body.From,
                    from: TWILIO_WHATSAPP_SENDER,
                    body: errorMessage,
                });
             } catch (twilioError) {
                console.error("JS Webhook: Failed to send config error message via Twilio:", twilioError.message);
             }
        } else {
            console.log("JS Webhook: Cannot send Twilio error message due to missing Twilio client or sender info.");
        }
        // Still send a 500 to Twilio so it knows something went wrong on our end.
        return res.status(500).json({ error: "Server configuration error prevented processing." });
    }

    const { Body: incomingMsg, From: fromNumber, To: twilioSystemNumber, ProfileName: profileName } = req.body;
    if (!incomingMsg || !fromNumber) {
        console.warn("JS Webhook: Missing 'Body' or 'From' in request. Cannot process.");
        return res.status(400).send("Bad Request: Missing required fields.");
    }
    console.log(`JS Webhook: From ${fromNumber} (${profileName || 'N/A'}) to ${twilioSystemNumber}, Msg: "${incomingMsg}"`);

    // --- Twilio Signature Validation ---
    const twilioSignature = req.headers['x-twilio-signature'];
    let webhookUrlForValidation;

    if (VERCEL_URL) { // Provided by Vercel system
        webhookUrlForValidation = `https://${VERCEL_URL}${req.url}`;
    } else if (process.env.NEXT_PUBLIC_SITE_URL) { // User-defined fallback (e.g., for local ngrok if needed)
        let siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
        if (siteUrl.endsWith('/') && req.url.startsWith('/')) {
            siteUrl = siteUrl.slice(0, -1);
        }
        webhookUrlForValidation = `${siteUrl}${req.url}`; // Assuming NEXT_PUBLIC_SITE_URL includes https://
    } else { // Absolute fallback using host header (common for local dev without ngrok specific setup)
        const protocol = req.headers['x-forwarded-proto'] || 'http'; // Prefer x-forwarded-proto if behind a proxy
        webhookUrlForValidation = `${protocol}://${req.headers.host}${req.url}`;
    }

    const params = req.body; // Next.js parsed body object for validation

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
    // Validate if NOT force-skipped AND (we are in 'production' OR on Vercel generally)
    const shouldValidate = !forceSkipValidation && (process.env.NODE_ENV === 'production' || VERCEL_URL);

    if (shouldValidate) {
        if (!TWILIO_AUTH_TOKEN || !twilioSignature) {
            console.warn("JS Webhook: Missing Auth Token or Signature for validation. Failing request.");
            return res.status(401).send('Authentication failed. Missing credentials for validation.');
        }
        try {
            // Corrected: use lowercase 'twilio' for the validateRequest static method
            const isValid = twilio.validateRequest(TWILIO_AUTH_TOKEN, twilioSignature, webhookUrlForValidation, params);
            if (!isValid) {
                console.warn(`JS Webhook: Invalid Twilio signature. URL used: ${webhookUrlForValidation}.`);
                // In production, you might not want to log the signature itself, but params keys can be helpful.
                // console.warn(`JS Webhook: For Signature: ${twilioSignature}. Params (keys): ${Object.keys(params).join(', ')}`);
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
        } else if (process.env.NODE_ENV !== 'production' && !VERCEL_URL) {
            skipReason = "NODE_ENV not 'production' AND VERCEL_URL not set";
        } else {
             skipReason = "Logic error in skip conditions or unexpected environment state"; // Should not happen if logic is correct
        }
        console.log(`JS Webhook: SKIPPING Twilio signature validation (${skipReason}).`);
    }
    // --- End Twilio Signature Validation ---

    let userQuery = incomingMsg;
    const isGroupMessage = fromNumber && fromNumber.includes('@g.us');

    if (isGroupMessage) {
        if (!userQuery.toLowerCase().startsWith(GROUP_CHAT_TRIGGER_WORD.toLowerCase())) {
            console.log(`JS Webhook: Group message from ${fromNumber} ignored (no trigger "${GROUP_CHAT_TRIGGER_WORD}").`);
            const twiml = new twilio.twiml.MessagingResponse(); // Correct: lowercase twilio
            return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
        }
        userQuery = userQuery.substring(GROUP_CHAT_TRIGGER_WORD.length).trim();
        if (!userQuery) {
            const helpMsg = `You called, ${profileName || 'friend'}! What can I help you with after "${GROUP_CHAT_TRIGGER_WORD}"?`;
            if(twilioClient) {
                try {
                    await twilioClient.messages.create({ body: helpMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
                } catch (e) { console.error("JS Webhook: Error sending group trigger help message:", e.message); }
            }
            const twiml = new twilio.twiml.MessagingResponse(); // Correct: lowercase twilio
            return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
        }
    }

    const pineconeReady = await initializePinecone();
    if (!pineconeReady || !pineconeIndex) { // Check pineconeIndex as well
         console.error("JS Webhook: Pinecone index not available/initialized for RAG.");
         const pineconeErrorMsg = "I'm having trouble accessing the property information right now. Please try again later.";
         if(twilioClient) {
            try {
                await twilioClient.messages.create({ body: pineconeErrorMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
            } catch (e) { console.error("JS Webhook: Error sending Pinecone error message:", e.message); }
         }
         const twiml = new twilio.twiml.MessagingResponse(); // Correct: lowercase twilio
         return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
    }

    // Hardcoded property ID for testing - REMOVE OR COMMENT OUT FOR PRODUCTION
    let propertyId = "Unit4BNelayanReefApartment"; 
    console.log(`JS Webhook: Using Property ID: ${propertyId} (Currently hardcoded for testing).`);
    // --- If you want to revert to dynamic property ID extraction: ---
    // let propertyId = extractPropertyIdFromMessage(req.body, userQuery);
    // console.log(`JS Webhook: Extracted Property ID: ${propertyId}`);
    // if (!propertyId || propertyId === "default_property") {
    //      const noPropIdMsg = `To help you best, which property are you asking about? (e.g., "${GROUP_CHAT_TRIGGER_WORD} for property XYZ what is the wifi?")`;
    //      if(twilioClient) {
    //          try {
    //              await twilioClient.messages.create({ body: noPropIdMsg, from: TWILIO_WHATSAPP_SENDER, to: fromNumber });
    //          } catch (e) { console.error("JS Webhook: Error sending no property ID message:", e.message); }
    //      }
    //      const twiml = new twilio.twiml.MessagingResponse(); // Correct lowercase
    //      return res.status(200).setHeader('Content-Type', 'text/xml').send(twiml.toString());
    // }

    let contextChunks = [];
    // Ensure googleEmbeddingGenAIModel is available before trying to use it for embeddings
    if (!googleEmbeddingGenAIModel) {
        console.error("JS Webhook: Google Embedding Model not available. Cannot perform RAG query.");
        // Context will remain empty. LLM will get a message indicating this.
    } else {
        try {
            console.log(`JS Webhook: Getting embedding for query: "${userQuery.substring(0,50)}..." for property "${propertyId}"`);
            const queryEmbedding = await getGoogleEmbeddingForQueryJS(userQuery);
            
            console.log(`JS Webhook: Querying Pinecone index '${PINECONE_INDEX_NAME}' for property '${propertyId}'.`);
            const queryResponse = await pineconeIndex.query({
                vector: queryEmbedding,
                topK: 3, // Get top 3 relevant chunks
                filter: { propertyId: propertyId }, // Filter by propertyId
                includeMetadata: true, // We need the text from metadata
            });

            if (queryResponse.matches && queryResponse.matches.length > 0) {
                contextChunks = queryResponse.matches.map(match => match.metadata && match.metadata.text ? match.metadata.text : "");
                console.log(`JS Webhook: Retrieved ${contextChunks.length} context chunks for property '${propertyId}'.`);
            } else {
                console.log(`JS Webhook: No specific context found in Pinecone for property '${propertyId}' and query: "${userQuery.substring(0,50)}"`);
            }
        } catch (error) {
            console.error(`JS Webhook: Error during embedding generation or Pinecone query for property '${propertyId}':`, error.message);
            // Context will remain empty if an error occurs here.
        }
    }

    const contextForLLM = contextChunks.filter(chunk => chunk).join("\n\n---\n\n"); // Ensure no empty/null chunks
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
        // llmResponseText will remain the default apology.
    } else {
        try {
            console.log(`JS Webhook: Sending prompt to OpenRouter (${llmModelToUse}) for property ${propertyId}. Context length: ${contextForLLM.length}`);
            const completion = await openrouterLlmClient.chat.completions.create({
                model: llmModelToUse,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Guest Question (about property "${propertyId}"): "${userQuery}"` }
                ],
                temperature: 0.2, // Slightly lower for more factual responses
                max_tokens: 300,  // Adjust as needed for typical response length
            });
            if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
                llmResponseText = completion.choices[0].message.content.trim();
                console.log(`JS Webhook: LLM response received: "${llmResponseText.substring(0,100)}..."`);
            } else {
                console.error("JS Webhook: No response content from OpenRouter:", JSON.stringify(completion, null, 2));
                // llmResponseText will remain the default apology.
            }
        } catch (error) {
            console.error("JS Webhook: Error calling OpenRouter API:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
            // llmResponseText will remain the default apology.
        }
    }

    // Asynchronously send reply via Twilio REST API
    // This is "fire and forget" in the sense that we don't wait for it to complete before sending 200 OK to Twilio.
    (async () => {
        if (!twilioClient || !TWILIO_WHATSAPP_SENDER) {
            console.error("JS Webhook: Twilio client or sender not available to send reply.");
            return;
        }
        try {
            await twilioClient.messages.create({
                body: llmResponseText,
                from: TWILIO_WHATSAPP_SENDER,
                to: fromNumber,
            });
            console.log(`JS Webhook: Successfully initiated send of reply to ${fromNumber}.`);
        } catch (sendError) {
            // Log detailed error, including Twilio error code and more_info if available
            let errorDetails = sendError.message;
            if (sendError.code) errorDetails += ` (Code: ${sendError.code})`;
            if (sendError.moreInfo) errorDetails += ` (More Info: ${sendError.moreInfo})`;
            console.error("JS Webhook: Error sending final Twilio message:", errorDetails);
        }
    })();

    // Always respond to Twilio with an empty TwiML to acknowledge receipt of the webhook.
    // The actual reply to the user is sent via the REST API call above.
    const twiml = new twilio.twiml.MessagingResponse(); // Correct: lowercase twilio
    res.setHeader('Content-Type', 'text/xml');
    console.log("JS Webhook: --- Request Processing Complete. Sending 200 OK (empty TwiML) to Twilio. ---");
    return res.status(200).send(twiml.toString());
}
