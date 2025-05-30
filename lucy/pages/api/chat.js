//pages/api/chat.js

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
const llmModelToUse = OPENROUTER_MODEL_NAME || "google/gemini-flash-2.5-preview-05-20";

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

// Helper function to create an enhanced query that includes recent context
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

// Helper function to clean LLM responses
function cleanLLMResponse(response) {
    // Remove any lines that look like instructions or reasoning
    const lines = response.split('\n');
    const cleanedLines = lines.filter(line => {
        const lowerLine = line.toLowerCase().trim();
        // Filter out lines that look like internal reasoning
        return !lowerLine.includes('type 1:') && 
               !lowerLine.includes('type 2:') && 
               !lowerLine.includes('type 3:') &&
               !lowerLine.includes('instructions:') &&
               !lowerLine.includes('step ') &&
               !lowerLine.startsWith('context:') &&
               !lowerLine.startsWith('note:') &&
               !lowerLine.includes('property information context') &&
               !lowerLine.includes('critical:') &&
               !lowerLine.includes('prioritize answering') &&
               !line.trim().match(/^[a-z]\.\s/) && // Remove "a. ", "b. ", etc.
               !line.trim().match(/^\d+\.\s.*:$/); // Remove "1. Something:"
    });
    
    let cleanedResponse = cleanedLines.join('\n').trim();
    
    // If the response starts with a quote, remove it
    if (cleanedResponse.startsWith('"') && cleanedResponse.endsWith('"')) {
        cleanedResponse = cleanedResponse.slice(1, -1);
    }
    
    return cleanedResponse;
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
    console.log(`Chat API: Chat history length: ${chatHistory ? chatHistory.length : 0}`);

    let contextChunks = [];
    let hasPropertyContextForLLM = false; 

    if (googleEmbeddingGenAIModel) {
        try {
            // Create context-aware query for better RAG results
            const enhancedQuery = createContextAwareQuery(userQuery, chatHistory);
            console.log(`Chat API: Enhanced query for embedding: "${enhancedQuery.substring(0,100)}..."`);
            
            const queryEmbedding = await getGoogleEmbeddingForQueryJS(enhancedQuery);
            
            console.log(`Chat API: Querying Pinecone index '${PINECONE_INDEX_NAME}' with filter for propertyId: '${propertyId}'`);
            const queryResponse = await pineconeIndex.query({
                vector: queryEmbedding,
                topK: 5, // Increased from 3 to 5 for better context coverage
                filter: { propertyId: propertyId },
                includeMetadata: true,
            });

            if (queryResponse.matches && queryResponse.matches.length > 0) {
                contextChunks = queryResponse.matches
                    .map(match => match.metadata && match.metadata.text ? match.metadata.text.trim() : "")
                    .filter(Boolean); 
                if (contextChunks.length > 0) {
                    hasPropertyContextForLLM = true;
                    console.log(`Chat API: Retrieved ${contextChunks.length} context chunks from Pinecone for property '${propertyId}'.`);
                } else {
                     console.log(`Chat API: Pinecone query for '${propertyId}' returned matches, but no valid text metadata after filtering.`);
                }
            } else {
                console.log(`Chat API: No context chunks found in Pinecone for property '${propertyId}' and query.`);
            }
        } catch (error) {
            console.error(`Chat API: Error during RAG for P-ID '${propertyId}':`, error.message);
            contextChunks = [];
            hasPropertyContextForLLM = false;
        }
    } else {
        console.warn("Chat API: Google Embedding Model not available. Proceeding without RAG context.");
    }

    const contextForLLM = hasPropertyContextForLLM ? contextChunks.join("\n\n---\n\n") : "No specific property information was retrieved for this query.";
    
    // Since we only handle Bali properties
    const cityFromProperty = "Bali";
    console.log(`Chat API: Property location: ${cityFromProperty}. Has RAG context to pass to LLM: ${hasPropertyContextForLLM}`);

    // Enhanced system prompt with conversation awareness
    const systemPrompt = `You are Lucy, a remarkably charming, kind, and warm AI assistant. You have years of experience living in and exploring Bali, making you a true local expert. You are currently assisting a guest at property "${propertyId}". Your goal is to be exceptionally helpful and make their stay wonderful.

IMPORTANT CONVERSATION CONTEXT:
- You are engaged in an ongoing conversation with the guest
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

TYPE 2: GENERAL BALI/LOCATION QUESTION
- This is a question about Bali or specific areas within Bali mentioned in "${userQuery}" (e.g., "things to do in Seminyak", "best restaurants in Canggu", "how to get to the airport?").
- IF the question is Type 2 AND it is NOT successfully answered as a Type 1 question (because context was missing, context said no info retrieved, or context was irrelevant to the question):
   1. Answer the question ("${userQuery}") using your general knowledge as a helpful Bali expert or use internet search results.

TYPE 3: OTHER GENERAL KNOWLEDGE QUESTION
- This is a question not fitting Type 1 or Type 2 (e.g., "what's the capital of France?").
- IF the question is Type 3:
   1. Answer using your general knowledge or internet search results.

IF YOU CANNOT ANSWER or are unsure after considering these types:
- State: "I'm sorry, I'm unsure about that. You might need to ask one of my human teammates in this group chat for more help here. Can I help you with anything else?"

CRITICAL:
- Prioritize answering as Type 1 if the question seems property-specific and the provided context (if any) helps.
- If Type 1 fails due to lack of specific context in the retrieved info, then consider Type 2.
- Always maintain a friendly, polite, and warm conversational tone. Offer a little extra helpful tip or suggestion if appropriate, especially for general Bali questions.
- Be concise but complete.
- Build upon the conversation naturally - don't repeat information you've already provided unless specifically asked.
- PROVIDE ONLY THE FINAL ANSWER, not your reasoning process.`;

    let llmResponseText = `I'm sorry, I encountered an issue processing your request for property "${propertyId}".`;

    if (openrouterLlmClient) {
        try {
            const messagesForLLM = [{ role: "system", content: systemPrompt }];
            
            // Process chat history more intelligently
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
                
                console.log(`Chat API: Added ${recentHistory.length} history messages to context`);
            }
            
            messagesForLLM.push({ role: "user", content: userQuery }); 
            
            console.log(`Chat API: Sending to OpenRouter (${llmModelToUse}). Total messages: ${messagesForLLM.length}, History items included: ${messagesForLLM.length - 2}`);

            const completion = await openrouterLlmClient.chat.completions.create({
                model: llmModelToUse,
                messages: messagesForLLM,
                temperature: 0.3,
                max_tokens: 600, // Increased slightly for conversation context
            });
            
            if (completion.choices && completion.choices[0].message && completion.choices[0].message.content) {
                const rawResponse = completion.choices[0].message.content.trim();
                llmResponseText = cleanLLMResponse(rawResponse);
                console.log(`Chat API: LLM response received: "${llmResponseText.substring(0,100)}..."`);
            } else {
                console.error("Chat API: No valid response content from OpenRouter:", JSON.stringify(completion, null, 2));
                llmResponseText = `I received an unusual response from my AI brain for '${propertyId}'.`;
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
