// api/epo-search.js
const fetch = require('node-fetch');

function ensureArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function extractText(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (obj.$) return obj.$;
  if (obj['#text']) return obj['#text'];
  if (Array.isArray(obj)) return obj.map(extractText).join('; ');
  return '';
}

// Pure function words — technical terms like 'catalyst', 'synthesis' are kept
const STOP = new Set([
  'a','an','the','and','or','for','of','in','to','is','are','was','were',
  'it','its','be','been','being','that','this','with','from','into',
  'via','over','under','after','before','through','using','based',
  'have','has','had','will','would','could','should','may','might'
]);

const CO2_TERMS = new Set(['co2','carbon','dioxide']);

// Build an EPO CQL query from the user's keywords.
// Supports explicit AND / OR operators: "methanol AND copper OR formate"
// Without operators, falls back to auto-extracting up to 3 key terms AND'd together.
// Always anchors on CO2 unless the user already mentioned it.
function buildQuery(cpcCodes, keywords, jurisdictions) {
  const jFilter = jurisdictions && jurisdictions.length
    ? ` AND ${jurisdictions.length === 1 ? `pn=${jurisdictions[0]}*` : `(${jurisdictions.map(j => `pn=${j}*`).join(' OR ')})`}`
    : '';

  if (!keywords) return `ta=CO2 AND ta=carbonate${jFilter}`;

  const hasCO2ref = /\bco2\b|\bcarbon.?dioxide\b/i.test(keywords);

  // ── Explicit AND/OR mode ───────────────────────────────────────────────────
  if (/\s+(AND|OR)\s+/i.test(keywords)) {
    const tokens = keywords.split(/\s+(AND|OR)\s+/i);
    const parts = [];
    for (let i = 0; i < tokens.length; i++) {
      if (i % 2 === 1) {
        parts.push(tokens[i].toUpperCase());
      } else {
        const words = tokens[i]
          .replace(/[^\w\s]/g, ' ').split(/\s+/)
          .map(w => w.toLowerCase())
          .filter(w => w.length > 1 && !STOP.has(w));
        if (words.length === 1) parts.push(`ta=${words[0]}`);
        else if (words.length > 1) parts.push(`(${words.map(w => `ta=${w}`).join(' AND ')})`);
      }
    }
    const queryStr = parts.filter(Boolean).join(' ');
    return (hasCO2ref ? queryStr : `ta=CO2 AND ${queryStr}`) + jFilter;
  }

  // ── Free-text mode: auto-extract up to 3 key terms ────────────────────────
  const words = keywords
    .replace(/[^\w\s]/g, ' ').split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length > 2 && !STOP.has(w));
  const techTerms = words.filter(w => !CO2_TERMS.has(w)).slice(0, 3);
  return ['ta=CO2', ...techTerms.map(t => `ta=${t}`)].join(' AND ') + jFilter;
}

function normalisePatent(doc) {
  try {
    const biblio = doc['exchange-document']?.['bibliographic-data'] || doc['bibliographic-data'] || {};
    const titleSrc = biblio['invention-title'] || doc['invention-title'];
    const titles = ensureArray(titleSrc);
    const title = titles.map(t => extractText(t)).filter(Boolean)[0] || 'Untitled';

    const partiesSrc = biblio['parties'] || doc['parties'] || {};
    const appParties = partiesSrc?.['applicants']?.['applicant'] || [];
    const assignees = ensureArray(appParties)
      .filter(a => a?.['@data-format'] === 'epodoc')
      .map(a => extractText(a?.['applicant-name']?.['name']))
      .filter(Boolean);

    const pubRef = biblio['publication-reference']?.['document-id'];
    const pubDocs = ensureArray(pubRef);
    const epodoc = pubDocs.find(d => d?.['@document-id-type'] === 'epodoc') || pubDocs[0] || {};
    const pubDate = extractText(epodoc['date']) || '';
    const pubNumber = extractText(epodoc['doc-number']) || '';
    const year = pubDate ? parseInt(pubDate.slice(0, 4)) : null;

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

    const abstractSection = doc['exchange-document']?.['abstract'] || doc['abstract'] || biblio['abstract'];
    const abstractParts = ensureArray(abstractSection);
    const abstract = abstractParts
      .map(a => extractText(a?.p || a))
      .filter(Boolean)
      .join(' ')
      .slice(0, 400);

    return {
      title: title.slice(0, 150),
      assignee: assignees[0] || 'Unknown',
      year,
      number: pubNumber,
      cpc_codes: cpcs,
      abstract: abstract || '',
      status: year && year < 2004 ? 'expired' : 'active'
    };
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cpc_codes, keywords, range = '1-25', jurisdictions = [] } = req.body || {};

  const consumerKey = process.env.EPO_CONSUMER_KEY;
  const consumerSecret = process.env.EPO_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    return res.status(500).json({ error: 'EPO credentials not configured.' });
  }

  // Auth
  let accessToken;
  try {
    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const tokenRes = await fetch('https://ops.epo.org/3.2/auth/accesstoken', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    });
    if (!tokenRes.ok) throw new Error(`Auth failed: ${tokenRes.status}`);
    const td = await tokenRes.json();
    accessToken = td.access_token;
  } catch (err) {
    return res.status(502).json({ error: 'EPO auth failed', detail: err.message });
  }

  // Search
  const query = buildQuery(cpc_codes, keywords, jurisdictions);
  let searchData;
  try {
    const url = `https://ops.epo.org/3.2/rest-services/published-data/search/biblio?q=${encodeURIComponent(query)}&Range=${range}`;
    const searchRes = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' }
    });
    if (!searchRes.ok) {
      const errText = await searchRes.text();
      return res.status(200).json({ error: `EPO search failed: ${searchRes.status}`, query, detail: errText.slice(0, 300), total_results: 0, patents: [] });
    }
    searchData = await searchRes.json();
  } catch (err) {
    return res.status(200).json({ error: 'EPO request failed', detail: err.message, total_results: 0, patents: [] });
  }

  // Parse
  try {
    const bibSearch = searchData?.['ops:world-patent-data']?.['ops:biblio-search'];
    const results = bibSearch?.['ops:search-result'];
    const totalCount = parseInt(bibSearch?.['@total-result-count'] || '0');

    // exchange-documents can be an array of wrappers or a single wrapper object
    const rawExDocs = results?.['exchange-documents'];
    const exchangeDocsArr = Array.isArray(rawExDocs) ? rawExDocs : (rawExDocs ? [rawExDocs] : []);
    const docList = exchangeDocsArr.length
      ? exchangeDocsArr.flatMap(ed => ensureArray(ed?.['exchange-document']))
      : ensureArray(results?.['exchange-document']);

    const parseErrors = [];
    const patents = docList.map((doc, i) => {
      const r = normalisePatent(doc);
      if (!r) parseErrors.push(i);
      return r;
    }).filter(Boolean);
    const effectiveTotal = Math.max(totalCount, patents.length);

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

    const yearDist = {};
    patents.forEach(p => { if (p.year) yearDist[p.year] = (yearDist[p.year] || 0) + 1; });

    return res.status(200).json({
      total_results: effectiveTotal,
      query_used: query,
      patents,
      top_assignees: topAssignees,
      year_distribution: yearDist,
      retrieved: patents.length,
      _debug: { totalCount, docListLen: docList.length, parseErrors }
    });
  } catch (err) {
    return res.status(200).json({ error: 'Parse failed', detail: err.message, total_results: 0, patents: [], _debug: { stage: 'parse', raw_keys: Object.keys(searchData || {}) } });
  }
};
