// GET /api/snapshot-griffin
//
// Server-side login to Griffin Exec Dashboard (passcode-gated) and fetch
// build-status + mrr + analytics. 15-min cache. Falls back to stubs if
// GRIFFIN_EXEC_PASSCODE env var is not set.
//
// Always returns 200 to the browser; check `tiles.*.value` for '—' and
// `missing` array for the list of fields that couldn't be loaded.

const { requireAuth } = require('./_lib/auth');
const { withCache } = require('./_lib/cache');

const TTL_MS         = 15 * 60 * 1000;
const GRIFFIN_EXEC   = 'https://griffin-exec.vercel.app';
const GRIFFIN_HALL   = 'https://griffin-hall-gules.vercel.app';
const ATTORNEY_DATE  = '2026-06-03';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end(JSON.stringify({ error: 'GET only' }));
  }

  try {
    const { value, cached, fetchedAt } = await withCache('snapshot-griffin', TTL_MS, loadGriffinSnapshot);
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

async function loadGriffinSnapshot() {
  const missing = [];
  const tiles = emptyTiles();

  // Always-available: attorney meeting countdown
  tiles.days_to_attorney = daysToAttorneyTile();

  // Try to login to Griffin Exec and pull live data
  const passcode = process.env.GRIFFIN_EXEC_PASSCODE;
  let cookie = null;
  if (passcode) {
    try { cookie = await loginToGriffinExec(passcode); }
    catch (e) { /* cookie stays null; flagged in missing */ }
  }

  if (!passcode) {
    missing.push('griffin_exec_passcode_unset');
  } else if (!cookie) {
    missing.push('griffin_exec_login_failed');
  }

  // Build status (acquisition / phase readiness)
  if (cookie) {
    try {
      const build = await fetchJson(GRIFFIN_EXEC + '/api/build-status', cookie);
      if (build && build.ok !== false) {
        // build-status returns phase progress; derive a readiness pct
        const pct = derivePhasePct(build);
        tiles.acquisition_readiness = { value: (pct != null ? pct + '%' : '—'), label: 'Phase readiness', sub: build.current_phase || 'in progress' };
      } else missing.push('acquisition_readiness');
    } catch (e) { missing.push('acquisition_readiness'); }

    try {
      const mrr = await fetchJson(GRIFFIN_EXEC + '/api/mrr', cookie);
      if (mrr && mrr.ok) {
        tiles.mrr = { value: '$' + Math.round(mrr.current || 0), label: 'Current MRR', sub: mrr.current ? 'Stripe live' : 'no subs yet' };
      } else {
        tiles.mrr = { value: '$0', label: 'Current MRR', sub: 'Stripe not wired' };
      }
    } catch (e) { missing.push('mrr'); }

    try {
      const an = await fetchJson(GRIFFIN_EXEC + '/api/analytics', cookie);
      if (an && an.ok !== false) {
        tiles.lessons_today = { value: String(an.lessons_today || an.todayLessons || 0), label: 'Lessons today', sub: an.users_today != null ? (an.users_today + ' active users') : '' };
      } else missing.push('lessons_today');
    } catch (e) { missing.push('lessons_today'); }
  } else {
    missing.push('acquisition_readiness', 'mrr', 'lessons_today');
  }

  // Beta codes: derived from Griffin Hall (public-ish admin endpoint requires PIN)
  // We can't fetch this without admin token; flag as missing for future wiring.
  missing.push('beta_codes_active');

  // Top alert (derived from build status if available, else a static reminder)
  const daysLeft = daysUntil(ATTORNEY_DATE);
  if (daysLeft != null && daysLeft <= 14 && daysLeft >= 0) {
    tiles.top_alert = { value: daysLeft + ' days', label: 'Attorney meeting', sub: 'Final prep window', tone: 'yellow' };
  } else if (daysLeft != null && daysLeft < 0) {
    tiles.top_alert = { value: 'Past', label: 'Attorney meeting', sub: 'Set next milestone', tone: 'green' };
  } else {
    tiles.top_alert = { value: 'OK', label: 'All systems green', sub: 'Track in Griffin Exec', tone: 'green' };
  }

  return { ok: true, tiles, missing };
}

function emptyTiles() {
  const blank = { value: '—', label: '', sub: '' };
  return {
    days_to_attorney:       { ...blank, label: 'Days to attorney meeting' },
    acquisition_readiness:  { ...blank, label: 'Phase readiness' },
    mrr:                    { ...blank, label: 'Current MRR' },
    lessons_today:          { ...blank, label: 'Lessons today' },
    beta_codes_active:      { ...blank, label: 'Beta codes active' },
    top_alert:              { ...blank, label: 'Status', tone: 'unknown' },
  };
}

function daysToAttorneyTile() {
  const d = daysUntil(ATTORNEY_DATE);
  if (d == null) return { value: '—', label: 'Days to attorney meeting', sub: ATTORNEY_DATE };
  if (d > 0)  return { value: String(d), label: 'Days to attorney meeting', sub: ATTORNEY_DATE };
  if (d === 0) return { value: 'Today', label: 'Attorney meeting', sub: ATTORNEY_DATE };
  return { value: String(-d) + ' ago', label: 'Attorney meeting (past)', sub: ATTORNEY_DATE };
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const target = new Date(isoDate + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function derivePhasePct(build) {
  if (typeof build.percent === 'number') return Math.round(build.percent);
  if (typeof build.phase_percent === 'number') return Math.round(build.phase_percent);
  // Try common shapes
  if (Array.isArray(build.phases)) {
    const done = build.phases.filter((p) => p.done || p.complete || p.status === 'done').length;
    if (build.phases.length) return Math.round((done / build.phases.length) * 100);
  }
  if (Array.isArray(build.checks)) {
    const passed = build.checks.filter((c) => c.passed || c.ok).length;
    if (build.checks.length) return Math.round((passed / build.checks.length) * 100);
  }
  return null;
}

async function loginToGriffinExec(passcode) {
  const r = await fetch(GRIFFIN_EXEC + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ passcode }),
  });
  if (!r.ok) throw new Error('griffin login ' + r.status);
  const setCookie = r.headers.get('set-cookie') || '';
  // Extract just the `griffin_exec_session=...` portion (drop attributes).
  const m = setCookie.match(/griffin_exec_session=[^;]+/);
  return m ? m[0] : null;
}

async function fetchJson(url, cookie) {
  const r = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      ...(cookie ? { 'Cookie': cookie } : {}),
    },
  });
  if (!r.ok) throw new Error(url + ' returned ' + r.status);
  return r.json();
}
