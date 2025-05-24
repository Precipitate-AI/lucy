import { Pinecone } from '@pinecone-database/pinecone';
import OpenAI from 'openai'; // For OpenRouter
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai'; // For Google Embeddings

// --- Environment Variables ---
const {
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

// --- Initialize Clients (remains the same) ---
let pinecone;
let pineconeIndex;
const initializePinecone = async () => {
    if (pineconeIndex) return true;
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("Chat API: Pinecone JS client initialized for index:", PINECONE_INDEX_NAME);
            return true;
        } catch (error) {
            console.error("Chat API: Pinecone JS client initialization error:", error);
            pineconeIndex = null; return false;
        }
    } else {
        console.error("Chat API: CRITICAL: Pinecone API Key or Index Name missing.");
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
            "X-Title": OPENROUTER_APP_NAME || "LucyWebChat",
        },
    });
} else {
    console.error("Chat API: CRITICAL: OPENROUTER_API_KEY not set.");
}
const llmModelToUse = OPENROUTER_MODEL_NAME || "google/gemini-flash-1.5";

let googleGenAI;
let googleEmbeddingGenAIModel;
if (GOOGLE_API_KEY) {
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("Chat API: Google AI JS client initialized for embeddings model:", embeddingModelId);
    } catch (error) {
        console.error("Chat API: Error initializing Google AI JS client for embeddings:", error);
        googleEmbeddingGenAIModel = null;
    }
} else {
    console.error("Chat API: CRITICAL: GOOGLE_API_KEY not set.");
}

async function getGoogleEmbeddingForQueryJS(text) {
    if (!googleEmbeddingGenAIModel) {
        console.error("Chat API: Google AI embedding model not initialized.");
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
            console.error("Chat API: Unexpected embedding format from Google AI:", JSON.stringify(result, null, 2));
            throw new Error("Failed to extract embedding values from Google AI JS response.");
        }
    } catch (error) {
        console.error("Chat API: Error getting embedding for query from Google AI:", error.message, error.stack);
        throw error;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { query: userQuery, propertyId, chatHistory } = req.body;

    if (!userQuery || !propertyId) {
        return res.status(400).json({ error: 'Missing query or propertyId in request body.' });
    }

    if (!openrouterLlmClient || !googleEmbeddingGenAIModel || !PINECONE_API_KEY || !PINECONE_INDEX_NAME) {
        console.error("Chat API: One or more critical services are not initialized.");
        return res.status(503).json({ error: "Service Temporarily Unavailable: Core components not ready." });
    }
    
    const pineconeReady = await initializePinecone();
    if (!pineconeReady || !pineconeIndex) {
        console.error("Chat API: Pinecone index not available after initialization attempt.");
        return res.status(503).json({ error: "Service Temporarily Unavailable: Knowledge base connection failed." });
    }

    console.log(`Chat API: Received query for property "${propertyId}": "${userQuery}"`);

    let contextChunks = [];
    let hasPropertyContextForLLM = false; 

    if (googleEmbeddingGenAIModel) {
        try {
            console.log(`Chat API: Generating embedding for query: "${userQuery.substring(0,50)}..."`);
            const queryEmbedding = await getGoogleEmbeddingForQueryJS(userQuery);
            
            console.log(`Chat API: Querying Pinecone index '${PINECONE_INDEX_NAME}' with filter for propertyId: '${propertyId}'`);
            const queryResponse = await pineconeIndex.query({
                vector: queryEmbedding,
                topK: 3, 
                filter: { propertyId: propertyId },
                includeMetadata: true,
            });

            if (queryResponse.matches && queryResponse.matches.length > 0) {
                contextChunks = queryResponse.matches
                    .map(match => match.metadata && match.metadata.text ? match.metadata.text.trim() : "")
                    .filter(Boolean); 
                if (contextChunks.length > 0) {
                    hasPropertyContextForLLM = true; // If Pinecone returns anything,flag it for the LLM prompt
                    console.log(`Chat API: Retrieved ${contextChunks.length} context chunks from Pinecone for property '${propertyId}'.`);
                } else {
                     console.log(`Chat API: Pinecone query for '${propertyId}' returned matches, but no valid text metadata after filtering.`);
                }
            } else {
                console.log(`Chat API: No context chunks found in Pinecone for property '${propertyId}' and query.`);
            }
        } catch (error) {
            console.error(`Chat API: Error during RAG for P-ID '${propertyId}':`, error.message);
            // Ensure context is empty and flag is false if RAG fails
            contextChunks = [];
            hasPropertyContextForLLM = false;
        }
    } else {
        console.warn("Chat API: Google Embedding Model not available. Proceeding without RAG context.");
    }

    const contextForLLM = hasPropertyContextForLLM ? contextChunks.join("\n\n---\n\n") : "No specific property information was retrieved for this query.";
    
    let cityFromProperty = "the current location";
    const pidLower = propertyId.toLowerCase();
    if (pidLower.includes("bali") || pidLower.includes("nelayan") || pidLower.includes("seminyak") || pidLower.includes("ubud") || pidLower.includes("canggu")) {
        cityFromProperty = "Bali";
    } else if (pidLower.includes("dubai")) {
        cityFromProperty = "Dubai";
    }
    console.log(`Chat API: Property's city: ${cityFromProperty}. Has RAG context to pass to LLM: ${hasPropertyContextForLLM}`);

    const systemPrompt = `You are Lucy, a multi-skilled AI assistant for guests at property "${propertyId}".
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
    3. If the "Property Information Context" (especially if it's not "No specific property information...") DOES NOT contain the answer for "{propertyId}", then state: "I checked the information for property '${propertyId}', but I couldn't find specific details on that particular topic." DO NOT use your general knowledge for Type 1 questions if the context is missing the answer or says no info was retrieved.

TYPE 2: GENERAL CITY/LOCATION QUESTION
- This is a question about ${cityFromProperty} (the city where "${propertyId}" is located) or ANOTHER city/location explicitly mentioned in "${userQuery}" (e.g., "things to do in ${cityFromProperty}", "best restaurants in Uluwatu", "how to get to Dubai Mall?").
- IF the question is Type 2 AND it is NOT successfully answered as a Type 1 question (because context was missing, context said no info retrieved, or context was irrelevant to the question):
    1. Answer the question ("${userQuery}") using your general knowledge as a helpful city/travel expert.
    2. When doing so, clearly state that you are providing general information, for example: "Regarding ${cityFromProperty}, generally..." or "As general information for a place like Uluwatu..."

TYPE 3: OTHER GENERAL KNOWLEDGE QUESTION
- This is a question not fitting Type 1 or Type 2 (e.g., "what's the capital of France?").
- IF the question is Type 3:
    1. Answer using your general knowledge.

IF YOU CANNOT ANSWER or are unsure after considering these types:
- State: "I'm sorry, I don't have information on that topic right now."

CRITICAL:
- Prioritize answering as Type 1 if the question seems property-specific and the provided context (if any) helps.
- If Type 1 fails due to lack of specific context in the retrieved info, then consider Type 2.
- Be concise.`;


    let llmResponseText = `I'm sorry, I encountered an issue processing your request for property "${propertyId}".`;

    if (openrouterLlmClient) {
        try {
            const messagesForLLM = [{ role: "system", content: systemPrompt }];
            
            if (Array.isArray(chatHistory) && chatHistory.length > 0) {
                chatHistory.forEach(msg => {
                    let role = 'user';
                    if (msg.sender === 'bot' || msg.sender === 'assistant') role = 'assistant';
                    else if (msg.sender === 'user') role = 'user';
                    if (role === 'user' || role === 'assistant') {
                         messagesForLLM.push({ role: role, content: msg.text });
                    }
                });
            }
            messagesForLLM.push({ role: "user", content: userQuery }); 
            
            console.log(`Chat API: Sending final prompt to OpenRouter (${llmModelToUse}). System prompt length: ${systemPrompt.length}. History items: ${chatHistory ? chatHistory.length : 0}`);
            // For intense debugging:
            // console.log("DEBUG: Chat API Final System Prompt:\n", systemPrompt); 

            const completion = await openrouterLlmClient.chat.completions.create({
                model: llmModelToUse,
                messages: messagesForLLM,
                temperature: 0.2, // Very low temperature to follow strict instructions
                max_tokens: 450,
            });
            if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
                llmResponseText = completion.choices[0].message.content.trim();
                console.log(`Chat API: LLM response received: "${llmResponseText.substring(0,100)}..."`);
            } else {
                console.error("Chat API: No valid response content from OpenRouter:", JSON.stringify(completion, null, 2));
                llmResponseText = `I received an unusual response from my AI brain for '${propertyId}'.`
            }
        } catch (error) {
            console.error("Chat API: Error calling OpenRouter API:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message, error.stack);
            llmResponseText = `Sorry, I'm having trouble connecting to my AI brain right now for '${propertyId}'. Please try again.`;
        }
    } else {
         console.error("Chat API: OpenRouter client not initialized. Cannot create LLM completion.");
         llmResponseText = `My connection to the AI brain is offline for '${propertyId}'. Please inform support.`;
    }

    return res.status(200).json({ response: llmResponseText });
}
