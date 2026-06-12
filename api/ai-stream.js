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

  // Build rich EPO context from real data
  let epoContext = '';
  let dataSource = 'AI estimate';
  if (real_patent_data && real_patent_data.total_results) {
    dataSource = 'EPO OPS live data';
    const assignees = (real_patent_data.top_assignees || [])
      .slice(0, 8)
      .map(a => `${a.name} (${a.count} patents)`)
      .join(', ');
    const years = real_patent_data.year_distribution || {};
    const yearSummary = Object.entries(years)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 6)
      .map(([y, n]) => `${y}: ${n}`)
      .join(', ');
    const titles = (real_patent_data.sample_patents || [])
      .slice(0, 6)
      .map(p => `"${p.title}" (${p.assignee}, ${p.year})`)
      .join('; ');

    epoContext = `

LIVE EPO PATENT DATA (use this to ground your analysis):
- Total patents found in EPO database: ${real_patent_data.total_results}
- Top assignees by filing volume: ${assignees}
- Recent filing activity by year: ${yearSummary}
- Representative patent titles from database: ${titles}

Base your estimated_active_patents on the EPO total of ${real_patent_data.total_results}.
Reference the actual assignees found in your top_assignees analysis.
Use the filing year distribution to determine the filing_trend.`;
  }

  const system = `You are a specialist patent intelligence analyst with deep expertise in CO2 utilisation and carbon conversion chemistry, covering all major families: cyclic/linear carbonates, carboxylation reactions, CO2-to-fuels, mineralisation, polymer synthesis, C1 feedstock routes, electrochemical CO2 reduction, and photocatalytic conversion.

Your analysis must be accurate, specific, and grounded in real domain knowledge. When live EPO data is provided, use it directly — reference actual assignees, real filing trends, and real patent counts.

Return ONLY a single valid JSON object. No markdown fences, no preamble, no explanation. The JSON must be complete and valid. Keep individual text fields concise (2-3 sentences max) to ensure the response completes within limits.`;

  const user = `Analyse the CO2 utilisation patent landscape for: "${query}"${epoContext}

Return this exact JSON structure with all fields populated with real, accurate content:
{"chemistry_family":"string","query_interpretation":"string","cpc_codes":["string","string","string"],"landscape_summary":"paragraph1\\nparagraph2\\nparagraph3","filing_trend":"rising","estimated_active_patents":0,"estimated_expired_patents":0,"estimated_pending":0,"activity_score":0,"data_source":"${dataSource}","whitespace_opportunities":[{"title":"string","description":"string","strength":"high"},{"title":"string","description":"string","strength":"high"},{"title":"string","description":"string","strength":"medium"},{"title":"string","description":"string","strength":"low"}],"blocking_risks":[{"title":"string","description":"string","severity":"high"},{"title":"string","description":"string","severity":"medium"},{"title":"string","description":"string","severity":"low"}],"top_assignees":[{"name":"string","type":"corporate","patent_count":0,"focus":"string"},{"name":"string","type":"academic","patent_count":0,"focus":"string"},{"name":"string","type":"corporate","patent_count":0,"focus":"string"},{"name":"string","type":"national_lab","patent_count":0,"focus":"string"},{"name":"string","type":"corporate","patent_count":0,"focus":"string"},{"name":"string","type":"academic","patent_count":0,"focus":"string"}],"representative_patents":[{"title":"string","assignee":"string","year":2020,"status":"active","abstract":"string","number":"string"},{"title":"string","assignee":"string","year":2018,"status":"active","abstract":"string","number":"string"},{"title":"string","assignee":"string","year":2015,"status":"active","abstract":"string","number":"string"},{"title":"string","assignee":"string","year":2010,"status":"expired","abstract":"string","number":"string"},{"title":"string","assignee":"string","year":2022,"status":"filed","abstract":"string","number":"string"}],"strategic_recommendation":"string"}`;

  // Set streaming headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

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
        max_tokens: 3000,
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

    // Stream response body line by line
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
            // Stream each chunk to the browser
            res.write(`data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`);
          }
        } catch(e) { /* skip malformed lines */ }
      }
    });

    response.body.on('end', () => {
      // Parse the complete accumulated JSON
      const cleaned = fullText.replace(/```json|```/g, '').trim();
      try {
        const parsed = JSON.parse(cleaned);
        res.write(`data: ${JSON.stringify({ type: 'complete', data: parsed })}\n\n`);
      } catch(e) {
        // Try to recover truncated JSON
        let fixed = cleaned;
        const opens  = (fixed.match(/\{/g) || []).length;
        const closes = (fixed.match(/\}/g) || []).length;
        if (opens > closes) {
          const lastPatents = fixed.lastIndexOf('"representative_patents"');
          if (lastPatents > 0) {
            fixed = fixed.slice(0, lastPatents) + '"representative_patents":[],"strategic_recommendation":"See landscape summary above for strategic guidance."}';
          } else {
            fixed += '}'.repeat(opens - closes);
          }
          try {
            const parsed = JSON.parse(fixed);
            parsed.data_source = (parsed.data_source || dataSource) + ' (partial)';
            res.write(`data: ${JSON.stringify({ type: 'complete', data: parsed })}\n\n`);
          } catch(e2) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Could not parse response', raw: cleaned.slice(0, 300) })}\n\n`);
          }
        } else {
          res.write(`data: ${JSON.stringify({ type: 'error', message: 'JSON parse failed', raw: cleaned.slice(0, 300) })}\n\n`);
        }
      }
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
