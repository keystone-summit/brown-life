// POST {pin}   -> identifies the user, sets cookie (rate-limited: 5 fails / 15 min -> 15-min lockout)
// GET          -> {authed: bool, user: {id,name}|null}
// DELETE       -> clears cookie

const { isAuthed, currentUser, setAuthCookie, clearAuthCookie, identifyPin, seedPinIfMissing } = require('./_lib/auth');
const { clientIp, checkLock, recordFail, clearAttempts, LOCK_MS } = require('./_lib/ratelimit');

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    const u = currentUser(req);
    return res.end(JSON.stringify({ authed: !!u, user: u || null }));
  }

  if (req.method === 'DELETE') {
    clearAuthCookie(res);
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST') {
    const ip = clientIp(req);

    // Brute-force lockout gate.
    const lock = await checkLock(ip);
    if (lock.locked) {
      res.statusCode = 429;
      res.setHeader('Retry-After', String(lock.retryAfterSec));
      return res.end(JSON.stringify({
        error: 'Too many attempts. Try again later.',
        retry_after: lock.retryAfterSec,
      }));
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let pin = '';
    try { pin = (JSON.parse(body || '{}').pin || '').toString(); } catch {}
    // Note: the PIN is never logged.

    const user = await identifyPin(pin);
    if (!user) {
      const r = await recordFail(ip);
      if (r.locked) {
        res.statusCode = 429;
        res.setHeader('Retry-After', String(Math.ceil(LOCK_MS / 1000)));
        return res.end(JSON.stringify({
          error: 'Too many attempts. Locked for 15 minutes.',
          retry_after: Math.ceil(LOCK_MS / 1000),
        }));
      }
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'bad pin' }));
    }

    // Success: clear the counter and issue a fresh (rotated) session cookie
    // bound to this user.
    await clearAttempts(ip);
    // Bootstrap this user's DB PIN row from env on first login after deploy
    // (insert-if-missing; never overwrites a PIN the user changed in-app).
    await seedPinIfMissing(user.id);
    setAuthCookie(res, user.id);
    return res.end(JSON.stringify({ ok: true, user }));
  }

  res.statusCode = 405;
  res.end(JSON.stringify({ error: 'method not allowed' }));
};
