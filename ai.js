// /api/ai — server-side proxy to Anthropic.
// The API key lives in Vercel's environment variables (ANTHROPIC_API_KEY), never in the browser.
// Every request must carry a valid Firebase ID token, so only signed-in, verified users can use AI.

const FIREBASE_WEB_KEY = 'AIzaSyC1GMBmBpFkT441mYmKBSe_tEjBZUrqGJU'; // public, same as in index.html
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_TOKENS_CAP = 3000;

// simple per-instance rate limit: max N calls per user per hour
const RATE = { limit: 40, windowMs: 60 * 60 * 1000 };
const hits = new Map();
function rateLimited(uid) {
  const now = Date.now();
  const arr = (hits.get(uid) || []).filter(t => now - t < RATE.windowMs);
  if (arr.length >= RATE.limit) return true;
  arr.push(now); hits.set(uid, arr); return false;
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
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: 'missing token' });
  const uid = await verifyToken(idToken);
  if (!uid) return res.status(401).json({ error: 'invalid token' });
  if (rateLimited(uid)) return res.status(429).json({ error: 'rate limit' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { messages, system, max_tokens } = body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: Math.min(parseInt(max_tokens) || 1500, MAX_TOKENS_CAP),
        ...(system ? { system } : {}),
        messages
      })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'anthropic error' });
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return res.status(200).json({ text, usage: data.usage });
  } catch (e) {
    return res.status(502).json({ error: 'upstream failure' });
  }
};
