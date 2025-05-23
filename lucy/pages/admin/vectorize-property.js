// pages/api/admin/vectorize-property.js
import { list, del as deleteBlob } from '@vercel/blob'; // del is an alias for delete
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import { getServerSession } from "next-auth/next";
import { authOptions } from "../auth/[...nextauth]";

// --- Env Vars (copy relevant from above) ---
const {
    PINECONE_API_KEY,
    PINECONE_INDEX_NAME,
    GOOGLE_API_KEY,
    GOOGLE_EMBEDDING_MODEL_ID
} = process.env;

// --- Clients (copy relevant initializations) ---
let pinecone;
let pineconeIndex;
// ... (initializePinecone from chat.js or whatsapp.js) ...
const initializePineconeForVectorization = async () => { /* ... */
    if (pineconeIndex) return true;
    if (PINECONE_API_KEY && PINECONE_INDEX_NAME) {
        try {
            if (!pinecone) pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
            pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);
            await pineconeIndex.describeIndexStats();
            console.log("Vectorize API: Pinecone JS client initialized for index:", PINECONE_INDEX_NAME);
            return true;
        } catch (error) {
            console.error("Vectorize API: Pinecone JS client initialization error:", error);
            pineconeIndex = null; return false;
        }
    } else {
        console.error("Vectorize API: CRITICAL: Pinecone API Key or Index Name missing.");
        return false;
    }
};


let googleGenAI;
let googleEmbeddingGenAIModel;
// ... (initialize Google Embedding model from chat.js or whatsapp.js, ensure TaskType is available) ...
if (GOOGLE_API_KEY) { /* ... */
    try {
        googleGenAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
        const embeddingModelId = GOOGLE_EMBEDDING_MODEL_ID || "models/embedding-001";
        googleEmbeddingGenAIModel = googleGenAI.getGenerativeModel({ model: embeddingModelId });
        console.log("Vectorize API: Google AI JS client initialized for embeddings model:", embeddingModelId);
    } catch (error) {
        // ...
    }
} else { /* ... */ }


// Helper for document embedding
async function getGoogleEmbeddingForDocumentChunk(text) {
    if (!googleEmbeddingGenAIModel) throw new Error("Embedding model not ready.");
    // For document chunks, explicitly use TaskType.RETRIEVAL_DOCUMENT if required by your model/SDK
    // This might be googleEmbeddingGenAIModel.embedContent({ content: text, taskType: TaskType.RETRIEVAL_DOCUMENT })
    // Or it might be googleEmbeddingGenAIModel.embedContent(text, TaskType.RETRIEVAL_DOCUMENT)
    // For models like embedding-001, often just passing the text is enough and it infers from context,
    // but being explicit is safer for document embeddings.
    // Let's assume for now it's:
    const result = await googleEmbeddingGenAIModel.embedContent({
        content: text,
        taskType: TaskType.RETRIEVAL_DOCUMENT, // Be explicit for documents
    });
    // Or if your `embedContent(text)` just works for documents too:
    // const result = await googleEmbeddingGenAIModel.embedContent(text);

    const embedding = result.embedding;
    if (embedding && embedding.values) return embedding.values;
    throw new Error("Failed to get document embedding.");
}

// Simple text chunker (replace with a more sophisticated one if needed)
function chunkText(text, chunkSize = 500, overlap = 50) { // characters
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        const end = Math.min(i + chunkSize, text.length);
        chunks.push(text.substring(i, end));
        i += (chunkSize - overlap);
        if (i >= text.length && end < text.length) { // ensure last part is captured
            chunks.push(text.substring(text.length - chunkSize > 0 ? text.length - chunkSize : 0, text.length));
        }
    }
    return chunks.filter(Boolean); // Remove any empty chunks
}


export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const session = await getServerSession(req, res, authOptions);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { propertyId, clearFirst } = req.body; // clearFirst is a boolean to delete existing vectors for this property

    if (!propertyId) {
        return res.status(400).json({ error: 'Missing propertyId.' });
    }

    try {
        console.log(`Vectorize API: Starting vectorization for property: ${propertyId}`);
        await initializePineconeForVectorization();
        if (!pineconeIndex || !googleEmbeddingGenAIModel) {
            console.error("Vectorize API: Pinecone or Embedding model not ready.");
            return res.status(503).json({ error: 'Core services for vectorization not ready.' });
        }
        
        if (clearFirst === true) {
            console.log(`Vectorize API: Clearing existing vectors for propertyId: ${propertyId}`);
            // This deletes ALL vectors with this propertyId. Use with caution.
            // Pinecone Node client v2.x.x+
            await pineconeIndex.deleteMany({ propertyId: propertyId });
            // For older client versions:
            // await pineconeIndex.delete1({ // or delete, check your client version
            //   filter: { propertyId: propertyId },
            //   namespace: "your-namespace" // if you use namespaces
            // });
            console.log(`Vectorize API: Successfully cleared old vectors for ${propertyId}.`);
        }


        const { blobs } = await list({ prefix: `${propertyId}/`, mode: 'folded' }); // Get files for this property
        let totalChunksProcessed = 0;
        let totalVectorsUpserted = 0;

        for (const blob of blobs) {
            if (!blob.pathname.toLowerCase().endsWith('.txt')) {
                console.log(`Vectorize API: Skipping non-txt file: ${blob.pathname}`);
                continue;
            }
            console.log(`Vectorize API: Processing blob: ${blob.pathname}`);
            const response = await fetch(blob.url); // Fetch from Vercel Blob URL
            if (!response.ok) {
                console.error(`Vectorize API: Failed to fetch ${blob.pathname}: ${response.statusText}`);
                continue;
            }
            const fileContent = await response.text();
            const textChunks = chunkText(fileContent); // Implement your chunking logic

            const vectorsToUpsert = [];
            for (let i = 0; i < textChunks.length; i++) {
                const chunk = textChunks[i];
                if (!chunk.trim()) continue;

                try {
                    const embedding = await getGoogleEmbeddingForDocumentChunk(chunk);
                    vectorsToUpsert.push({
                        id: `${blob.pathname}-chunk-${i}`, // Unique ID for each chunk
                        values: embedding,
                        metadata: {
                            text: chunk,
                            propertyId: propertyId,
                            source: blob.pathname,
                            chunkIndex: i
                        },
                    });
                    totalChunksProcessed++;
                } catch (embedError) {
                    console.error(`Vectorize API: Failed to embed chunk ${i} from ${blob.pathname}:`, embedError.message);
                }
            }

            if (vectorsToUpsert.length > 0) {
                // Batch upsert to Pinecone (adjust batch size as needed)
                const BATCH_SIZE = 100;
                for (let i = 0; i < vectorsToUpsert.length; i += BATCH_SIZE) {
                    const batch = vectorsToUpsert.slice(i, i + BATCH_SIZE);
                    await pineconeIndex.upsert(batch);
                    totalVectorsUpserted += batch.length;
                    console.log(`Vectorize API: Upserted batch of ${batch.length} vectors for ${blob.pathname}.`);
                }
            }
        }
        console.log(`Vectorize API: Finished vectorization for ${propertyId}. Processed ${totalChunksProcessed} chunks, upserted ${totalVectorsUpserted} vectors.`);
        return res.status(200).json({
            message: `Vectorization complete for ${propertyId}.`,
            chunksProcessed: totalChunksProcessed,
            vectorsUpserted: totalVectorsUpserted
        });

    } catch (error) {
        console.error(`Vectorize API: Error during vectorization for ${propertyId}:`, error);
        return res.status(500).json({ error: 'Vectorization process failed.', details: error.message });
    }
}
