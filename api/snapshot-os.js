// GET /api/snapshot-os
//
// Proxies OsteoStrong Executive Dashboard endpoints server-side so the
// dblife browser doesn't hit CORS. 15-min in-memory cache per warm
// container. PIN-gated.
//
// Response shape (always 200 unless auth fails):
//   {
//     ok: true,
//     fetchedAt: '<iso>',
//     cached: bool,
//     tiles: {
//       active_members: { value, label, sub },
//       this_month_revenue: { value, label, sub },
//       new_members_this_month: { value, label, sub },
//       open_hiring_candidates: { value, label, sub },
//       hiring_action_required: { value, label, sub },
//       top_alert: { value, label, sub, tone }
//     },
//     missing: [ 'list of fields that couldn't be fetched' ]
//   }

const { requireAuth } = require('./_lib/auth');
const { withCache } = require('./_lib/cache');

const TTL_MS  = 15 * 60 * 1000;
const OS_EXEC = 'https://osteostrong-exec.vercel.app';
// Owner email for /api/exec-kpis lookup -- matches the OS Exec Dashboard's
// canonical KPI row in Supabase exec_kpis. MTD Revenue lives there as
// calculator_type=payment_collection_this_month (iGo components + Stripe MTD).
const OS_EXEC_OWNER = 'villageatpine@osteostrong.me';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end(JSON.stringify({ error: 'GET only' }));
  }

  try {
    const { value, cached, fetchedAt } = await withCache('snapshot-os', TTL_MS, loadOsSnapshot);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.statusCode = 200;
    return res.end(JSON.stringify({ ...value, cached, fetchedAt: new Date(fetchedAt).toISOString() }));
  } catch (err) {
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: false,
      fetchedAt: new Date().toISOString(),
      cached: false,
      error: err && err.message || String(err),
      tiles: emptyTiles(),
      missing: ['all'],
    }));
  }
};

async function loadOsSnapshot() {
  const missing = [];
  const results = await Promise.allSettled([
    fetchJson(OS_EXEC + '/api/exec-trends'),
    fetchJson(OS_EXEC + '/api/exec-hiring-live'),
    fetchJson(OS_EXEC + '/api/system-health'),
    fetchJson(OS_EXEC + '/api/exec-kpis?email=' + encodeURIComponent(OS_EXEC_OWNER)),
  ]);
  const trends  = unwrap(results[0]);
  const hiring  = unwrap(results[1]);
  const health  = unwrap(results[2]);
  const kpis    = unwrap(results[3]);

  const tiles = emptyTiles();

  // Active members + new members from latest trends row.
  if (trends && Array.isArray(trends.months) && trends.months.length) {
    const latest = trends.months[trends.months.length - 1];
    if (latest.ok_member != null) {
      tiles.active_members = { value: String(latest.ok_member), label: 'Active members', sub: `${latest.total_members || '—'} total · ${latest.holds || 0} on hold` };
    } else missing.push('active_members');

    if (latest.new_members != null) {
      tiles.new_members_this_month = { value: String(latest.new_members), label: 'New members MTD', sub: `${latest.terminations || 0} terminations` };
    } else missing.push('new_members_this_month');
  } else {
    missing.push('active_members', 'new_members_this_month');
  }

  // MTD Revenue -- canonical source is the Exec Dashboard KPI tile
  // (calculator_type=payment_collection_this_month). It combines the iGo
  // revenue components with stripe_revenue_mtd, so it matches what John sees
  // on osteostrong-exec. Falling back to exec-trends.total_revenue is
  // iGo-only and was undercounting by the Stripe MTD slice.
  const revenueKpi = pickKpi(kpis, 'payment_collection_this_month');
  const monthLabel = trends && Array.isArray(trends.months) && trends.months.length
    ? trends.months[trends.months.length - 1].month
    : '';
  if (revenueKpi != null) {
    tiles.this_month_revenue = { value: fmtMoney(revenueKpi), label: 'Revenue MTD', sub: monthLabel };
  } else if (trends && Array.isArray(trends.months) && trends.months.length
             && trends.months[trends.months.length - 1].total_revenue != null) {
    const latest = trends.months[trends.months.length - 1];
    tiles.this_month_revenue = { value: fmtMoney(latest.total_revenue), label: 'Revenue MTD', sub: latest.month + ' · iGo only' };
    missing.push('this_month_revenue_stripe');
  } else {
    missing.push('this_month_revenue');
  }

  // Hiring pipeline
  if (hiring && Array.isArray(hiring.candidates)) {
    const open = hiring.candidates.filter((c) => !(c.stage && c.stage.terminal));
    const waitingJohn = open.filter((c) => /john/i.test(c.waitingOn || ''));
    tiles.open_hiring_candidates = { value: String(open.length), label: 'Hiring pipeline', sub: `${hiring.candidates.length} total touched` };
    tiles.hiring_action_required = {
      value: String(waitingJohn.length),
      label: 'Waiting on John',
      sub: waitingJohn.length ? waitingJohn[0].fullName + ' · ' + (waitingJohn[0].stage && waitingJohn[0].stage.label || '') : 'All clear',
    };
  } else {
    missing.push('open_hiring_candidates', 'hiring_action_required');
  }

  // Top alert (derived)
  if (health) {
    if (health.overall === 'red') {
      const down = (health.latest || []).filter((r) => r.bucket === 'red');
      tiles.top_alert = { value: String(down.length), label: 'Systems down', sub: down.map((r) => r.dashboard_name).join(', '), tone: 'red' };
    } else if (health.overall === 'yellow') {
      tiles.top_alert = { value: 'Watch', label: 'Slow / degraded', sub: 'Check Exec dashboard', tone: 'yellow' };
    } else {
      tiles.top_alert = { value: 'OK', label: 'All systems green', sub: 'Last check ' + (health.stalest_check_age_min || 0) + ' min ago', tone: 'green' };
    }
  } else {
    missing.push('top_alert');
  }

  return { ok: true, tiles, missing };
}

function emptyTiles() {
  const blank = { value: '—', label: '', sub: '' };
  return {
    active_members:         { ...blank, label: 'Active members' },
    this_month_revenue:     { ...blank, label: 'Revenue MTD' },
    new_members_this_month: { ...blank, label: 'New members MTD' },
    open_hiring_candidates: { ...blank, label: 'Hiring pipeline' },
    hiring_action_required: { ...blank, label: 'Waiting on John' },
    top_alert:              { ...blank, label: 'Status', tone: 'unknown' },
  };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(url + ' returned ' + r.status);
  return r.json();
}

function unwrap(settled) {
  return settled.status === 'fulfilled' ? settled.value : null;
}

function pickKpi(payload, calculatorType) {
  if (!payload || !Array.isArray(payload.kpis)) return null;
  const row = payload.kpis.find((k) => k && k.calculator_type === calculatorType);
  if (!row) return null;
  if (typeof row.current_value === 'number') return row.current_value;
  const n = Number(row.current);
  return isNaN(n) ? null : n;
}

function fmtMoney(n) {
  if (n == null) return '—';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  return '$' + Math.round(n);
}
