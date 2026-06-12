const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  const consumerKey = process.env.EPO_CONSUMER_KEY;
  const consumerSecret = process.env.EPO_CONSUMER_SECRET;
  
  let tokenResult = 'not tested';
  let searchResult = 'not tested';
  
  try {
    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const tokenRes = await fetch('https://ops.epo.org/3.2/auth/accesstoken', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const tokenData = await tokenRes.json();
    tokenResult = { status: tokenRes.status, has_token: !!tokenData.access_token, error: tokenData.error || null };

    if (tokenData.access_token) {
      const searchRes = await fetch(
        'https://ops.epo.org/3.2/rest-services/published-data/search/biblio?q=ta%3Dpropylene+carbonate&Range=1-5',
        { headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/json' } }
      );
      searchResult = { status: searchRes.status, ok: searchRes.ok };
    }
  } catch(e) {
    tokenResult = { error: e.message };
  }

  res.status(200).json({
    has_epo_key: !!consumerKey,
    has_epo_secret: !!consumerSecret,
    epo_auth: tokenResult,
    epo_search: searchResult
  });
};