// =====================================================================
// tests/pin-change.test.js
//
// 🔒 Locked 2026-09-14. John was locked out of The Farm: it said "change your
// PIN" and on his iPhone there was no way to reach the Change-PIN screen
// (Settings is the last tab of a sideways-scrolling phone tab bar, and the
// lock notice sent him to Today). This test holds the whole path open:
//
//   * sign-in still works, before and after a change (the one thing that
//     must never regress);
//   * change-PIN needs a session, re-verifies the current PIN, keeps the
//     6-digit rule, and is rate-limited in its own namespace;
//   * a successful change stores a fresh scrypt hash for THAT user only,
//     ends the session, retires the old PIN, and clears The Farm's lock;
//   * no PIN or hash ever reaches the logs;
//   * the Change-PIN screen is reachable on a phone (top-bar button +
//     ?tab=settings deep link) and The Farm's lock notice links to it.
//
// Behavioural checks load the REAL api/auth.js, api/change-pin.js,
// api/farm.js, api/_lib/auth.js and api/_lib/ratelimit.js against an
// in-memory supa stub. PINs are random fixtures and are never printed.
// Run: node tests/pin-change.test.js   (exit 1 on any failure)
// =====================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SUPA = path.join(ROOT, 'api', '_lib', 'supa.js');
const MODS = {
  lib:    path.join(ROOT, 'api', '_lib', 'auth.js'),
  rl:     path.join(ROOT, 'api', '_lib', 'ratelimit.js'),
  login:  path.join(ROOT, 'api', 'auth.js'),
  change: path.join(ROOT, 'api', 'change-pin.js'),
  farm:   path.join(ROOT, 'api', 'farm.js'),
};

let failures = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  OK  ' + label); return; }
  failures++;
  console.log('  FAIL ' + label + (detail ? ' -- ' + detail : ''));
}

const SEEDED = '2026-06-07T11:39:22.828184+00:00';   // default PINs written (farm.js threshold is 12:00Z)
const FARM_THRESHOLD = Date.parse('2026-06-07T12:00:00Z');

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pin, salt, 32).toString('hex');
}
function randPin(avoid) {
  for (;;) {
    const p = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!avoid.includes(p)) return p;
  }
}

// In-memory stand-in for every table the auth + farm paths touch.
function fakeDb(pins) {
  const db = {
    dblife_auth_users: [
      { id: 'john', name: 'D', pin_hash: hashPin(pins.john), updated_at: SEEDED },
      { id: 'lisa', name: 'K', pin_hash: hashPin(pins.lisa), updated_at: SEEDED },
    ],
    dblife_auth_attempts: [],
    dblife_farm: [{ user_id: 'john', content: { title: 'The Farm' }, state: {}, watch: { weekOf: '', parcels: [] }, updated_at: SEEDED }],
    writes: [],
  };
  const filt = (q) => {
    const f = {};
    for (const m of String(q || '').matchAll(/(?:^|&)([a-z_]+)=eq\.([^&]*)/g)) f[m[1]] = decodeURIComponent(m[2]);
    return (r) => Object.keys(f).every((k) => String(r[k]) === f[k]);
  };
  const copy = (x) => JSON.parse(JSON.stringify(x));
  db.impl = {
    supaSelect: async (t, q) => copy((db[t] || []).filter(filt(q))),
    supaInsert: async (t, row) => { db.writes.push({ t, op: 'insert', row: copy(row) }); db[t].push(copy(row)); return null; },
    supaPatch:  async (t, q, row) => {
      db.writes.push({ t, op: 'patch', row: copy(row) });
      const hit = db[t].filter(filt(q)); hit.forEach((r) => Object.assign(r, copy(row))); return copy(hit);
    },
    supaDelete: async (t, q) => { const keep = filt(q); db[t] = db[t].filter((r) => !keep(r)); return true; },
  };
  return db;
}

// Fresh copies of the real modules wired to `db`.
function load(db) {
  process.env.BROWNLIFE_AUTH_SECRET = 'test-' + crypto.randomBytes(16).toString('hex');
  ['BROWNLIFE_PIN_HASH_JOHN', 'BROWNLIFE_PIN_HASH_LISA', 'BROWNLIFE_PIN_JOHN', 'BROWNLIFE_PIN_LISA', 'DBLIFE_AUTH_SECRET']
    .forEach((k) => { delete process.env[k]; });
  Object.values(MODS).forEach((p) => { delete require.cache[p]; });
  require.cache[SUPA] = { id: SUPA, filename: SUPA, loaded: true, exports: db.impl };
  const m = {};
  for (const [k, p] of Object.entries(MODS)) m[k] = require(p);
  return m;
}

// Every console line the handlers write, so we can prove no PIN/hash leaks.
const logged = [];
['log', 'warn', 'error', 'info'].forEach((lvl) => {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => {
    const line = a.map(String).join(' ');
    const ours = line.startsWith('  OK  ') || line.startsWith('  FAIL ') || line.includes('pin-change.test --');
    if (ours) orig(...a); else logged.push(line); // handler audit lines are captured, not printed
  };
});

async function call(handler, { method = 'GET', url = '/', cookie = '', body, ip = '198.51.100.7' } = {}) {
  const chunks = body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)];
  const req = {
    method, url, headers: { host: 'localhost', cookie, 'x-forwarded-for': ip },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; },
  };
  const hdr = {};
  let raw = '';
  const res = { statusCode: 200, setHeader: (k, v) => { hdr[k.toLowerCase()] = v; }, end: (s) => { raw = s || ''; } };
  await handler(req, res);
  let json = null;
  try { json = JSON.parse(raw); } catch {}
  const setCookie = String(hdr['set-cookie'] || '');
  return { status: res.statusCode, json, raw, hdr, setCookie, cookie: setCookie.split(';')[0] };
}

const login  = (m, pin, ip) => call(m.login, { method: 'POST', url: '/api/auth', body: { pin }, ip });
const change = (m, cookie, cur, nw, cf = nw, ip) =>
  call(m.change, { method: 'POST', url: '/api/change-pin', cookie, body: { current_pin: cur, new_pin: nw, confirm_pin: cf }, ip });

(async function main() {
  console.log('pin-change.test -- begin');
  const P = {};
  P.john = randPin([]);
  P.lisa = randPin([P.john]);
  P.next = randPin([P.john, P.lisa]);
  P.wrong = randPin([P.john, P.lisa, P.next]);

  // ---- 1. Sign-in works (must never regress) ------------------------------
  const db = fakeDb(P);
  let m = load(db);
  const j = await login(m, P.john);
  ok('sign-in: John\'s PIN signs John in', j.status === 200 && j.json.user && j.json.user.id === 'john', j.raw);
  ok('sign-in: issues the HttpOnly session cookie', /^brownlife_auth=/.test(j.cookie) && /HttpOnly/.test(j.setCookie) && /Secure/.test(j.setCookie));
  const l = await login(m, P.lisa);
  ok('sign-in: the other PIN signs the other user in', l.status === 200 && l.json.user.id === 'lisa', l.raw);
  const bad = await login(m, P.wrong);
  ok('sign-in: a wrong PIN is refused', bad.status === 401);
  ok('sign-in: a 4-digit PIN is refused', (await login(m, P.john.slice(0, 4))).status === 401);
  const me = await call(m.login, { cookie: j.cookie });
  ok('session: GET /api/auth reports John', me.json.authed === true && me.json.user.id === 'john');

  // ---- 2. The lock John hit -------------------------------------------------
  const farmBefore = await call(m.farm, { url: '/api/farm', cookie: j.cookie });
  ok('farm: locked (423) while John\'s PIN is the seeded one', farmBefore.status === 423, farmBefore.raw);

  // ---- 3. Change-PIN guards (none of these may write) -----------------------
  const writesBefore = db.writes.filter((w) => w.t === 'dblife_auth_users').length;
  ok('change: GET is 405', (await call(m.change, { url: '/api/change-pin', cookie: j.cookie })).status === 405);
  ok('change: no session -> 401', (await change(m, '', P.john, P.next)).status === 401);
  ok('change: forged session -> 401',
    (await change(m, 'brownlife_auth=john.2099-01-01T00:00:00.000Z.AAAA', P.john, P.next)).status === 401);
  let r = await change(m, j.cookie, P.john, P.next.slice(0, 5));
  ok('change: new PIN must be 6 digits -> 400', r.status === 400 && /6 digits/.test(r.json.error), r.raw);
  r = await change(m, j.cookie, P.john, 'abcdef');
  ok('change: letters refused -> 400', r.status === 400);
  r = await change(m, j.cookie, P.john, P.next, P.wrong);
  ok('change: confirmation mismatch -> 400', r.status === 400 && /match/.test(r.json.error), r.raw);
  r = await change(m, j.cookie, P.john, P.john);
  ok('change: same as current -> 400', r.status === 400 && /different/.test(r.json.error), r.raw);
  r = await change(m, j.cookie, P.wrong, P.next);
  ok('change: wrong current PIN -> 401', r.status === 401 && /incorrect/i.test(r.json.error), r.raw);
  ok('change: none of the refused attempts wrote a PIN',
    db.writes.filter((w) => w.t === 'dblife_auth_users').length === writesBefore);
  ok('change: a user-mistake does not count as a guess; a wrong current PIN does',
    (db.dblife_auth_attempts.find((a) => a.ip === 'pinchg:john:198.51.100.7') || {}).fails === 1);

  // ---- 4. Success -----------------------------------------------------------
  const lisaRow = JSON.stringify(db.dblife_auth_users.find((u) => u.id === 'lisa'));
  const oldHash = db.dblife_auth_users.find((u) => u.id === 'john').pin_hash;
  r = await change(m, j.cookie, P.john, P.next);
  ok('change: correct current + valid new -> 200', r.status === 200 && r.json.ok === true, r.raw);
  ok('change: the response carries no PIN or hash', !r.raw.includes(P.next) && !r.raw.includes(P.john) && !/scrypt/.test(r.raw));
  ok('change: session cookie is cleared (forces a fresh sign-in)', /^brownlife_auth=;/.test(r.setCookie) && /Max-Age=0/.test(r.setCookie));
  const row = db.dblife_auth_users.find((u) => u.id === 'john');
  ok('change: stored as a fresh scrypt$salt$hash', /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(row.pin_hash) && row.pin_hash !== oldHash);
  ok('change: the new PIN is never stored in plain text', !JSON.stringify(db.dblife_auth_users).includes(P.next));
  ok('change: updated_at moved past The Farm\'s default-PIN threshold', Date.parse(row.updated_at) > FARM_THRESHOLD, row.updated_at);
  ok('change: the other user\'s row is untouched', JSON.stringify(db.dblife_auth_users.find((u) => u.id === 'lisa')) === lisaRow);
  ok('change: its rate-limit counter is cleared on success', !db.dblife_auth_attempts.some((a) => a.ip.startsWith('pinchg:john:')));

  // ---- 5. After the change: old PIN dead, new PIN works, Farm unlocked -------
  m = load(db); // cold start: nothing cached between the change and the next sign-in
  ok('after: the old PIN no longer signs in', (await login(m, P.john)).status === 401);
  const j2 = await login(m, P.next);
  ok('after: the new PIN signs John in', j2.status === 200 && j2.json.user.id === 'john', j2.raw);
  ok('after: the other user still signs in with their PIN', (await login(m, P.lisa)).json.user.id === 'lisa');
  const farmAfter = await call(m.farm, { url: '/api/farm', cookie: j2.cookie });
  ok('after: The Farm is unlocked (200)', farmAfter.status === 200, farmAfter.raw);
  const farmLisa = await call(m.farm, { url: '/api/farm', cookie: (await login(m, P.lisa)).cookie });
  ok('after: The Farm is still John-only (other user 403)', farmLisa.status === 403);

  // ---- 6. Brute force on change-PIN is throttled ----------------------------
  {
    const P2 = { john: randPin([]), lisa: '' };
    P2.lisa = randPin([P2.john]);
    const next = randPin([P2.john, P2.lisa]);
    const db2 = fakeDb(P2);
    const m2 = load(db2);
    const c = (await login(m2, P2.john)).cookie;
    const guesses = [];
    for (let i = 0; i < 5; i++) guesses.push((await change(m2, c, randPin([P2.john]), next)).status);
    ok('limit: 4 wrong guesses are 401, the 5th locks (429)',
      guesses.slice(0, 4).every((s) => s === 401) && guesses[4] === 429, guesses.join(','));
    const locked = await change(m2, c, P2.john, next);
    ok('limit: while locked even the right PIN is refused (429 + Retry-After)',
      locked.status === 429 && Number(locked.hdr['retry-after']) > 0, locked.raw);
    ok('limit: nothing was written while guessing', !db2.writes.some((w) => w.t === 'dblife_auth_users'));
    ok('limit: change-PIN lockout does not lock sign-in (separate namespace)', (await login(m2, P2.john)).status === 200);
  }

  // ---- 7. Nothing secret in the logs ---------------------------------------
  const all = logged.join('\n');
  const leaked = Object.entries(P).filter(([, v]) => all.includes(v)).map(([k]) => k);
  ok('logs: no PIN value appears in any log line', leaked.length === 0, 'leaked fixture(s): ' + leaked.join(','));
  ok('logs: no scrypt hash appears in any log line', !/scrypt\$/.test(all));
  ok('logs: no session secret appears in any log line', !all.includes(process.env.BROWNLIFE_AUTH_SECRET));
  ok('logs: change-PIN attempts are audited by user id', /\[change-pin\] SUCCESS user=john/.test(all) && /\[change-pin\] FAIL user=john/.test(all));

  // ---- 8. STATIC: the screen is reachable on a phone ------------------------
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('ui: Settings tab exists and renders the Change-PIN form',
    /key: 'settings'/.test(index) && /tab === 'settings' && <Settings/.test(index) &&
    /'\/api\/change-pin'/.test(index) && /Current PIN/.test(index) && /Confirm new PIN/.test(index));
  const topbar = (index.match(/<header className="app-topbar">([\s\S]*?)<\/header>/) || ['', ''])[1];
  const pinBtn = topbar.split('\n').find((ln) => /<button\b/.test(ln) && ln.includes('data-change-pin')) || '';
  ok('ui: the top bar (always on screen) has a Change-PIN button', /onClick=\{\(\) => setTab\('settings'\)\}/.test(pinBtn), pinBtn || 'no button');
  ok('ui: that button is not hidden on phones', pinBtn && !/className="[^"]*\bhidden\b/.test(pinBtn));
  ok('ui: /?tab=settings deep-links to the Change-PIN screen',
    /URLSearchParams\(window\.location\.search\)\.get\('tab'\)/.test(index) && /useState\(initialTab\)/.test(index) &&
    /TAB_KEYS = \[[^\]]*'settings'/.test(index));
  ok('ui: new-PIN inputs stay numeric + masked (iPhone keypad)', /type="password"\s+inputMode="numeric"/.test(index));

  const farm = fs.readFileSync(path.join(ROOT, 'farm.html'), 'utf8');
  const lockLine = (farm.match(/r\.status===423[^\n]*/) || [''])[0];
  ok('ui: The Farm\'s lock notice links straight to the Change-PIN screen', /'\/\?tab=settings'/.test(lockLine), lockLine);

  // ---- 9. This test gates the build -----------------------------------------
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  ok('gate: vercel.json ignoreCommand runs this test', /tests\/pin-change\.test\.js/.test(vercel.ignoreCommand || ''));
  const guard = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'guard.yml'), 'utf8');
  ok('gate: the CI guard runs this test', /tests\/pin-change\.test\.js/.test(guard));

  if (failures) {
    console.log('\npin-change.test -- FAILED (' + failures + ')');
    process.exit(1);
  }
  console.log('\npin-change.test -- PASS');
})().catch((e) => { console.log('  FAIL harness threw -- ' + (e && e.message || e)); process.exit(1); });
