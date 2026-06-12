const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  const consumerKey = process.env.EPO_CONSUMER_KEY;
  const consumerSecret = process.env.EPO_CONSUMER_SECRET;

  let tokenResult = 'not tested';
  let searchResult = 'not tested';
  let queryUsed = '';

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
    tokenResult = { status: tokenRes.status, has_token: !!tokenData.access_token };

    if (tokenData.access_token) {
      // Test the exact query that epo-search.js would build
      queryUsed = 'ta=CO2 AND ta=propylene AND ta=carbonate';
      const searchRes = await fetch(
        `https://ops.epo.org/3.2/rest-services/published-data/search/biblio?q=${encodeURIComponent(queryUsed)}&Range=1-5`,
        { headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Accept': 'application/json' } }
      );
      const searchData = await searchRes.json();
      const totalCount = parseInt(searchData?.['ops:world-patent-data']?.['ops:biblio-search']?.['@total-result-count'] || '0');
      searchResult = { status: searchRes.status, ok: searchRes.ok, total_results: totalCount, query: queryUsed };
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
