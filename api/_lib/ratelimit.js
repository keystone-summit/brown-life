// PIN brute-force lockout for the login endpoint.
//
// Backed by the dblife_auth_attempts table so the limit survives serverless
// cold starts and holds across Vercel instances (in-memory would not).
//
// Policy: 5 failed attempts inside a 15-minute window -> 15-minute lockout.
// On a correct PIN the IP's counter is cleared.
//
// Fail-open: if the limiter's own DB calls error out, login still proceeds to
// the scrypt PIN check — we never lock John out because of an infra blip.
// The PIN itself is always required regardless.

const { supaSelect, supaInsert, supaPatch, supaDelete } = require('./supa');

const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS   = 15 * 60 * 1000;
const TABLE     = 'dblife_auth_attempts';

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  const ip = xff.split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress)
    || 'unknown';
  return ip.slice(0, 100);
}

function enc(ip) { return encodeURIComponent(ip); }

// Returns { locked: bool, retryAfterSec? }. Never throws.
async function checkLock(ip) {
  try {
    const rows = await supaSelect(TABLE, `ip=eq.${enc(ip)}&limit=1`);
    const row = rows && rows[0];
    if (row && row.locked_until) {
      const until = new Date(row.locked_until).getTime();
      if (until > Date.now()) {
        return { locked: true, retryAfterSec: Math.max(1, Math.ceil((until - Date.now()) / 1000)) };
      }
    }
    return { locked: false };
  } catch {
    return { locked: false }; // fail-open
  }
}

// Record a failed attempt; returns { locked, fails }. Never throws.
async function recordFail(ip) {
  const now = Date.now();
  try {
    const rows = await supaSelect(TABLE, `ip=eq.${enc(ip)}&limit=1`);
    const row = rows && rows[0];
    if (!row) {
      await supaInsert(TABLE, {
        ip, fails: 1, window_start: new Date(now).toISOString(),
        locked_until: null, updated_at: new Date(now).toISOString(),
      }, { returning: false });
      return { locked: false, fails: 1 };
    }
    let fails = row.fails || 0;
    let windowStart = row.window_start ? new Date(row.window_start).getTime() : now;
    if (now - windowStart > WINDOW_MS) { fails = 0; windowStart = now; } // stale window resets
    fails += 1;
    const patch = {
      fails,
      window_start: new Date(windowStart).toISOString(),
      locked_until: null,
      updated_at: new Date(now).toISOString(),
    };
    let locked = false;
    if (fails >= MAX_FAILS) { patch.locked_until = new Date(now + LOCK_MS).toISOString(); locked = true; }
    await supaPatch(TABLE, `ip=eq.${enc(ip)}`, patch);
    return { locked, fails };
  } catch {
    return { locked: false, fails: 0 }; // fail-open
  }
}

async function clearAttempts(ip) {
  try { await supaDelete(TABLE, `ip=eq.${enc(ip)}`); } catch {}
}

module.exports = { clientIp, checkLock, recordFail, clearAttempts, MAX_FAILS, LOCK_MS };
