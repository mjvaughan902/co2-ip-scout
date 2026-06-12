const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { query, family_id } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });

  // Tight system prompt — no EPO data piped in, AI works from domain knowledge only
  const system = `You are a patent intelligence analyst specialising in CO2 utilisation chemistry. 
You provide realistic, domain-accurate patent landscape analysis.
Always return valid complete JSON only — no markdown, no preamble, no truncation.
All numeric fields must be realistic non-zero integers.
Keep all text fields concise — max 2 sentences each for descriptions, max 3 short paragraphs for landscape_summary.`;

  const user = `Analyse the patent landscape for this CO2 utilisation technology: "${query}"

Return this JSON object with all placeholders replaced by real content:
{"chemistry_family":"string","query_interpretation":"string","cpc_codes":["string","string","string"],"landscape_summary":"para1\\npara2\\npara3","filing_trend":"rising","estimated_active_patents":500,"estimated_expired_patents":300,"estimated_pending":120,"activity_score":6,"whitespace_opportunities":[{"title":"string","description":"string","strength":"high"},{"title":"string","description":"string","strength":"high"},{"title":"string","description":"string","strength":"medium"},{"title":"string","description":"string","strength":"low"}],"blocking_risks":[{"title":"string","description":"string","severity":"high"},{"title":"string","description":"string","severity":"medium"},{"title":"string","description":"string","severity":"low"}],"top_assignees":[{"name":"string","type":"corporate","patent_count":120,"focus":"string"},{"name":"string","type":"academic","patent_count":80,"focus":"string"},{"name":"string","type":"corporate","patent_count":60,"focus":"string"},{"name":"string","type":"national_lab","patent_count":40,"focus":"string"},{"name":"string","type":"corporate","patent_count":25,"focus":"string"},{"name":"string","type":"academic","patent_count":15,"focus":"string"}],"representative_patents":[{"title":"string","assignee":"string","year":2020,"status":"active","abstract":"string","number":"EP1234567"},{"title":"string","assignee":"string","year":2017,"status":"active","abstract":"string","number":"WO2017000000"},{"title":"string","assignee":"string","year":2013,"status":"expired","abstract":"string","number":"EP2000000"},{"title":"string","assignee":"string","year":2022,"status":"filed","abstract":"string","number":"WO2022000000"},{"title":"string","assignee":"string","year":2019,"status":"active","abstract":"string","number":"EP3000000"}],"strategic_recommendation":"string"}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });

    const raw = await response.json();

    if (!response.ok) {
      return res.status(200).json({
        error: 'Anthropic error',
        status: response.status,
        detail: JSON.stringify(raw).slice(0, 300)
      });
    }

    const text = (raw.content?.[0]?.text || '').replace(/```json|```/g, '').trim();

    try {
      const parsed = JSON.parse(text);
      parsed.data_source = 'AI estimate';
      return res.status(200).json(parsed);
    } catch(e) {
      // Attempt recovery if truncated
      const match = text.match(/^\{[\s\S]+/);
      if (match) {
        let t = match[0];
        const opens  = (t.match(/\{/g) || []).length;
        const closes = (t.match(/\}/g) || []).length;
        if (opens > closes) {
          // Trim to last complete key-value pair and close
          const lastGood = t.lastIndexOf(',"representative_patents"');
          if (lastGood > 0) t = t.slice(0, lastGood) + ',"representative_patents":[],"strategic_recommendation":"See landscape summary for strategic guidance."}';
          else t = t + '}'.repeat(opens - closes);
        }
        try {
          const parsed = JSON.parse(t);
          parsed.data_source = 'AI estimate (partial)';
          return res.status(200).json(parsed);
        } catch(e2) {}
      }
      return res.status(200).json({
        error: 'JSON parse failed',
        raw_text: text.slice(0, 400)
      });
    }

  } catch(err) {
    return res.status(200).json({ error: 'Request failed', detail: err.message });
  }
};
