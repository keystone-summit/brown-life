// =====================================================================
// tests/farm-persistence.test.js
//
// 🔒 Locked 2026-09-14. John added a property to his farm watch list and it
// was gone the next day. It had been saved in the ORIGINAL farm page, which
// kept everything in the browser's localStorage (key farm-command-v1) — one
// device, one browser, and gone when that storage was cleared. He asked for
// the opposite: "keep it live everywhere."
//
// Brown Life's Farm keeps the watch list, the plan-doc link and the 90-day
// checkboxes in Supabase (dblife_farm), served by api/farm.js. This test
// holds that line end to end:
//   * an edit made on one device is there on another device, after a cold
//     start (nothing cached in the function);
//   * every edit control on the page saves through the server (op -> PATCH),
//     never to browser storage;
//   * the page re-reads the server when the phone app comes back to the front.
//
// Behavioural checks load the REAL api/farm.js and api/_lib/auth.js against
// an in-memory supa stub. Run: node tests/farm-persistence.test.js
// =====================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const AUTH = path.join(ROOT, 'api', '_lib', 'auth.js');
const SUPA = path.join(ROOT, 'api', '_lib', 'supa.js');
const FARM = path.join(ROOT, 'api', 'farm.js');

let failures = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  OK  ' + label); return; }
  failures++;
  console.log('  FAIL ' + label + (detail ? ' -- ' + detail : ''));
}

const ROTATED = '2026-09-15T03:02:09+00:00';   // John's PIN changed -> Farm unlocked
const SECRET = 'test-' + crypto.randomBytes(16).toString('hex');

// One shared store = "the server". Devices only ever hold a session cookie.
function fakeDb() {
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const db = {
    dblife_auth_users: [{ id: 'john', updated_at: ROTATED }, { id: 'lisa', updated_at: ROTATED }],
    dblife_farm: [{ user_id: 'john', content: { title: 'The Farm' }, state: { doc: '', listings: [], checks: {} },
      watch: { weekOf: 'fixture-week', parcels: [{ name: 'Fixture watch parcel', county: 'X', acres: 60, price: 1, score: 40, link: 'https://listing.example/w' }] } }],
  };
  const filt = (q) => {
    const f = {};
    for (const m of String(q || '').matchAll(/(?:^|&)([a-z_]+)=eq\.([^&]*)/g)) f[m[1]] = decodeURIComponent(m[2]);
    return (r) => Object.keys(f).every((k) => String(r[k]) === f[k]);
  };
  db.impl = {
    supaSelect: async (t, q) => copy((db[t] || []).filter(filt(q))),
    supaPatch: async (t, q, row) => { const hit = (db[t] || []).filter(filt(q)); hit.forEach((r) => Object.assign(r, copy(row))); return copy(hit); },
    supaInsert: async () => { throw new Error('farm must never insert'); },
    supaDelete: async () => { throw new Error('farm must never delete'); },
  };
  return db;
}

// A cold start of the serverless function: fresh modules, same database.
function coldStart(db) {
  process.env.BROWNLIFE_AUTH_SECRET = SECRET;
  delete require.cache[AUTH];
  delete require.cache[FARM];
  require.cache[SUPA] = { id: SUPA, filename: SUPA, loaded: true, exports: db.impl };
  const auth = require(AUTH);
  const farm = require(FARM);
  const sessionFor = (uid) => {
    const hdr = {};
    auth.setAuthCookie({ setHeader: (k, v) => { hdr[k.toLowerCase()] = v; } }, uid);
    return String(hdr['set-cookie']).split(';')[0];
  };
  return { farm, sessionFor };
}

async function call(farm, { method = 'GET', cookie, body } = {}) {
  const chunks = body === undefined ? [] : [JSON.stringify(body)];
  const req = { method, url: '/api/farm', headers: { host: 'localhost', cookie },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
  let raw = '';
  const res = { statusCode: 200, setHeader() {}, end: (s) => { raw = s || ''; } };
  await farm(req, res);
  let json = null; try { json = JSON.parse(raw); } catch {}
  return { status: res.statusCode, json, raw };
}

(async function main() {
  console.log('farm-persistence.test -- begin');
  const db = fakeDb();

  // ---- Phone: add a property, set the plan link, tick a box ----------------
  let s = coldStart(db);
  const phone = s.sessionFor('john');
  let r = await call(s.farm, { method: 'PATCH', cookie: phone, body: { op: 'addListing', listing: { name: 'Fixture parcel', county: 'X', acres: '52', price: '310000', score: '38', link: 'https://listing.example/p' } } });
  ok('phone: add a property -> 200', r.status === 200, r.raw);
  r = await call(s.farm, { method: 'PATCH', cookie: phone, body: { op: 'doc', value: 'https://docs.example/plan' } });
  ok('phone: set the plan-doc link -> 200', r.status === 200, r.raw);
  r = await call(s.farm, { method: 'PATCH', cookie: phone, body: { op: 'check', i: 2, on: true } });
  ok('phone: tick a 90-day box -> 200', r.status === 200, r.raw);
  r = await call(s.farm, { method: 'PATCH', cookie: phone, body: { op: 'addListing', listing: { name: 'Fixture watch parcel', county: 'X', acres: 60, price: 1, score: 40, link: 'https://listing.example/w' } } });
  ok('phone: Track a weekly-watch parcel -> 200', r.status === 200, r.raw);
  ok('all four edits landed in the database row, not the device',
    db.dblife_farm[0].state.listings.length === 2 && db.dblife_farm[0].state.doc === 'https://docs.example/plan' && db.dblife_farm[0].state.checks['2'] === true);

  // ---- Desktop, next day: a different session, a cold function -------------
  s = coldStart(db);
  const desktop = s.sessionFor('john');
  ok('desktop session is a different device (different cookie)', desktop !== phone);
  r = await call(s.farm, { cookie: desktop });
  const st = r.json && r.json.state;
  ok('desktop: GET -> 200', r.status === 200, r.raw);
  ok('desktop sees the property added on the phone',
    st && st.listings.some((l) => l.name === 'Fixture parcel' && l.acres === 52 && l.score === 38), JSON.stringify(st && st.listings));
  ok('desktop sees the tracked weekly parcel', st && st.listings.some((l) => l.name === 'Fixture watch parcel'));
  ok('desktop sees the plan-doc link', st && st.doc === 'https://docs.example/plan');
  ok('desktop sees the ticked box', st && st.checks && st.checks['2'] === true);

  // ---- Desktop removes one; the phone sees that too -------------------------
  const id = st.listings.find((l) => l.name === 'Fixture parcel').id;
  r = await call(s.farm, { method: 'PATCH', cookie: desktop, body: { op: 'removeListing', id } });
  ok('desktop: remove -> 200', r.status === 200);
  s = coldStart(db);
  r = await call(s.farm, { cookie: phone });
  ok('phone sees the removal (and keeps the other listing)',
    r.status === 200 && !r.json.state.listings.some((l) => l.id === id) && r.json.state.listings.length === 1, r.raw);

  // ---- Signed out on every device: the data is still there ------------------
  s = coldStart(db);
  r = await call(s.farm, { cookie: s.sessionFor('john') });
  ok('a brand-new sign-in still sees everything saved', r.status === 200 && r.json.state.listings.length === 1 && r.json.state.doc);

  // ---- K shares the same plan (her PIN changed in this fixture) ------------
  s = coldStart(db);
  const kPhone = s.sessionFor('lisa');
  r = await call(s.farm, { cookie: kPhone });
  ok('K sees John\'s saved listing and plan link', r.status === 200 && r.json.state.listings.length === 1 && r.json.state.doc === 'https://docs.example/plan', r.raw);
  r = await call(s.farm, { method: 'PATCH', cookie: kPhone, body: { op: 'check', i: 5, on: true } });
  ok('K ticks a 90-day box -> 200', r.status === 200, r.raw);
  s = coldStart(db);
  r = await call(s.farm, { cookie: s.sessionFor('john') });
  ok('John, on another device, sees K\'s tick', r.status === 200 && r.json.state.checks['5'] === true, r.raw);

  // ---- STATIC: the page saves through the server, never the browser ---------
  const html = fs.readFileSync(path.join(ROOT, 'farm.html'), 'utf8');
  ok('page: plan-doc link saves via the server', /op\(\{op:'doc'/.test(html));
  ok('page: Add and Track both save via the server', (html.match(/op\(\{op:'addListing'/g) || []).length >= 2);
  ok('page: Remove saves via the server', /op\(\{op:'removeListing'/.test(html));
  ok('page: 90-day boxes save via the server', /op\(\{op:'check'/.test(html));
  ok('page: op() is a PATCH to /api/farm', /fetch\(API,\{method:'PATCH'/.test(html) && /var API='\/api\/farm'/.test(html));
  ok('page: nothing kept in browser storage', !/localStorage|sessionStorage|indexedDB|window\.storage/.test(html));
  ok('page: the old browser-storage key is gone', !/farm-command-v1/.test(html));
  ok('page: re-reads the server when the phone app returns to the front',
    /visibilitychange[^\n]*load\(\)/.test(html) && /pageshow[^\n]*load\(\)/.test(html));

  // ---- This test gates the build ----------------------------------------------
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  ok('gate: vercel.json ignoreCommand runs this test', /tests\/farm-persistence\.test\.js/.test(vercel.ignoreCommand || ''));
  ok('gate: the CI guard runs this test', /tests\/farm-persistence\.test\.js/.test(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'guard.yml'), 'utf8')));

  if (failures) { console.log('\nfarm-persistence.test -- FAILED (' + failures + ')'); process.exit(1); }
  console.log('\nfarm-persistence.test -- PASS');
})().catch((e) => { console.log('  FAIL harness threw -- ' + (e && e.message || e)); process.exit(1); });
