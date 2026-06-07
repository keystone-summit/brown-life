// Thin Supabase PostgREST helper for dblife. No SDK — direct fetch.
// Expects SUPABASE_URL like "https://xxxx.supabase.co" (no /rest path).

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function restBase() {
  let u = SUPABASE_URL.replace(/\/+$/, '');
  if (!u.endsWith('/rest/v1')) u = u + '/rest/v1';
  return u;
}

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function supaSelect(table, query = '') {
  const url = `${restBase()}/${table}${query ? '?' + query : ''}`;
  const r = await fetch(url, { headers: headers() });
  if (!r.ok) throw new Error(`supa select ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function supaInsert(table, row, opts = {}) {
  const url = `${restBase()}/${table}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: headers({ Prefer: opts.returning === false ? 'return=minimal' : 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`supa insert ${table} ${r.status}: ${await r.text()}`);
  return opts.returning === false ? null : r.json();
}

async function supaPatch(table, query, row) {
  const url = `${restBase()}/${table}?${query}`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`supa patch ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function supaDelete(table, query) {
  const url = `${restBase()}/${table}?${query}`;
  const r = await fetch(url, { method: 'DELETE', headers: headers() });
  if (!r.ok) throw new Error(`supa delete ${table} ${r.status}: ${await r.text()}`);
  return true;
}

module.exports = { supaSelect, supaInsert, supaPatch, supaDelete };
