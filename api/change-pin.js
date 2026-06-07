// POST {current_pin, new_pin, confirm_pin}  -> change the SIGNED-IN user's PIN.
//
// Security posture:
//   - Auth required: the target user is taken from the signed session cookie,
//     never from the request body, so a user can only ever change their OWN PIN.
//   - Current PIN re-verification: the current_pin must match before any write.
//   - Rate-limited: brute-forcing the current PIN is throttled (5 fails / 15 min
//     -> 15-min lockout), in its own namespace so it can't be used to lock out,
//     or be masked by, the login limiter.
//   - Audited: every attempt is logged (user id + ip + outcome). The PIN values
//     themselves are NEVER logged.
//   - On success the session cookie is cleared, forcing a fresh login with the
//     new PIN.

const { currentUser, changePin, clearAuthCookie } = require('./_lib/auth');
const { clientIp, checkLock, recordFail, clearAttempts, LOCK_MS } = require('./_lib/ratelimit');

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method not allowed' }));
  }

  // Must be signed in. The user id comes from the signed cookie only.
  const me = currentUser(req);
  if (!me) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  const ip = clientIp(req);
  // Separate rate-limit namespace from the login limiter.
  const rlKey = `pinchg:${me.id}:${ip}`;

  const lock = await checkLock(rlKey);
  if (lock.locked) {
    console.warn(`[change-pin] LOCKED user=${me.id} ip=${ip} retryAfter=${lock.retryAfterSec}s`);
    res.statusCode = 429;
    res.setHeader('Retry-After', String(lock.retryAfterSec));
    return res.end(JSON.stringify({
      error: 'Too many attempts. Try again later.',
      retry_after: lock.retryAfterSec,
    }));
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let currentPin = '', newPin = '', confirmPin = '';
  try {
    const j = JSON.parse(raw || '{}');
    currentPin = (j.current_pin || '').toString();
    newPin     = (j.new_pin || '').toString();
    confirmPin = (j.confirm_pin || '').toString();
  } catch { /* leave blank -> validation below fails */ }
  // Note: PIN values are never logged.

  // Shape checks (cheap, no DB hit, no rate-limit penalty).
  if (!/^[0-9]{6}$/.test(newPin)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'New PIN must be 6 digits.' }));
  }
  if (newPin !== confirmPin) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'New PIN and confirmation do not match.' }));
  }

  // Re-verify current PIN + persist (changePin enforces own-user + difference).
  let result;
  try {
    result = await changePin(me.id, currentPin, newPin);
  } catch (e) {
    console.error(`[change-pin] ERROR user=${me.id} ip=${ip}: ${e && e.message}`);
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'Could not save your new PIN right now. Please try again.' }));
  }

  if (!result.ok) {
    // A wrong current PIN counts against the limiter; a same-as-old or bad-shape
    // PIN is a user mistake, not a guess, so it does not.
    const isGuess = /current pin is incorrect/i.test(result.error);
    let fails = 0, locked = false;
    if (isGuess) {
      const r = await recordFail(rlKey);
      fails = r.fails; locked = r.locked;
    }
    console.warn(`[change-pin] FAIL user=${me.id} ip=${ip} reason="${result.error}" guess=${isGuess} fails=${fails}`);
    if (locked) {
      res.statusCode = 429;
      res.setHeader('Retry-After', String(Math.ceil(LOCK_MS / 1000)));
      return res.end(JSON.stringify({
        error: 'Too many attempts. Locked for 15 minutes.',
        retry_after: Math.ceil(LOCK_MS / 1000),
      }));
    }
    res.statusCode = isGuess ? 401 : 400;
    return res.end(JSON.stringify({ error: result.error }));
  }

  // Success: clear the limiter + the session cookie (force re-login).
  await clearAttempts(rlKey);
  clearAuthCookie(res);
  console.log(`[change-pin] SUCCESS user=${me.id} ip=${ip}`);
  return res.end(JSON.stringify({ ok: true }));
};
