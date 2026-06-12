// api/ai-stream.js
// Streams AI landscape analysis grounded in real EPO patent data
const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { query, family_id, real_patent_data } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query required' });

  // Build EPO grounding context
  let epoContext = '';
  let dataSource = 'AI estimate';
  const hasRealData = real_patent_data && real_patent_data.total_results && real_patent_data.total_results > 0;

  if (hasRealData) {
    dataSource = 'EPO OPS live data';
    const total = real_patent_data.total_results;

    const assignees = (real_patent_data.top_assignees || [])
      .slice(0, 8)
      .map(a => `${a.name} (${a.count} patents)`)
      .join(', ');

    const years = real_patent_data.year_distribution || {};
    const recentYears = Object.entries(years)
      .sort((a, b) => parseInt(b[0]) - parseInt(a[0]))
      .slice(0, 8)
      .map(([y, n]) => `${y}:${n}`)
      .join(', ');

    const sampleTitles = (real_patent_data.sample_patents || [])
      .slice(0, 8)
      .filter(p => p.title && p.title !== 'Untitled')
      .map(p => `"${p.title}" — ${p.assignee || 'Unknown'} (${p.year || '?'})`)
      .join('\n  ');

    epoContext = `

LIVE EPO DATABASE RESULTS — ground your entire analysis in this real data:
Total patents retrieved: ${total}
Top assignees: ${assignees}
Filing activity by year: ${recentYears}
Sample patent records:
  ${sampleTitles}

INSTRUCTIONS:
- Set estimated_active_patents to approximately ${Math.round(total * 0.65)}
- Set estimated_expired_patents to approximately ${Math.round(total * 0.25)}
- Set estimated_pending to approximately ${Math.round(total * 0.10)}
- Use the actual assignee names above in your top_assignees list
- Determine filing_trend from the year distribution (rising if recent years higher)
- Reference real patterns you see in the patent titles in your landscape_summary`;
  }

  const system = `You are a specialist patent intelligence analyst with deep expertise in CO2 utilisation and carbon conversion chemistry. You provide accurate, specific, domain-expert analysis grounded in real data when provided.

CRITICAL: Return ONLY a single complete valid JSON object. No markdown, no preamble, no explanation before or after the JSON. Every numeric field must contain a real non-zero integer. Every string field must contain real specific content — never return placeholder text like "string" or "paragraph".`;

  const user = `Analyse the CO2 utilisation patent landscape for: "${query}"${epoContext}

Return this JSON with ALL fields populated with real, specific content for this exact technology:

{
  "chemistry_family": "the specific CO2 chemistry family name",
  "query_interpretation": "precise 1-2 sentence description of what technology this covers",
  "cpc_codes": ["C07D317 — cyclic carbonates and lactones", "B01J31 — catalysts", "C07C68 — carbonate esters"],
  "landscape_summary": "First paragraph: overall density and maturity of this patent space, naming key players and dominant technical approaches.\nSecond paragraph: recent filing momentum, emerging directions, and freedom-to-operate outlook.",
  "filing_trend": "rising",
  "estimated_active_patents": 450,
  "estimated_expired_patents": 280,
  "estimated_pending": 120,
  "activity_score": 6,
  "data_source": "${dataSource}",
  "whitespace_opportunities": [
    {"title": "Specific opportunity title", "description": "2-sentence description of this filing opportunity and why it exists.", "strength": "high"},
    {"title": "Specific opportunity title", "description": "2-sentence description.", "strength": "medium"},
    {"title": "Specific opportunity title", "description": "2-sentence description.", "strength": "low"}
  ],
  "blocking_risks": [
    {"title": "Specific risk title", "description": "2-sentence description of this blocking risk and who holds it.", "severity": "high"},
    {"title": "Specific risk title", "description": "2-sentence description.", "severity": "medium"}
  ],
  "top_assignees": [
    {"name": "Real company or institution name", "type": "corporate", "patent_count": 145, "focus": "specific focus area"},
    {"name": "Real university name", "type": "academic", "patent_count": 89, "focus": "specific focus area"},
    {"name": "Real company name", "type": "corporate", "patent_count": 67, "focus": "specific focus area"},
    {"name": "Real lab name", "type": "national_lab", "patent_count": 43, "focus": "specific focus area"},
    {"name": "Real company name", "type": "corporate", "patent_count": 31, "focus": "specific focus area"}
  ],
  "representative_patents": [
    {"title": "Real descriptive patent title", "assignee": "Real assignee", "year": 2021, "status": "active", "abstract": "2-sentence description of what this patent covers.", "number": "EP3456789"},
    {"title": "Real descriptive patent title", "assignee": "Real assignee", "year": 2018, "status": "active", "abstract": "2-sentence description.", "number": "WO2018123456"},
    {"title": "Real descriptive patent title", "assignee": "Real assignee", "year": 2008, "status": "expired", "abstract": "2-sentence description.", "number": "EP1234567"}
  ],
  "strategic_recommendation": "Three sentences: (1) FTO posture for this space, (2) highest priority filing areas, (3) best partnership or licensing angle."
}`;

  // Set SSE streaming headers — flushHeaders() sends them immediately so
  // Vercel's proxy starts streaming instead of buffering the whole response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

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
        max_tokens: 2500,
        stream: true,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      res.write(`data: ${JSON.stringify({ type: 'error', message: `Anthropic error ${response.status}: ${err.slice(0, 200)}` })}\n\n`);
      res.end();
      return;
    }

    let fullText = '';

    response.body.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.text) {
            fullText += event.delta.text;
            res.write(`data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`);
          }
        } catch(e) { /* skip malformed */ }
      }
    });

    response.body.on('end', () => {
      const cleaned = fullText.replace(/```json|```/g, '').trim();

      // Try direct parse
      try {
        const parsed = JSON.parse(cleaned);
        res.write(`data: ${JSON.stringify({ type: 'complete', data: parsed })}\n\n`);
        res.end();
        return;
      } catch(e) {}

      // Try to find JSON object in response
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          res.write(`data: ${JSON.stringify({ type: 'complete', data: parsed })}\n\n`);
          res.end();
          return;
        } catch(e) {}
      }

      // Truncation recovery — close at last complete top-level field
      const opens = (cleaned.match(/\{/g) || []).length;
      const closes = (cleaned.match(/\}/g) || []).length;
      if (opens > closes) {
        // Find last safely-completed section and close there
        const checkpoints = [
          '"strategic_recommendation"',
          '"representative_patents"',
          '"top_assignees"',
          '"blocking_risks"',
          '"whitespace_opportunities"'
        ];
        for (const cp of checkpoints) {
          const idx = cleaned.lastIndexOf(cp);
          if (idx > 0) {
            // Find end of this field's value
            let fixed = cleaned.slice(0, idx);
            // Close with minimal valid fields
            const tail = cp === '"strategic_recommendation"'
              ? `${cp}:"See landscape summary for strategic guidance."}`
              : `${cp}:[],"strategic_recommendation":"See landscape summary for strategic guidance."}`;
            try {
              const parsed = JSON.parse(fixed + tail);
              parsed.data_source = (parsed.data_source || dataSource) + ' (partial)';
              res.write(`data: ${JSON.stringify({ type: 'complete', data: parsed })}\n\n`);
              res.end();
              return;
            } catch(e) {}
          }
        }
      }

      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Could not parse AI response. Please try again.', raw: cleaned.slice(0, 200) })}\n\n`);
      res.end();
    });

    response.body.on('error', err => {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    });

  } catch(err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
};
