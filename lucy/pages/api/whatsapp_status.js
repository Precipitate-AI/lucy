// pages/api/whatsapp-status.js
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    const { MessageStatus, MessageSid, To, From, ErrorCode } = req.body;
    
    console.log('WhatsApp Status Update:', {
        MessageSid,
        MessageStatus, // sent, delivered, read, failed
        To,
        From,
        ErrorCode
    });
    
    // You can log to a database or monitoring service here
    
    return res.status(200).json({ received: true });
}
