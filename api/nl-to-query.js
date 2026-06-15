// api/nl-to-query.js
// Translates a natural-language technology description into EPO CQL search terms.
// Returns { epo_query, search_terms, interpretation } — fast, non-streaming.
const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { description, jurisdictions = [] } = req.body || {};
  if (!description) return res.status(400).json({ error: 'description required' });

  // If description looks like an explicit CQL query already (has ta= or AND/OR operators),
  // pass it through without translation.
  if (/\bta=|cpc=/.test(description)) {
    return res.status(200).json({
      epo_query: description,
      search_terms: [],
      interpretation: description,
      passthrough: true
    });
  }

  const jFilter = jurisdictions.length
    ? ` AND ${jurisdictions.length === 1
        ? `pn=${jurisdictions[0]}*`
        : `(${jurisdictions.map(j => `pn=${j}*`).join(' OR ')})`}`
    : '';

  const prompt = `You are an expert patent searcher specialising in CO2 utilisation chemistry. Convert the following natural language technology description into EPO CQL (Cooperative Patent Classification Query Language) for the EPO OPS API.

Technology description: "${description}"

Rules:
1. Extract 2-4 key technical terms that capture the core inventive concept. Drop generic words (process, method, system, apparatus).
2. Always include "ta=CO2" unless CO2 is already implicit in a very specific term (e.g. "electrolysis" alone is too broad without CO2).
3. Join terms with AND. Use OR only for clear synonyms (e.g. ta=methanol OR ta=methyl-alcohol).
4. Use EPO ta= (title/abstract) field prefix for each term.
5. Keep it concise — 2 to 4 ta= clauses.

Return ONLY a JSON object with these fields:
{
  "epo_query": "ta=CO2 AND ta=methanol AND ta=copper",
  "search_terms": ["CO2", "methanol", "copper"],
  "interpretation": "Patents covering copper-catalysed CO2 hydrogenation to methanol"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: `Anthropic error ${response.status}`, detail: err.slice(0, 200) });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';

    // Extract JSON from response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(200).json({ epo_query: `ta=CO2 AND ta=${description.split(' ')[0]}`, search_terms: [], interpretation: description, fallback: true });

    const parsed = JSON.parse(match[0]);

    // Append jurisdiction filter if needed
    if (jFilter && parsed.epo_query && !parsed.epo_query.includes('pn=')) {
      parsed.epo_query += jFilter;
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
