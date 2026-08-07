// api/patent-analyse.js
// Inventiveness / likelihood-of-grant screening for:
//   - an existing published patent (fetches claims from EPO OPS)
//   - draft claim text
//   - a plain-language idea summary
// Streams a structured JSON assessment via SSE.

const fetch = require('node-fetch');

let _tokenCache = null;
async function getAccessToken(key, secret) {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now) return _tokenCache.token;
  const creds = Buffer.from(`${key}:${secret}`).toString('base64');
  const r = await fetch('https://ops.epo.org/3.2/auth/accesstoken', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`EPO auth ${r.status}`);
  const td = await r.json();
  const exp = (td.expires_in || 1200) - 120;
  _tokenCache = { token: td.access_token, expiresAt: now + exp * 1000 };
  return _tokenCache.token;
}

function txt(o) {
  if (!o) return '';
  if (typeof o === 'string') return o;
  if (o.$) return o.$;
  if (o['#text']) return o['#text'];
  if (Array.isArray(o)) return o.map(txt).filter(Boolean).join(' ');
  // claim-text nodes often nest claim-ref and plain text
  return txt(o['claim-text'] || o['p'] || o['_'] || '');
}
function arr(v) { return !v ? [] : Array.isArray(v) ? v : [v]; }

function normalisePatentnumber(n) {
  return n.replace(/[\s\/\.]/g, '').toUpperCase().replace(/^(EP|WO|US|CN|JP|KR|GB|DE|FR)0+/, '$1');
}

async function epoGet(path, token) {
  const r = await fetch(`https://ops.epo.org/3.2/rest-services${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(`EPO ${r.status} on ${path}`);
  return r.json();
}

async function fetchFullPatent(num, token) {
  const base = `/published-data/publication/epodoc/${num}`;
  const [bib, clm] = await Promise.all([epoGet(`${base}/biblio`, token), epoGet(`${base}/claims`, token)]);

  let title = '', assignee = '', year = null, abstract = '', claims = [];

  if (bib) {
    try {
      const raw = bib?.['ops:world-patent-data']?.['exchange-documents']?.['exchange-document'];
      const d = Array.isArray(raw) ? raw[0] : raw;
      const bl = d?.['bibliographic-data'] || {};
      title = arr(bl['invention-title']).map(t => txt(t)).filter(Boolean)[0] || '';
      const ap = arr(bl?.['parties']?.['applicants']?.['applicant'] || []);
      assignee = ap.filter(a => a?.['@data-format'] === 'epodoc').map(a => txt(a?.['applicant-name']?.['name'])).filter(Boolean)[0] || '';
      const pr = arr(bl?.['publication-reference']?.['document-id'] || []);
      const ep = pr.find(r => r?.['@document-id-type'] === 'epodoc') || pr[0] || {};
      const ds = txt(ep['date']); year = ds ? parseInt(ds.slice(0, 4)) : null;
      const ab = arr(d?.['abstract'] || []);
      abstract = ab.map(a => txt(a?.p || a)).filter(Boolean).join(' ').slice(0, 800);
    } catch {}
  }

  if (clm) {
    try {
      const raw = clm?.['ops:world-patent-data']?.['exchange-documents']?.['exchange-document'];
      const d = Array.isArray(raw) ? raw[0] : raw;
      const cs = d?.['claims'];
      // Claims can be a single language object or an array of language objects
      const clLangs = arr(cs);
      let claimNodes = [];
      for (const lang of clLangs) {
        if (!lang?.['@lang'] || lang?.['@lang'] === 'EN') {
          claimNodes = arr(lang?.['claim'] || lang);
          if (claimNodes.length) break;
        }
      }
      if (!claimNodes.length) {
        // fallback: try all
        claimNodes = clLangs.flatMap(l => arr(l?.['claim'] || []));
      }
      claims = claimNodes.map(c => txt(c?.['claim-text'] || c?.p || c)).filter(Boolean).slice(0, 12);
    } catch {}
  }

  return { title, assignee, year, abstract, claims };
}

async function priorArtSearch(terms, token) {
  const q = terms.map(t => `ta=${t}`).join(' AND ');
  const url = `/published-data/search/biblio?q=${encodeURIComponent(q)}&Range=1-50`;
  const data = await epoGet(url, token).catch(() => null);
  if (!data) return { total: 0, patents: [], query: q };

  const bs = data?.['ops:world-patent-data']?.['ops:biblio-search'];
  const total = parseInt(bs?.['@total-result-count'] || '0');
  const results = bs?.['ops:search-result'];
  const rawEx = results?.['exchange-documents'];
  const exArr = Array.isArray(rawEx) ? rawEx : (rawEx ? [rawEx] : []);
  const docs = exArr.flatMap(ed => arr(ed?.['exchange-document']));

  const patents = docs.slice(0, 10).map(doc => {
    try {
      const bl = doc?.['bibliographic-data'] || {};
      const tl = arr(bl['invention-title']).map(t => txt(t)).filter(Boolean)[0] || 'Untitled';
      const ap = arr(bl?.['parties']?.['applicants']?.['applicant'] || []);
      const as = ap.filter(a => a?.['@data-format'] === 'epodoc').map(a => txt(a?.['applicant-name']?.['name'])).filter(Boolean)[0] || '—';
      const pr = arr(bl?.['publication-reference']?.['document-id'] || []);
      const ep = pr.find(r => r?.['@document-id-type'] === 'epodoc') || pr[0] || {};
      const ds = txt(ep['date']); const yr = ds ? parseInt(ds.slice(0, 4)) : null;
      return { title: tl.slice(0, 120), assignee: as, number: txt(ep['doc-number']) || '', year: yr };
    } catch { return null; }
  }).filter(Boolean);

  return { total, patents, query: q };
}

// Extract 2 key technical terms from free text for EPO prior art search
function extractTerms(text) {
  const stopWords = new Set([
    'claim','claims','wherein','comprising','method','process','system','apparatus',
    'device','step','steps','thereof','said','least','one','two','three','having',
    'using','means','each','that','which','with','from','into','upon','about',
    'over','under','between','through','being','after','before','further',
    'first','second','third','more','less','other','such','this','these',
    'provide','provides','provided','comprising','includes','include','invention'
  ]);
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w) && !/^\d+$/.test(w));
  const freq = {};
  words.forEach(w => freq[w] = (freq[w] || 0) + 1);
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const hasCO2 = /co2|carbon.?dioxide/i.test(text);
  return hasCO2 ? ['CO2', ...top.filter(w => w !== 'co2' && w !== 'carbon' && w !== 'dioxide').slice(0, 1)] : top.slice(0, 2);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const epoKey      = process.env.EPO_CONSUMER_KEY;
  const epoSecret   = process.env.EPO_CONSUMER_SECRET;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { patent_number, claim_text, input_title } = req.body || {};
  if (!patent_number && !claim_text) return res.status(400).json({ error: 'patent_number or claim_text required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    let title = input_title || '';
    let claimsText = claim_text || '';
    let assignee = '', year = null, abstract = '';
    let fetchedFromEPO = false;
    const docType = patent_number ? 'existing_patent' : (claim_text?.toLowerCase().includes('claim') ? 'draft_claims' : 'idea_summary');

    // Step 1 — fetch patent from EPO if number given
    if (patent_number && epoKey && epoSecret) {
      emit({ type: 'status', message: 'Fetching patent from EPO…' });
      try {
        const token = await getAccessToken(epoKey, epoSecret);
        const data = await fetchFullPatent(normalisePatentnumber(patent_number), token);
        if (data.title)   title    = data.title;
        if (data.assignee) assignee = data.assignee;
        if (data.year)    year     = data.year;
        if (data.abstract) abstract = data.abstract;
        if (data.claims.length) {
          claimsText = data.claims.map((c, i) => `Claim ${i + 1}: ${c}`).join('\n\n');
          fetchedFromEPO = true;
        }
      } catch (e) {
        console.warn('EPO patent fetch failed:', e.message);
        emit({ type: 'status', message: 'EPO fetch unavailable — analysing from number only' });
      }
    }

    // Step 2 — prior art search
    let priorArt = { total: 0, patents: [], query: '' };
    if (epoKey && epoSecret) {
      emit({ type: 'status', message: 'Searching EPO for prior art…' });
      try {
        const token = await getAccessToken(epoKey, epoSecret);
        const terms = extractTerms(claimsText || abstract || title || claim_text || '');
        if (terms.length) priorArt = await priorArtSearch(terms, token);
      } catch (e) {
        console.warn('Prior art search failed:', e.message);
      }
    }

    // Emit metadata so the frontend can show it before the stream finishes
    emit({ type: 'meta', data: { patent_number: patent_number || null, title, assignee, year, prior_art_count: priorArt.total, prior_art_query: priorArt.query, fetched_from_epo: fetchedFromEPO } });

    // Step 3 — Claude analysis
    emit({ type: 'status', message: 'Generating inventiveness assessment…' });

    const systemPrompt = `You are a senior European patent attorney and analyst with 20 years' experience in CO2 utilisation chemistry. You assess inventiveness, novelty, and likelihood of grant with precision and honesty. Always note that your assessment is a preliminary AI screening tool, not formal legal advice.`;

    const priorArtLines = priorArt.patents.map(p => `• [${p.number}] "${p.title}" — ${p.assignee} (${p.year})`).join('\n');

    const userPrompt = `Analyse the following for inventiveness, novelty, and likelihood of EPO grant. Be specific — reference prior art numbers where relevant.

INPUT TYPE: ${docType === 'existing_patent' ? 'Published patent' : docType === 'draft_claims' ? 'Draft claims' : 'Invention idea / summary'}
${patent_number ? `Patent number: ${patent_number}` : ''}
${title ? `Title: ${title}` : ''}
${assignee ? `Applicant: ${assignee}` : ''}
${year ? `Year: ${year}` : ''}
${abstract ? `Abstract: ${abstract}` : ''}
${claimsText ? `\nClaims / Description:\n${claimsText.slice(0, 2500)}` : ''}

PRIOR ART (EPO search: ${priorArt.query || 'none'} → ${priorArt.total.toLocaleString()} total matches):
${priorArtLines || 'No prior art retrieved.'}

Return ONLY a valid JSON object, no markdown:

{
  "document_type": "${docType}",
  "title": "invention title",
  "key_claim_elements": ["independent claim element 1", "element 2", "element 3"],
  "prior_art_count": ${priorArt.total},
  "novelty_rating": "high",
  "novelty_assessment": "2-3 sentences grounded in the prior art above. Reference specific patent numbers.",
  "inventive_step_rating": "medium",
  "inventive_step_assessment": "2-3 sentences on non-obviousness. Would a skilled person arrive at this from the prior art?",
  "likelihood_of_grant": 65,
  "likelihood_assessment": "2-3 sentences explaining this score (0-100). Consider: claim scope, prior art density, technical clarity.",
  "whitespace_aspects": [
    {"aspect": "specific technical aspect with filing opportunity", "description": "why this gap exists and how to exploit it", "strength": "high"},
    {"aspect": "second aspect", "description": "explanation", "strength": "medium"}
  ],
  "blocking_prior_art": [
    {"title": "title from the list above", "number": "EP/WO number", "assignee": "assignee name", "year": 2019, "overlap": "high", "reason": "one sentence on claim overlap"}
  ],
  "claim_recommendations": [
    {"type": "broaden", "recommendation": "specific actionable claim drafting suggestion"},
    {"type": "differentiate", "recommendation": "specific aspect to highlight for novelty"}
  ],
  "strategic_summary": "Three sentences: (1) overall patentability verdict, (2) strongest protectable aspects, (3) primary risk or action required.",
  "disclaimer": "Preliminary AI screening only — not legal advice. Consult a qualified patent attorney before filing or commercialisation decisions."
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3000, stream: true, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] })
    });

    if (!response.ok) {
      const err = await response.text();
      emit({ type: 'error', message: `Anthropic ${response.status}: ${err.slice(0, 200)}` });
      res.end(); return;
    }

    let fullText = '';
    let lineBuffer = '';
    try {
      for await (const chunk of response.body) {
        lineBuffer += Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (d === '[DONE]') continue;
          try {
            const ev = JSON.parse(d);
            if (ev.type === 'content_block_delta' && ev.delta?.text) {
              fullText += ev.delta.text;
              emit({ type: 'delta', text: ev.delta.text });
            }
          } catch {}
        }
      }
      // flush any remaining buffer
      if (lineBuffer.startsWith('data:')) {
        const d = lineBuffer.slice(5).trim();
        try {
          const ev = JSON.parse(d);
          if (ev.type === 'content_block_delta' && ev.delta?.text) fullText += ev.delta.text;
        } catch {}
      }
    } catch (streamErr) {
      emit({ type: 'error', message: `Stream error: ${streamErr.message}` });
      res.end(); return;
    }

    const cleaned = fullText.replace(/```json|```/g, '').trim();
    const tryParse = s => { try { return JSON.parse(s); } catch { return null; } };
    const parsed = tryParse(cleaned) || tryParse((cleaned.match(/\{[\s\S]*\}/) || [])[0]);
    if (parsed) { emit({ type: 'complete', data: parsed }); }
    else { emit({ type: 'error', message: 'Could not parse analysis — please try again.' }); }
    res.end();

  } catch (err) {
    emit({ type: 'error', message: err.message });
    res.end();
  }
};
