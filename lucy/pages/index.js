// pages/index.js
import Head from 'next/head';

export default function Home() {
  return (
    <div>
      <Head>
        <title>Lucy Bot Status</title>
        <meta name="description" content="Lucy WhatsApp Bot" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '20px', fontFamily: 'Arial, sans-serif' }}>
        <h1>Lucy WhatsApp Bot</h1>
        <p>
          The API endpoint for WhatsApp messages is at <code>/api/webhook</code>.
        </p>
        <p>
          Configure this webhook URL in your Twilio Sandbox settings for WhatsApp.
        </p>
        <p style={{ marginTop: '20px', padding: '10px', border: '1px solid #ccc', borderRadius: '5px', backgroundColor: '#f9f9f9' }}>
          <strong>Status:</strong> If you see this page, the Next.js app is running.
        </p>
      </main>
    </div>
  );
}
