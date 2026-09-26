// /api/ai — server-side proxy to Anthropic.
// The API key lives in Vercel's environment variables (ANTHROPIC_API_KEY), never in the browser.
// Every POST must carry a valid Firebase ID token. GET returns a health check.

const FIREBASE_WEB_KEY = 'AIzaSyC1GMBmBpFkT441mYmKBSe_tEjBZUrqGJU'; // public, same as in index.html
const MAX_TOKENS_CAP = 4000;
const ANTHROPIC_VERSION = '2023-06-01';

const RATE = { limit: 60, windowMs: 60 * 60 * 1000 };
const hits = new Map();
function rateLimited(uid) {
  const now = Date.now();
  const arr = (hits.get(uid) || []).filter(t => now - t < RATE.windowMs);
  if (arr.length >= RATE.limit) return true;
  arr.push(now); hits.set(uid, arr); return false;
}

let cachedModel = null;
async function resolveModel(key) {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  if (cachedModel) return cachedModel;
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
    });
    const j = await r.json();
    const ids = (j.data || []).map(m => m.id);
    // prefer newest sonnet, then opus, then haiku, then anything
    const pick = ids.find(i => /sonnet/.test(i)) || ids.find(i => /opus/.test(i)) || ids.find(i => /haiku/.test(i)) || ids[0];
    if (pick) cachedModel = pick;
  } catch (e) { /* ignore */ }
  return cachedModel || 'claude-sonnet-4-5';
}

async function verifyToken(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!r.ok) return null;
  const j = await r.json();
  const u = j.users && j.users[0];
  if (!u || !u.emailVerified) return null;
  return u.localId;
}

module.exports = async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;

  if (req.method === 'GET') {
    const model = key ? await resolveModel(key) : null;
    return res.status(200).json({ ok: !!key, keyConfigured: !!key, model });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'missing token' });
  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: 'invalid token' });
  if (rateLimited(uid)) return res.status(429).json({ error: 'rate limit' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { messages, system, max_tokens, search } = body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

  const model = await resolveModel(key);
  const payload = {
    model,
    max_tokens: Math.min(parseInt(max_tokens) || 1500, MAX_TOKENS_CAP),
    ...(system ? { system } : {}),
    messages
  };
  if (search) payload.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (data.error && data.error.message) || 'anthropic error', model });
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return res.status(200).json({ text, model, usage: data.usage });
  } catch (e) {
    return res.status(502).json({ error: 'upstream failure: ' + e.message });
  }
};
