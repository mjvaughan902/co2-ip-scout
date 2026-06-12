module.exports = async function handler(req, res) {
  res.status(200).json({
    has_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    key_prefix: process.env.ANTHROPIC_API_KEY 
      ? process.env.ANTHROPIC_API_KEY.slice(0, 15) + '...' 
      : 'NOT FOUND',
    has_epo_key: !!process.env.EPO_CONSUMER_KEY,
    node_env: process.env.NODE_ENV
  });
};