// /api/notify — sends push notifications via Firebase Cloud Messaging (HTTP v1).
// Needs env var FIREBASE_SERVICE_ACCOUNT = the full JSON of a Firebase service account key.
// Caller must be a signed-in user; allowed targets: their partner, or (admins) their org, or (super) anyone.

const crypto = require('crypto');
const FIREBASE_WEB_KEY = 'AIzaSyC1GMBmBpFkT441mYmKBSe_tEjBZUrqGJU';

function b64url(input) { return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

let tokenCache = { token: null, exp: 0 };
async function accessToken(sa) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, sub: sa.client_email, aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore'
  }));
  const sig = crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(sa.private_key, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${header}.${claim}.${sig}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('oauth: ' + JSON.stringify(j));
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}

async function verifyCaller(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken })
  });
  if (!r.ok) return null;
  const j = await r.json(); const u = j.users && j.users[0];
  return u && u.emailVerified ? u.localId : null;
}

const fieldStr = (doc, k) => doc && doc.fields && doc.fields[k] && doc.fields[k].stringValue;

async function getUser(pid, at, uid) {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/users/${uid}`, { headers: { Authorization: 'Bearer ' + at } });
  if (!r.ok) return null; return r.json();
}
async function runQuery(pid, at, filters) {
  const where = filters.length === 1 ? { fieldFilter: filters[0] } : { compositeFilter: { op: 'AND', filters: filters.map(f => ({ fieldFilter: f })) } };
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents:runQuery`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'users' }], where, limit: 500 } })
  });
  const j = await r.json(); return (j || []).map(x => x.document).filter(Boolean);
}
const eq = (f, v) => ({ field: { fieldPath: f }, op: 'EQUAL', value: { stringValue: v } });
async function orgUsers(pid, at, orgId) { return runQuery(pid, at, [eq('orgId', orgId)]); }
async function orgAdmins(pid, at, orgId) {
  if (orgId === 'individual') return runQuery(pid, at, [eq('role', 'super')]);
  return runQuery(pid, at, [eq('orgId', orgId), eq('role', 'admin')]);
}

async function sendOne(pid, at, token, title, body, link) {
  const r = await fetch(`https://fcm.googleapis.com/v1/projects/${pid}/messages:send`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title, body }, webpush: { notification: { icon: '/icon-192.png', badge: '/icon-192.png', dir: 'rtl', lang: 'ar' }, fcm_options: { link: link || '/' } } } })
  });
  return r.ok;
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ ok: !!process.env.FIREBASE_SERVICE_ACCOUNT, configured: !!process.env.FIREBASE_SERVICE_ACCOUNT });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(500).json({ error: 'FIREBASE_SERVICE_ACCOUNT not configured' });
  let sa; try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch { return res.status(500).json({ error: 'service account JSON invalid' }); }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const callerUid = idToken && await verifyCaller(idToken);
  if (!callerUid) return res.status(401).json({ error: 'invalid token' });

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { toUid, toOrg, toAdmins, title, text, link } = body || {};
  if (!title || !text || (!toUid && !toOrg)) return res.status(400).json({ error: 'title, text and toUid|toOrg required' });

  try {
    const pid = sa.project_id; const at = await accessToken(sa);
    const caller = await getUser(pid, at, callerUid);
    const role = fieldStr(caller, 'role') || 'user'; const callerOrg = fieldStr(caller, 'orgId');
    let targets = [];
    if (toUid) {
      const u = await getUser(pid, at, toUid); if (!u) return res.status(404).json({ error: 'user not found' });
      const allowed = role === 'super' || (role === 'admin' && fieldStr(u, 'orgId') === callerOrg) || fieldStr(u, 'partnerId') === callerUid || fieldStr(caller, 'partnerId') === toUid;
      if (!allowed) return res.status(403).json({ error: 'not allowed' });
      targets = [u];
    } else if (toAdmins) {
      // any member may notify the admins of their own org (e.g. a redemption request)
      if (!(role === 'super' || toOrg === callerOrg)) return res.status(403).json({ error: 'not allowed' });
      targets = await orgAdmins(pid, at, toOrg);
    } else {
      if (!(role === 'super' || (role === 'admin' && toOrg === callerOrg))) return res.status(403).json({ error: 'not allowed' });
      targets = await orgUsers(pid, at, toOrg);
    }
    let sent = 0;
    for (const u of targets) { const tok = fieldStr(u, 'fcmToken'); if (tok && await sendOne(pid, at, tok, String(title).slice(0, 80), String(text).slice(0, 200), link)) sent++; }
    return res.status(200).json({ ok: true, sent, targets: targets.length });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
