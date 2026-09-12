// =====================================================================
// tests/auth-no-backdoors.test.js
//
// 🔒 Locked 2026-09-12. This repo is PUBLIC. Until today it carried three
// ways into Brown Life that did not need the owner's secret:
//
//   1. DEFAULT PIN FALLBACK. _lib/auth.js embedded scrypt hashes of the
//      documented default PINs and used them whenever the Supabase read
//      failed ("fail-open to env"). With no BROWNLIFE_PIN_HASH_* env set,
//      a Hub outage silently brought the public defaults back — even after
//      a user had changed their PIN in the app.
//   2. PUBLIC SESSION SECRET. If BROWNLIFE_AUTH_SECRET was ever unset, the
//      cookie HMAC fell back to a literal string printed in this repo, so
//      anyone could forge a session for any user.
//   3. PIN-RESET MIGRATION. schema/006 upserted the default PIN hashes with
//      "on conflict do update". Re-running it after a rotation would have
//      reset every PIN to the published default. Its header also listed the
//      PINs in plaintext.
//
// Every check below is deny-by-default: no DB and no owner-set env hash
// means NO login. Behavioural checks load the REAL auth.js against a stubbed
// supa module. Test PINs are random fixtures — the published defaults are
// deliberately never written into this file (the static scan would flag it).
//
// Run: node tests/auth-no-backdoors.test.js   (exit 1 on any failure)
// =====================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const AUTH = path.join(ROOT, 'api', '_lib', 'auth.js');
const SUPA = path.join(ROOT, 'api', '_lib', 'supa.js');

let failures = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  OK  ' + label); return; }
  failures++;
  console.log('  FAIL ' + label + (detail ? ' -- ' + detail : ''));
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pin, salt, 32).toString('hex');
}

const ENV_KEYS = [
  'BROWNLIFE_AUTH_SECRET', 'DBLIFE_AUTH_SECRET',
  'BROWNLIFE_PIN_HASH_JOHN', 'BROWNLIFE_PIN_HASH_LISA',
  'BROWNLIFE_PIN_JOHN', 'BROWNLIFE_PIN_LISA',
];

// Load a FRESH copy of the real auth.js with exactly `env` set and a stubbed
// supa module. auth.js reads its env at module load, so restoring the real
// env afterwards does not change the loaded copy's behaviour.
function load(env, supaImpl) {
  const saved = {};
  ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, env || {});
  delete require.cache[AUTH];
  require.cache[SUPA] = { id: SUPA, filename: SUPA, loaded: true, exports: supaImpl };
  let mod;
  try { mod = require(AUTH); }
  finally {
    ENV_KEYS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
  }
  return mod;
}

const dbDown = {
  supaSelect: async () => { throw new Error('supabase unreachable (test)'); },
  supaInsert: async () => { throw new Error('supabase unreachable (test)'); },
  supaPatch:  async () => { throw new Error('supabase unreachable (test)'); },
};
function dbWith(rows, calls) {
  return {
    supaSelect: async (table, q) => {
      if (/id=eq\./.test(q || '')) {
        const id = decodeURIComponent((q.match(/id=eq\.([^&]+)/) || [])[1] || '');
        return rows.filter((r) => r.id === id);
      }
      return rows;
    },
    supaInsert: async (t, row) => { if (calls) calls.push(['insert', row]); return [row]; },
    supaPatch:  async (t, q, row) => { if (calls) calls.push(['patch', row]); return [row]; },
  };
}

// A response stub that captures Set-Cookie, and a request carrying a cookie.
function captureCookie(fn) {
  const hdr = {};
  const res = { setHeader: (k, v) => { hdr[k.toLowerCase()] = v; } };
  fn(res);
  const raw = String(hdr['set-cookie'] || '');
  return raw.split(';')[0]; // "brownlife_auth=<value>"
}
const reqWith = (cookie) => ({ headers: { cookie: cookie || '' } });

// A cookie signed with an arbitrary secret, in auth.js's own format.
function forgeCookie(userId, secret) {
  const exp = new Date(Date.now() + 3600e3).toISOString();
  const payload = userId + '.' + exp;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'brownlife_auth=' + encodeURIComponent(payload + '.' + sig);
}

(async function main() {
  console.log('auth-no-backdoors.test -- begin');
  const SECRET = crypto.randomBytes(32).toString('hex');
  const src = fs.readFileSync(AUTH, 'utf8');

  // ---- 1. STATIC: the backdoor symbols are gone from auth.js ----------
  ok('auth.js embeds no default PIN hash constant', !/DEFAULT_HASH_/.test(src));
  ok('auth.js embeds no scrypt hash literal at all', !/['"]scrypt\$[0-9a-f]{16,}\$[0-9a-f]{16,}['"]/.test(src));
  ok('auth.js has no hardcoded session-secret fallback', !/dev-secret|change-me/i.test(src));
  ok('auth.js does not fall back to the legacy DBLIFE_AUTH_SECRET', !/DBLIFE_AUTH_SECRET/.test(src));

  // ---- 2. STATIC: no published default PIN anywhere in tracked code ----
  // The defaults were six repeated digits. Build them rather than write them,
  // and ignore CSS hex colours (#111111 etc.).
  const defaults = [1, 2].map((d) => String(d).repeat(6));
  const pinRe = new RegExp('(?<![#0-9a-fA-F])(' + defaults.join('|') + ')(?![0-9a-fA-F])');
  const scanned = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|sql|py|md|html|json)$/.test(e.name)) scanned.push(p);
    }
  })(ROOT);
  const hits = scanned.filter((p) => pinRe.test(fs.readFileSync(p, 'utf8')))
    .map((p) => path.relative(ROOT, p));
  ok('no published default PIN appears in any tracked file (' + scanned.length + ' scanned)',
     hits.length === 0, hits.join(', '));

  // ---- 3. STATIC: no migration can reset a PIN -------------------------
  const schemaDir = path.join(ROOT, 'schema');
  const resetters = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.sql')).filter((f) => {
    const sql = fs.readFileSync(path.join(schemaDir, f), 'utf8').replace(/--[^\n]*/g, '');
    return /pin_hash\s*=\s*excluded\.pin_hash/i.test(sql) ||
           /insert\s+into\s+dblife_auth_users[\s\S]*scrypt\$/i.test(sql);
  });
  ok('no migration writes or upserts a PIN hash', resetters.length === 0, resetters.join(', '));

  // ---- 4. BEHAVIOUR: DB down + no owner env hash => nobody gets in -----
  const a1 = load({ BROWNLIFE_AUTH_SECRET: SECRET }, dbDown);
  const tries = ['482913', '000000', '999999', '135790'];
  const got = await Promise.all(tries.map((p) => a1.identifyPin(p)));
  ok('DB unreachable and no env hash: EVERY PIN is refused (fail closed)',
     got.every((u) => u === null), JSON.stringify(got));

  // ---- 5. BEHAVIOUR: DB up => the stored hash is authoritative ----------
  const a2 = load({ BROWNLIFE_AUTH_SECRET: SECRET },
    dbWith([{ id: 'john', pin_hash: hashPin('482913') }]));
  const hit = await a2.identifyPin('482913');
  ok('DB up: the stored PIN still signs its owner in (no lockout from this fix)',
     hit && hit.id === 'john', JSON.stringify(hit));
  ok('DB up: a wrong PIN is refused', (await a2.identifyPin('000000')) === null);

  // ---- 6. BEHAVIOUR: an OWNER-SET env hash is a legitimate fallback -----
  const a3 = load({ BROWNLIFE_AUTH_SECRET: SECRET, BROWNLIFE_PIN_HASH_JOHN: hashPin('735102') }, dbDown);
  const envHit = await a3.identifyPin('735102');
  ok('DB down but owner-set env hash present: that secret PIN still works',
     envHit && envHit.id === 'john', JSON.stringify(envHit));

  // ---- 7. BEHAVIOUR: seeding never writes an empty hash ------------------
  const calls = [];
  const a4 = load({ BROWNLIFE_AUTH_SECRET: SECRET }, dbWith([], calls));
  await a4.seedPinIfMissing('john');
  ok('seedPinIfMissing never inserts a row when no owner env hash exists',
     !calls.some((c) => c[0] === 'insert'), JSON.stringify(calls));

  // ---- 8. BEHAVIOUR: sessions need the real secret ----------------------
  const a5 = load({ BROWNLIFE_AUTH_SECRET: SECRET }, dbDown);
  const real = captureCookie((res) => a5.setAuthCookie(res, 'john'));
  const me = a5.currentUser(reqWith(real));
  ok('a cookie signed with the configured secret is accepted', me && me.id === 'john', JSON.stringify(me));
  const forged = a5.currentUser(reqWith(forgeCookie('john', 'dev-secret-change-me')));
  ok('a cookie forged with the old public fallback secret is REFUSED', forged === null);

  const a6 = load({}, dbDown); // no BROWNLIFE_AUTH_SECRET at all
  ok('no session secret configured: no cookie verifies',
     a6.currentUser(reqWith(forgeCookie('john', 'dev-secret-change-me'))) === null &&
     a6.currentUser(reqWith(real)) === null);
  let threw = false;
  try { captureCookie((res) => a6.setAuthCookie(res, 'john')); } catch (e) { threw = true; }
  ok('no session secret configured: issuing a session FAILS loudly instead of signing with a default', threw);

  if (failures) {
    console.log('\nauth-no-backdoors.test -- FAILED (' + failures + ')');
    process.exit(1);
  }
  console.log('\nauth-no-backdoors.test -- PASS');
})().catch((e) => { console.log('  FAIL harness threw -- ' + (e && e.stack || e)); process.exit(1); });
