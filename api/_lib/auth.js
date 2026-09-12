// Brown Life — multi-user PIN gate (two users, isolated data).
//
// Two layers:
//   1. Session: HMAC-signed cookie  ->  <userId>.<expIso>.<hmacBase64Url>
//      The userId is inside the signed payload, so it can't be tampered with
//      to impersonate the other user.
//   2. PIN check: scrypt-hashed PINs (never stored/compared in plaintext).
//      The PIN itself identifies WHICH user is signing in — there is no user
//      picker on the gate.
//
// Users (PINs are owner-set; NONE ship in code — this repo is public):
//   "D" — DB row in dblife_auth_users, or owner env BROWNLIFE_PIN_HASH_JOHN / BROWNLIFE_PIN_JOHN; name BROWNLIFE_USER1_NAME
//   "K" — DB row in dblife_auth_users, or owner env BROWNLIFE_PIN_HASH_LISA / BROWNLIFE_PIN_LISA; name BROWNLIFE_USER2_NAME
// NOTE: the internal user ids stay 'john'/'lisa' (opaque keys the user never
// sees) so existing per-user data keeps its owner; only the display NAME is D/K.
// PIN-hash format: scrypt$<saltHex>$<hashHex>. Generate with:
//   node -e "const c=require('crypto');const s=c.randomBytes(16);console.log('scrypt$'+s.toString('hex')+'$'+c.scryptSync(process.argv[1],s,32).toString('hex'))" <NEWPIN>
//
// Session signing key: BROWNLIFE_AUTH_SECRET, REQUIRED. There is no fallback.
//
// 🔒 DENY BY DEFAULT (2026-09-12). This file lives in a PUBLIC repo. It used to
// carry (a) hashes of the documented default PINs, used whenever the DB read
// failed, and (b) a literal fallback session secret used when the env var was
// unset. Either one let a stranger in without the owner's secret, and (a)
// quietly resurrected the defaults even after a user had changed their PIN.
// Both are gone:
//   * no DB row and no owner-set env hash  -> nobody signs in (fail CLOSED)
//   * no BROWNLIFE_AUTH_SECRET             -> no session verifies, none issues
// Guarded by tests/auth-no-backdoors.test.js (CI + the vercel.json build gate).

const crypto = require('crypto');
const { supaSelect, supaInsert, supaPatch } = require('./supa');

const AUTH_TABLE = 'dblife_auth_users';

// Empty when unset: sign() then refuses, so nothing verifies and nothing issues.
const SECRET = process.env.BROWNLIFE_AUTH_SECRET || '';
const COOKIE = 'brownlife_auth';
const TTL_MS = 60 * 60 * 1000; // 1 hour; rotated on every login

const USERS = [
  {
    id: 'john',
    name:     process.env.BROWNLIFE_USER1_NAME || 'D',
    pinHash:  process.env.BROWNLIFE_PIN_HASH_JOHN || '',
    pinPlain: process.env.BROWNLIFE_PIN_JOHN || '',
  },
  {
    id: 'lisa',
    name:     process.env.BROWNLIFE_USER2_NAME || 'K',
    pinHash:  process.env.BROWNLIFE_PIN_HASH_LISA || '',
    pinPlain: process.env.BROWNLIFE_PIN_LISA || '',
  },
];

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Returns null when no signing secret is configured — callers treat that as
// "no valid session", never as "sign with something else".
function sign(payload) {
  if (!SECRET) return null;
  return b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
}

function makeCookie(userId) {
  const exp = new Date(Date.now() + TTL_MS).toISOString();
  const payload = `${userId}.${exp}`;   // userId has no '.', exp's ms-dot is fine
  const sig = sign(payload);
  if (!sig) throw new Error('BROWNLIFE_AUTH_SECRET is not set; refusing to issue a session.');
  return `${payload}.${sig}`;
}

// Returns { userId, name } if the cookie is valid + unexpired + a known user.
function parseSession(req) {
  const val = readCookie(req);
  if (!val || typeof val !== 'string') return null;
  // The signature is base64url (no dots) after the LAST '.'.
  const idx = val.lastIndexOf('.');
  if (idx < 0) return null;
  const payload = val.slice(0, idx);
  const sig = val.slice(idx + 1);
  const expected = sign(payload);
  if (!expected || sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  // payload = "<userId>.<expIso>"; userId is before the FIRST '.'.
  const dot = payload.indexOf('.');
  if (dot < 0) return null;
  const userId = payload.slice(0, dot);
  const exp = payload.slice(dot + 1);
  if (!(new Date(exp).getTime() > Date.now())) return null;
  const user = USERS.find((u) => u.id === userId);
  if (!user) return null;
  return { userId, name: user.name };
}

function readCookie(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function isAuthed(req) {
  return !!parseSession(req);
}

// Returns { id, name } of the signed-in user, or null.
function currentUser(req) {
  const s = parseSession(req);
  return s ? { id: s.userId, name: s.name } : null;
}

function requireAuth(req, res) {
  if (isAuthed(req)) return true;
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

// Like requireAuth but returns the user object ({id,name}); writes 401 + null on miss.
function requireUser(req, res) {
  const u = currentUser(req);
  if (u) return u;
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return null;
}

function setAuthCookie(res, userId) {
  const val = makeCookie(userId);
  const cookie = `${COOKIE}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${Math.floor(TTL_MS / 1000)}`;
  res.setHeader('Set-Cookie', cookie);
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`);
}

// Verify a PIN against a stored scrypt hash (scrypt$<saltHex>$<hashHex>),
// constant-time. Returns false on any malformed input — including the empty
// string an unset owner env hash produces.
function verifyScrypt(pin, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected, derived;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
    if (!salt.length || !expected.length) return false;
    derived = crypto.scryptSync(pin, salt, expected.length);
  } catch { return false; }
  if (derived.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(derived, expected); }
  catch { return false; }
}

// Produce a fresh scrypt PIN hash string: scrypt$<saltHex>$<hashHex>.
function makeScryptHash(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// The owner-set env hash for a user — '' when the owner has set none, which is
// the normal case. A plaintext override (BROWNLIFE_PIN_*) is converted to a
// scrypt hash so the whole pipeline is uniformly hash-based.
function envHashFor(u) {
  return u.pinPlain ? makeScryptHash(u.pinPlain) : u.pinHash;
}

// Effective PIN hash per user: the owner-set env hash (usually empty) overlaid
// with the DB row when one exists. On a DB error only the owner-set env hash
// survives — and with none set, NOBODY can sign in. That is deliberate: the old
// fallback here was a pair of published default hashes, so a Supabase blip
// silently reopened the public PINs. A brief lockout during a Hub outage is the
// price of never failing open.
async function loadPinHashes() {
  const map = {};
  for (const u of USERS) map[u.id] = envHashFor(u);
  try {
    const rows = await supaSelect(AUTH_TABLE, 'select=id,pin_hash');
    if (Array.isArray(rows)) {
      for (const r of rows) if (r && r.id && r.pin_hash) map[r.id] = r.pin_hash;
    }
  } catch { /* fail closed: only an owner-set env hash (if any) survives */ }
  return map;
}

// Identify which user a PIN belongs to. Returns { id, name } or null.
// Checks every user (no early-out) to keep timing roughly constant.
async function identifyPin(input) {
  if (!input || typeof input !== 'string' || !/^[0-9]{6}$/.test(input)) return null;
  const hashes = await loadPinHashes();
  let match = null;
  for (const u of USERS) {
    const ok = verifyScrypt(input, hashes[u.id]);
    if (ok && !match) match = { id: u.id, name: u.name };
  }
  return match;
}

// Bootstrap a user's DB row from the owner-set env hash on first login after
// deploy. insert-if-missing: never overwrites a user-chosen PIN, and never
// writes an empty hash when no owner env hash is set. Non-fatal.
async function seedPinIfMissing(userId) {
  const u = USERS.find((x) => x.id === userId);
  if (!u) return;
  const seed = envHashFor(u);
  if (!seed) return;
  try {
    const rows = await supaSelect(AUTH_TABLE, `id=eq.${encodeURIComponent(userId)}&select=id&limit=1`);
    if (rows && rows[0]) return;
    await supaInsert(AUTH_TABLE, {
      id: userId, name: u.name, pin_hash: seed, updated_at: new Date().toISOString(),
    }, { returning: false });
  } catch { /* non-fatal: the DB row, once present, is authoritative */ }
}

// Change a user's PIN. Re-verifies the CURRENT pin against the effective hash,
// rejects an unchanged PIN, then persists a fresh scrypt hash for THIS user
// only. Throws if the DB write fails (caller surfaces a retry message).
// Returns { ok:true } or { ok:false, error }.
async function changePin(userId, currentPin, newPin) {
  const u = USERS.find((x) => x.id === userId);
  if (!u) return { ok: false, error: 'Unknown user.' };
  if (!/^[0-9]{6}$/.test(String(newPin || ''))) {
    return { ok: false, error: 'New PIN must be 6 digits.' };
  }
  const hashes = await loadPinHashes();
  const cur = hashes[userId];
  if (!cur || !verifyScrypt(String(currentPin || ''), cur)) {
    return { ok: false, error: 'Current PIN is incorrect.' };
  }
  if (verifyScrypt(String(newPin), cur)) {
    return { ok: false, error: 'New PIN must be different from your current PIN.' };
  }
  const payload = { name: u.name, pin_hash: makeScryptHash(newPin), updated_at: new Date().toISOString() };
  const rows = await supaSelect(AUTH_TABLE, `id=eq.${encodeURIComponent(userId)}&select=id&limit=1`);
  if (rows && rows[0]) {
    await supaPatch(AUTH_TABLE, `id=eq.${encodeURIComponent(userId)}`, payload);
  } else {
    await supaInsert(AUTH_TABLE, { id: userId, ...payload }, { returning: false });
  }
  return { ok: true };
}

module.exports = {
  isAuthed, requireAuth, requireUser, currentUser,
  setAuthCookie, clearAuthCookie, identifyPin, seedPinIfMissing, changePin, USERS,
};
