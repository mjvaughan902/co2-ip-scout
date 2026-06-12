// api/epo-search.js
// Serverless proxy: receives a search request from the frontend,
// calls EPO OPS with a valid bearer token, normalises the response,
// and returns structured patent data.

const fetch = require('node-fetch');

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function extractText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.$) return obj.$;  // EPO text nodes often use $ for content
  if (obj['#text']) return obj['#text'];
  if (Array.isArray(obj)) return obj.map(extractText).join('; ');
  return '';
}

// Build EPO CQL query — keyword-only for reliability
// CPC codes are too granular and often return zero; keywords against title+abstract
// is more robust and still returns highly relevant results.
function buildQuery(cpcCodes, keywords) {
  const parts = [];

  if (keywords) {
    // Extract the most distinctive 4-6 words, clean for CQL
    const kw = keywords
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !['from','with','that','this','into','using','based','have','been','will','and','for','the'].includes(w.toLowerCase()))
      .slice(0, 5);
    if (kw.length > 0) {
      // Use OR for broader coverage — EPO CQL is strict with AND
      parts.push(`ta=(${kw.join(' OR ')})`);
    }
  }

  if (cpcCodes && cpcCodes.length > 0 && parts.length === 0) {
    // Only fall back to CPC if no keywords
    const codes = cpcCodes
      .slice(0, 2)
      .map(c => c.split(' ')[0].replace(/[^A-Z0-9/]/gi, ''))
      .filter(Boolean);
    if (codes.length > 0) {
      const cpcPart = codes.map(c => `cpc=${c}`).join(' OR ');
      parts.push(`(${cpcPart})`);
    }
  }

  return parts.length > 0 ? parts.join(' AND ') : 'ta=CO2 utilisation';
}

// Normalise a single EPO patent result into a clean object
function normalisePatent(doc) {
  try {
    const biblio  = doc['exchange-document']?.['bibliographic-data'] || doc['bibliographic-data'] || {};
    const titles  = ensureArray(biblio['invention-title']);
    const title   = titles.map(t => extractText(t)).filter(Boolean)[0] || 'Untitled';

    // Applicants / assignees
    const appParties = biblio['parties']?.['applicants']?.['applicant'] || [];
    const assignees  = ensureArray(appParties)
      .map(a => extractText(a?.['applicant-name']?.['name']))
      .filter(Boolean);

    // Publication date and number
    const pubRef    = biblio['publication-reference']?.['document-id'];
    const pubDocs   = ensureArray(pubRef);
    const epodoc    = pubDocs.find(d => d?.['@document-id-type'] === 'epodoc') || pubDocs[0] || {};
    const pubDate   = extractText(epodoc['date']) || '';
    const pubNumber = extractText(epodoc['doc-number']) || '';
    const year      = pubDate ? parseInt(pubDate.slice(0, 4)) : null;

    // CPC classifications
    const cpcSection = biblio['patent-classifications']?.['patent-classification'] || [];
    const cpcs = ensureArray(cpcSection)
      .map(c => [
        extractText(c?.section),
        extractText(c?.class),
        extractText(c?.subclass),
        extractText(c?.['main-group']),
        '/',
        extractText(c?.subgroup)
      ].join('').replace(/\s/g, ''))
      .filter(c => c.length > 2)
      .slice(0, 3);

    // Abstract
    const abstractSection = doc['exchange-document']?.['abstract'] || doc['abstract'];
    const abstractParts   = ensureArray(abstractSection);
    const abstract        = abstractParts
      .map(a => extractText(a?.p || a))
      .filter(Boolean)
      .join(' ')
      .slice(0, 400);

    return {
      title:     title.slice(0, 150),
      assignee:  assignees[0] || 'Unknown',
      year,
      number:    pubNumber,
      cpc_codes: cpcs,
      abstract:  abstract || 'Abstract not available.',
      status:    year && year < 2004 ? 'expired' : 'active'  // simplified heuristic
    };
  } catch {
    return null;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { cpc_codes, keywords, range = '1-25' } = req.body || {};

  if (!cpc_codes?.length && !keywords) {
    return res.status(400).json({ error: 'Provide at least cpc_codes or keywords.' });
  }

  // 1. Get a fresh EPO bearer token
  const consumerKey    = process.env.EPO_CONSUMER_KEY;
  const consumerSecret = process.env.EPO_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    return res.status(500).json({ error: 'EPO credentials not configured on server.' });
  }

  let accessToken;
  try {
    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const tokenRes = await fetch('https://ops.epo.org/3.2/auth/accesstoken', {
      method:  'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    'grant_type=client_credentials'
    });
    if (!tokenRes.ok) throw new Error(`Auth failed: ${tokenRes.status}`);
    const td = await tokenRes.json();
    accessToken = td.access_token;
  } catch (err) {
    return res.status(502).json({ error: 'EPO authentication failed', detail: err.message });
  }

  // 2. Build and execute the CQL search
  const query = buildQuery(cpc_codes, keywords);

  let searchData;
  try {
    const searchUrl = `https://ops.epo.org/3.2/rest-services/published-data/search/biblio?q=${encodeURIComponent(query)}&Range=${range}`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      return res.status(searchRes.status).json({
        error: `EPO search failed: ${searchRes.status}`,
        query,
        detail: errText.slice(0, 500)
      });
    }

    searchData = await searchRes.json();
  } catch (err) {
    return res.status(502).json({ error: 'EPO search request failed', detail: err.message });
  }

  // 3. Parse results
  try {
    const results     = searchData?.['ops:world-patent-data']?.['ops:biblio-search']?.['ops:search-result'];
    const totalCount  = parseInt(
      searchData?.['ops:world-patent-data']?.['ops:biblio-search']?.['@total-result-count'] || '0'
    );
    const docList     = ensureArray(results?.['exchange-documents']?.['exchange-document'] || results?.['exchange-document']);
    const patents     = docList.map(normalisePatent).filter(Boolean);

    // Derive assignee frequency
    const assigneeMap = {};
    patents.forEach(p => {
      if (p.assignee && p.assignee !== 'Unknown') {
        assigneeMap[p.assignee] = (assigneeMap[p.assignee] || 0) + 1;
      }
    });
    const topAssignees = Object.entries(assigneeMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }));

    // Year distribution for trend
    const yearDist = {};
    patents.forEach(p => { if (p.year) yearDist[p.year] = (yearDist[p.year] || 0) + 1; });

    return res.status(200).json({
      total_results: totalCount,
      query_used:    query,
      patents,
      top_assignees: topAssignees,
      year_distribution: yearDist,
      retrieved: patents.length
    });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to parse EPO response', detail: err.message });
  }
};
