// pages/api/admin/upload-doc.js
import { put } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: false, // Important for file uploads
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // No authentication check for simplicity in this version

  const propertyId = req.headers['x-property-id'];
  const filename = req.headers['x-filename'] || 'document.txt';

  if (!propertyId) {
    return res.status(400).json({ error: 'Missing X-Property-Id header.' });
  }
  if (!req.body) {
     return res.status(400).json({ error: 'No file data received.' });
  }

  try {
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const blobPath = `${propertyId}/${sanitizedFilename}`;

    const blob = await put(blobPath, req.body, {
      access: 'public', // Or 'private' if you prefer for source docs
      contentType: 'text/plain',
      // addRandomSuffix: false, // Consider setting to false if you want predictable filenames
    });

    console.log(`Admin API: Uploaded ${blobPath}, URL: ${blob.url}`);
    return res.status(200).json({ message: 'File uploaded successfully.', blob });
  } catch (error) {
    console.error('Admin API: File upload error:', error);
    return res.status(500).json({ error: 'Failed to upload file.', details: error.message });
  }
}
