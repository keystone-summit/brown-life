// =====================================================================
// tests/farm.test.js
//
// 🔒 Locked 2026-09-14. The Farm is John's personal plan (money, land,
// family). This repo is PUBLIC, so the plan lives in Supabase and is served
// only by api/farm.js. This test holds that line:
//
//   * nobody but John gets any of it — no session 401, the other user 403;
//   * it stays locked (423) while John's PIN is still the published default,
//     and fails closed if the DB can't say otherwise;
//   * the Monday task's token can replace the watch and nothing else;
//   * every write is whitelisted and typed (no javascript: links);
//   * the renderer in the repo carries no plan figures, and no localStorage.
//
// Behavioural checks load the REAL api/farm.js and api/_lib/auth.js against a
// stubbed supa module. Run: node tests/farm.test.js   (exit 1 on any failure)
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

const MARKER = 'FIXTURE-PLAN-' + crypto.randomBytes(4).toString('hex');
const SEEDED = '2026-06-07T11:39:22.828184+00:00';   // default PINs written
const ROTATED = '2026-09-20T08:00:00+00:00';         // John changed his PIN
const TOKEN = crypto.randomBytes(32).toString('hex');

function farmRow() {
  return {
    user_id: 'john',
    content: { title: 'The Farm', secret: MARKER },
    state: { doc: '', listings: [], checks: {} },
    watch: { weekOf: '', parcels: [] },
    updated_at: SEEDED,
  };
}

// In-memory stand-in for the two tables api/farm.js reads.
function fakeDb({ pinAt = ROTATED, row = farmRow(), down = false } = {}) {
  const db = { auth: pinAt ? [{ id: 'john', updated_at: pinAt }, { id: 'lisa', updated_at: SEEDED }] : [], farm: row ? [row] : [], patches: [] };
  db.impl = {
    supaSelect: async (table, q) => {
      if (down) throw new Error('supabase unreachable (test)');
      if (table === 'dblife_auth_users') return db.auth.filter((r) => q.includes('id=eq.' + r.id));
      if (table === 'dblife_farm') return db.farm.filter((r) => q.includes('user_id=eq.' + r.user_id));
      return [];
    },
    supaPatch: async (table, q, patch) => {
      if (down) throw new Error('supabase unreachable (test)');
      db.patches.push({ table, q, patch });
      const r = db.farm.find((x) => q.includes('user_id=eq.' + x.user_id));
      if (!r) return [];
      Object.assign(r, JSON.parse(JSON.stringify(patch)));
      return [r];
    },
    supaInsert: async () => { throw new Error('farm must never insert'); },
    supaDelete: async () => { throw new Error('farm must never delete'); },
  };
  return db;
}

// Fresh copies of the real auth.js + farm.js wired to `db`.
function load(db) {
  process.env.BROWNLIFE_AUTH_SECRET = 'test-' + crypto.randomBytes(16).toString('hex');
  delete require.cache[AUTH];
  delete require.cache[FARM];
  require.cache[SUPA] = { id: SUPA, filename: SUPA, loaded: true, exports: db.impl };
  const auth = require(AUTH);
  const farm = require(FARM);
  const cookieFor = (uid) => {
    const hdr = {};
    auth.setAuthCookie({ setHeader: (k, v) => { hdr[k.toLowerCase()] = v; } }, uid);
    return String(hdr['set-cookie']).split(';')[0];
  };
  return { farm, cookieFor };
}

async function call(farm, { method = 'GET', url = '/api/farm', cookie = '', authz, body } = {}) {
  const chunks = body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)];
  const headers = { host: 'localhost', cookie };
  if (authz) headers.authorization = authz;
  const req = { method, url, headers, [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; } };
  const hdr = {};
  let raw = '';
  const res = { statusCode: 200, setHeader: (k, v) => { hdr[k.toLowerCase()] = v; }, end: (s) => { raw = s || ''; } };
  await farm(req, res);
  let json = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.statusCode, json, raw, hdr };
}

(async function main() {
  console.log('farm.test -- begin');

  // ---- 1. Who gets in ---------------------------------------------------
  {
    const db = fakeDb();
    const { farm, cookieFor } = load(db);
    const anon = await call(farm);
    ok('no session: 401 and none of the plan', anon.status === 401 && !anon.raw.includes(MARKER), anon.raw);
    const lisa = await call(farm, { cookie: cookieFor('lisa') });
    ok('the other Brown Life user: 403 and none of the plan', lisa.status === 403 && !lisa.raw.includes(MARKER), lisa.raw);
    const lisaW = await call(farm, { url: '/api/farm?part=watch', cookie: cookieFor('lisa') });
    ok('the other user cannot read the watch either', lisaW.status === 403);
    const lisaP = await call(farm, { method: 'PATCH', cookie: cookieFor('lisa'), body: { op: 'doc', value: 'https://x.test' } });
    ok('the other user cannot write', lisaP.status === 403 && db.patches.length === 0);
    const forged = await call(farm, { cookie: 'brownlife_auth=john.2099-01-01T00:00:00.000Z.AAAA' });
    ok('a forged cookie gets nothing', forged.status === 401);
    const john = await call(farm, { cookie: cookieFor('john') });
    ok('John, PIN changed: 200 with the plan', john.status === 200 && john.json.content.secret === MARKER, john.raw);
    ok('responses are no-store', john.hdr['cache-control'] === 'no-store');
    ok('state comes back normalized', john.json.state && Array.isArray(john.json.state.listings) && typeof john.json.state.checks === 'object');
    const w = await call(farm, { url: '/api/farm?part=watch', cookie: cookieFor('john') });
    ok('John reads the watch as {weekOf, parcels}', w.status === 200 && Array.isArray(w.json.parcels) && 'weekOf' in w.json, w.raw);
  }

  // ---- 2. Locked while the published default PIN still works ------------
  {
    const db = fakeDb({ pinAt: SEEDED });
    const { farm, cookieFor } = load(db);
    const r = await call(farm, { cookie: cookieFor('john') });
    ok('John, PIN never changed: 423 and none of the plan', r.status === 423 && !r.raw.includes(MARKER), r.raw);
    const p = await call(farm, { method: 'PATCH', cookie: cookieFor('john'), body: { op: 'check', i: 0, on: true } });
    ok('locked: writes are refused too', p.status === 423 && db.patches.length === 0);
  }
  {
    const { farm, cookieFor } = load(fakeDb({ pinAt: null }));
    const r = await call(farm, { cookie: cookieFor('john') });
    ok('no PIN row for John: locked (fail closed)', r.status === 423 && !r.raw.includes(MARKER));
  }
  {
    const { farm, cookieFor } = load(fakeDb({ down: true }));
    const r = await call(farm, { cookie: cookieFor('john') });
    ok('DB unreachable: 500, no plan, no DB error text', r.status === 500 && !r.raw.includes(MARKER) && !/supabase/i.test(r.raw), r.raw);
  }

  // ---- 3. John's writes are typed and whitelisted -----------------------
  {
    const db = fakeDb();
    const { farm, cookieFor } = load(db);
    const c = cookieFor('john');
    const patch = (body) => call(farm, { method: 'PATCH', cookie: c, body });

    let r = await patch({ op: 'addListing', listing: { name: '<b>Test</b> parcel', county: 'X', acres: '52', price: '249000', score: 99, link: 'javascript:alert(1)', extra: 'dropped' } });
    const l = r.json && r.json.state.listings[0];
    ok('addListing saves and returns an id', r.status === 200 && l && typeof l.id === 'string' && l.id.length > 0, r.raw);
    ok('addListing: numbers typed, score capped at 50', l && l.acres === 52 && l.price === 249000 && l.score === 50, JSON.stringify(l));
    ok('addListing: a javascript: link is dropped', l && l.link === '', JSON.stringify(l));
    ok('addListing: unknown fields are dropped', l && !('extra' in l));
    ok('addListing persisted to the row', db.farm[0].state.listings.length === 1);

    r = await patch({ op: 'addListing', listing: { name: '  ' } });
    ok('addListing without a name: 400', r.status === 400);

    r = await patch({ op: 'check', i: 3, on: true });
    ok('check on persists', r.status === 200 && db.farm[0].state.checks['3'] === true);
    r = await patch({ op: 'check', i: 3, on: false });
    ok('check off persists', r.status === 200 && !db.farm[0].state.checks['3']);
    r = await patch({ op: 'check', i: 'x', on: true });
    ok('check with a bad index: 400', r.status === 400);

    r = await patch({ op: 'doc', value: 'javascript:alert(1)' });
    ok('doc link must be http(s): 400', r.status === 400 && db.farm[0].state.doc === '');
    r = await patch({ op: 'doc', value: 'https://docs.example/plan' });
    ok('doc link saves', r.status === 200 && db.farm[0].state.doc === 'https://docs.example/plan');

    r = await patch({ op: 'removeListing', id: l.id });
    ok('removeListing removes it', r.status === 200 && db.farm[0].state.listings.length === 0);

    r = await patch({ op: 'wipeEverything' });
    ok('unknown op: 400', r.status === 400);
    r = await call(farm, { method: 'PATCH', cookie: c, body: '{not json' });
    ok('bad JSON: 400', r.status === 400);
    ok('John\'s writes never touch the plan content or the watch',
       db.patches.filter((p) => p.patch.state).every((p) => !('content' in p.patch) && !('watch' in p.patch)));
  }

  // ---- 4. The Monday task: token writes the watch, nothing else ----------
  {
    const db = fakeDb();
    const { farm, cookieFor } = load(db);
    const good = { weekOf: '2026-09-14', parcels: [{ name: 'Test parcel', county: 'X', acres: 52, price: 249000, score: 38, link: 'https://listing.example/1', why: 'w'.repeat(900), drive: 'yes', extra: 1 }] };
    const put = (authz, body, url = '/api/farm?part=watch') => call(farm, { method: 'PUT', url, authz, body });

    delete process.env.FARM_WATCH_TOKEN;
    let r = await put('Bearer ' + TOKEN, good);
    ok('token not configured: every PUT refused', r.status === 401 && db.patches.length === 0);
    process.env.FARM_WATCH_TOKEN = 'short';
    r = await put('Bearer short', good);
    ok('a too-short configured token is refused', r.status === 401 && db.patches.length === 0);
    process.env.FARM_WATCH_TOKEN = TOKEN;
    r = await put(undefined, good);
    ok('no token: 401', r.status === 401);
    r = await put('Bearer ' + crypto.randomBytes(32).toString('hex'), good);
    ok('wrong token: 401', r.status === 401 && db.patches.length === 0);
    r = await call(farm, { method: 'PUT', url: '/api/farm?part=watch', cookie: cookieFor('john'), body: good });
    ok('a session is not a token: 401', r.status === 401);
    r = await put('Bearer ' + TOKEN, { parcels: 'nope' });
    ok('bad shape: 400', r.status === 400);
    r = await put('Bearer ' + TOKEN, { weekOf: 'x', parcels: [{ county: 'X' }] });
    ok('parcel without a name: 400', r.status === 400 && /parcels\[0\]/.test(r.raw));

    r = await put('Bearer ' + TOKEN, { ...good, parcels: [...good.parcels, { name: 'Bad link', link: 'javascript:alert(1)' }] });
    ok('good token + good body: 200', r.status === 200 && r.json.parcels === 2, r.raw);
    const saved = db.farm[0].watch;
    ok('watch saved with weekOf', saved.weekOf === '2026-09-14');
    ok('watch parcels are whitelisted (no extra fields)', !('extra' in saved.parcels[0]));
    ok('watch text is capped (why <= 500)', saved.parcels[0].why.length === 500);
    ok('watch drops javascript: links', saved.parcels[1].link === '');
    const last = db.patches[db.patches.length - 1].patch;
    ok('the token touches only watch + watch_updated_at',
       Object.keys(last).sort().join(',') === 'watch,watch_updated_at', Object.keys(last).join(','));
    ok('the token response carries none of the plan', !r.raw.includes(MARKER));

    r = await call(farm, { method: 'PUT', url: '/api/farm', authz: 'Bearer ' + TOKEN, cookie: cookieFor('john'), body: good });
    ok('PUT without part=watch is not a write path', r.status === 405);
  }

  // ---- 5. STATIC: the public repo carries a renderer, not the plan -------
  const html = fs.readFileSync(path.join(ROOT, 'farm.html'), 'utf8');
  ok('farm.html loads the plan from /api/farm', /fetch\(API/.test(html) && /var API='\/api\/farm'/.test(html));
  ok('farm.html has no dollar figures', !/\$\s?\d/.test(html), (html.match(/\$\s?\d[^'"<]{0,12}/) || [''])[0]);
  ok('farm.html has no years or dates', !/\b20\d\d\b/.test(html), (html.match(/\b20\d\d\b/) || [''])[0]);
  ok('farm.html has no acreage figures', !/\d\s?ac\b/.test(html));
  ok('farm.html keeps nothing in localStorage', !/localStorage|sessionStorage|indexedDB/.test(html));
  ok('farm.html escapes what it renders', /function esc\(/.test(html) && /function safeUrl\(/.test(html));

  const tracked = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else tracked.push(path.relative(ROOT, p));
    }
  })(ROOT);
  ok('no land-watch data file is committed (it would be public)',
     !tracked.some((p) => /land-watch/i.test(p)), tracked.filter((p) => /land-watch/i.test(p)).join(', '));

  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  ok('/land-watch.json is served by the private API',
     (vercel.rewrites || []).some((r) => r.source === '/land-watch.json' && r.destination === '/api/farm?part=watch'));
  ok('this test gates the Vercel build', /tests\/farm\.test\.js/.test(vercel.ignoreCommand || ''));

  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok('the deck card opens /farm and only for John', /user\.id === 'john' && \(\s*<a href="\/farm"/.test(index));

  if (failures) {
    console.log('\nfarm.test -- FAILED (' + failures + ')');
    process.exit(1);
  }
  console.log('\nfarm.test -- PASS');
})().catch((e) => { console.log('  FAIL harness threw -- ' + (e && e.stack || e)); process.exit(1); });
