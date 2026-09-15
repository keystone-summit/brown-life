// The Farm — the family farm plan (D + K share ONE plan): plan content, the
// shared live state, the weekly land watch.
//
// GET   /api/farm               -> { content, state, watch, updated_at }
// PATCH /api/farm   {op, ...}   -> applies ONE change to state, returns { state }
//         ops: doc {value} · addListing {listing} · removeListing {id} · check {i, on}
// GET   /api/farm?part=watch    -> { weekOf, parcels }        (also at /land-watch.json)
// PUT   /api/farm?part=watch    -> replaces the watch. Bearer FARM_WATCH_TOKEN, no
//                                  session — this is how the Monday land-watch task
//                                  writes it. It can touch nothing else.
//
// 🔒 Private by construction. This repo is PUBLIC, so nothing personal ships in
// it: the plan text, numbers, counties, checklist and courses live in the
// dblife_farm row and are served only from here.
//   * Members only (FARM_MEMBERS: D = john, K = lisa — John approved
//     2026-09-15, joint family purchase). Both read and edit the SAME row
//     (FARM_ROW); there is no per-user copy. Anyone else gets 403.
//   * Locked (423) per person until THAT user's PIN has been changed since the
//     default PINs were seeded — those defaults are readable in this repo's
//     history, so until then anyone could sign in as them. Fails closed on a
//     DB error. Adding K did not relax this: she stays locked until she
//     changes her own PIN.
// Guarded by tests/farm.test.js (CI + the vercel.json build gate).

const crypto = require('crypto');
const { requireUser } = require('./_lib/auth');
const { supaSelect, supaPatch } = require('./_lib/supa');

const TABLE = 'dblife_farm';
const FARM_ROW = 'john';                  // the one shared plan row (user_id)
const FARM_MEMBERS = ['john', 'lisa'];   // D and K — both edit FARM_ROW
// The default PINs were seeded at 2026-06-07 11:39 UTC (migration 006). A PIN
// row last written at or before this still holds the published default.
const DEFAULT_PINS_SEEDED_AT = Date.parse('2026-06-07T12:00:00Z');
const MAX_BODY = 200 * 1024;

function send(res, code, obj) {
  res.statusCode = code;
  res.end(JSON.stringify(obj));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) return null;
  }
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const link = (v) => {
  const s = str(v, 1000);
  return /^https?:\/\/\S+$/i.test(s) ? s : '';
};
const score = (v) => {
  const n = num(v);
  return n === null ? null : Math.min(50, Math.round(n));
};

function cleanListing(l) {
  if (!l || typeof l !== 'object') return null;
  const name = str(l.name, 200);
  if (!name) return null;
  return {
    name, county: str(l.county, 60), acres: num(l.acres), price: num(l.price),
    score: score(l.score), link: link(l.link),
  };
}

// Returns { watch } or { error }. The task's JSON is scraped web text, so every
// field is whitelisted, typed and length-capped; the page escapes it too.
function cleanWatch(w) {
  if (!w || typeof w !== 'object' || !Array.isArray(w.parcels)) {
    return { error: 'expected {weekOf, parcels:[{name, county, acres, price, score, link, why, drive}]}' };
  }
  if (w.parcels.length > 200) return { error: 'too many parcels (max 200)' };
  const parcels = [];
  for (let i = 0; i < w.parcels.length; i++) {
    const p = cleanListing(w.parcels[i]);
    if (!p) return { error: `parcels[${i}]: name required` };
    parcels.push({ ...p, why: str(w.parcels[i].why, 500), drive: str(w.parcels[i].drive, 20) });
  }
  return { watch: { weekOf: str(w.weekOf, 20), parcels } };
}

function normState(s) {
  s = s && typeof s === 'object' ? s : {};
  return {
    doc: typeof s.doc === 'string' ? s.doc : '',
    listings: Array.isArray(s.listings) ? s.listings : [],
    checks: s.checks && typeof s.checks === 'object' && !Array.isArray(s.checks) ? s.checks : {},
  };
}

// Mutates state. Returns an error string, or null on success.
function applyOp(state, b) {
  switch (b.op) {
    case 'doc': {
      const v = str(b.value, 1000);
      if (v && !link(v)) return 'Paste a full link starting with https://';
      state.doc = v;
      return null;
    }
    case 'addListing': {
      if (state.listings.length >= 500) return 'too many listings';
      const l = cleanListing(b.listing);
      if (!l) return 'listing name required';
      state.listings.push({ id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, ...l });
      return null;
    }
    case 'removeListing': {
      const id = String(b.id);
      state.listings = state.listings.filter((l) => String(l.id) !== id);
      return null;
    }
    case 'check': {
      const i = Number(b.i);
      if (!Number.isInteger(i) || i < 0 || i > 99) return 'bad checklist index';
      if (b.on) state.checks[i] = true; else delete state.checks[i];
      return null;
    }
    default:
      return 'unknown op';
  }
}

function watchTokenOk(req) {
  const want = process.env.FARM_WATCH_TOKEN || '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  if (want.length < 32 || !m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

async function pinRotated(uid) {
  const rows = await supaSelect('dblife_auth_users', `id=eq.${encodeURIComponent(uid)}&select=updated_at&limit=1`);
  const t = rows && rows[0] ? Date.parse(rows[0].updated_at) : NaN;
  return t > DEFAULT_PINS_SEEDED_AT;
}

module.exports = async function (req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const part = new URL(req.url, 'http://localhost').searchParams.get('part');
    const owner = `user_id=eq.${FARM_ROW}`;

    // The Monday task: bearer token, no session. Writes the watch and nothing else.
    if (part === 'watch' && req.method === 'PUT') {
      if (!watchTokenOk(req)) return send(res, 401, { error: 'unauthorized' });
      const body = await readJson(req);
      const c = cleanWatch(body);
      if (c.error) return send(res, 400, { error: c.error });
      const out = await supaPatch(TABLE, owner, { watch: c.watch, watch_updated_at: new Date().toISOString() });
      if (!out || !out.length) return send(res, 404, { error: 'farm row missing' });
      return send(res, 200, { ok: true, weekOf: c.watch.weekOf, parcels: c.watch.parcels.length });
    }

    const me = requireUser(req, res);
    if (!me) return;
    if (!FARM_MEMBERS.includes(me.id)) return send(res, 403, { error: 'forbidden' });
    if (!(await pinRotated(me.id))) return send(res, 423, { error: 'locked', locked: 'pin' });

    const rows = await supaSelect(TABLE, `${owner}&select=content,state,watch,updated_at&limit=1`);
    const row = rows && rows[0];
    if (!row) return send(res, 404, { error: 'farm row missing' });

    if (req.method === 'GET') {
      if (part === 'watch') return send(res, 200, row.watch || { weekOf: '', parcels: [] });
      return send(res, 200, {
        content: row.content, state: normState(row.state),
        watch: row.watch || { weekOf: '', parcels: [] }, updated_at: row.updated_at,
      });
    }

    if (req.method === 'PATCH' && !part) {
      const b = await readJson(req);
      if (!b) return send(res, 400, { error: 'bad json' });
      const state = normState(row.state);
      const err = applyOp(state, b);
      if (err) return send(res, 400, { error: err });
      await supaPatch(TABLE, owner, { state, updated_at: new Date().toISOString() });
      return send(res, 200, { state });
    }

    send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    // Never echo DB errors: they can carry row content.
    send(res, 500, { error: 'server error' });
  }
};
