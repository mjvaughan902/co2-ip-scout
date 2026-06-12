// api/epo-token.js
// Serverless function: exchanges EPO consumer key+secret for a bearer token.
// Called by the frontend before any patent search. Token is valid for 20 minutes.

const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  // CORS headers — allow requests from your Vercel domain and localhost dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const consumerKey    = process.env.EPO_CONSUMER_KEY;
  const consumerSecret = process.env.EPO_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    return res.status(500).json({
      error: 'EPO credentials not configured. Set EPO_CONSUMER_KEY and EPO_CONSUMER_SECRET in Vercel environment variables.'
    });
  }

  try {
    // EPO OPS OAuth2 — client_credentials grant
    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const tokenRes = await fetch('https://ops.epo.org/3.2/auth/accesstoken', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return res.status(tokenRes.status).json({
        error: `EPO auth failed: ${tokenRes.status}`,
        detail: errText
      });
    }

    const tokenData = await tokenRes.json();
    return res.status(200).json({
      access_token: tokenData.access_token,
      expires_in:   tokenData.expires_in || 1200
    });

  } catch (err) {
    return res.status(500).json({ error: 'Token request failed', detail: err.message });
  }
};
