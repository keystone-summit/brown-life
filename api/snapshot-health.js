// GET /api/snapshot-health
//
// Aggregates dashboard health from osteostrong-exec/api/system-health
// (covers exec/coach/financial/hiring/limfa/member_hub), plus a live
// HEAD check on griffin-hall and griffin-exec-dashboard.
//
// Response:
//   {
//     ok: true,
//     fetchedAt: '<iso>',
//     cached: bool,
//     overall: 'green' | 'yellow' | 'red' | 'unknown',
//     items: [
//       { name, url, bucket, status_code, response_time_ms, checked_at }
//     ]
//   }

const { requireAuth } = require('./_lib/auth');
const { withCache } = require('./_lib/cache');

const TTL_MS = 5 * 60 * 1000;
const OS_EXEC = 'https://osteostrong-exec.vercel.app';

const EXTRA = [
  { name: 'griffin_hall', url: 'https://griffin-hall-gules.vercel.app/' },
  { name: 'griffin_exec', url: 'https://griffin-exec.vercel.app/' },
  { name: 'dblife',       url: 'https://dblife.vercel.app/' },
];

// Fallback ping targets for the OS-side dashboards. Only used when the
// canonical OS Exec /api/system-health aggregator returns no rows for a
// given name (it's been intermittently empty). Keeps the dblife Home
// "My Dashboards" grid showing real green/yellow/red dots instead of
// gray-unknown.
const OS_FALLBACK = [
  { name: 'exec',       url: 'https://osteostrong-exec.vercel.app/' },
  { name: 'coach',      url: 'https://osteostrong-coach-mockup.vercel.app/' },
  { name: 'financial',  url: 'https://osteostrong-dashboard.vercel.app/' },
  { name: 'hiring',     url: 'https://osteostrong-hiring.vercel.app/' },
  { name: 'limfa',      url: 'https://osteostrong-limfa-dashboard.vercel.app/' },
];

const DISPLAY_NAMES = {
  exec:          'OS Exec',
  coach:         'OS Coach',
  financial:     'OS Financial',
  hiring:        'OS Hiring',
  limfa:         'OS LIMFA',
  member_hub:    'Member Hub',
  griffin_hall:  'Griffin Hall',
  griffin_exec:  'Griffin Exec',
  dblife:        'Brown Life',
};

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (!requireAuth(req, res)) return;
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    return res.end(JSON.stringify({ error: 'GET only' }));
  }

  try {
    const { value, cached, fetchedAt } = await withCache('snapshot-health', TTL_MS, loadHealth);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.statusCode = 200;
    return res.end(JSON.stringify({ ...value, cached, fetchedAt: new Date(fetchedAt).toISOString() }));
  } catch (err) {
    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: false, fetchedAt: new Date().toISOString(), cached: false,
      error: err && err.message || String(err),
      overall: 'unknown', items: [],
    }));
  }
};

async function loadHealth() {
  const items = [];

  // OS-side: lean on the canonical aggregator
  try {
    const r = await fetch(OS_EXEC + '/api/system-health');
    if (r.ok) {
      const data = await r.json();
      for (const row of (data.latest || [])) {
        items.push({
          name: DISPLAY_NAMES[row.dashboard_name] || row.dashboard_name,
          url: row.url,
          bucket: row.bucket,
          status_code: row.status_code,
          response_time_ms: row.response_time_ms,
          checked_at: row.checked_at,
        });
      }
    }
  } catch (e) { /* tolerate */ }

  // Griffin-side and dblife: direct HEAD/GET pings (Vercel deploys are
  // fast; we keep this in-line because the 5-min cache cushions load).
  const extras = await Promise.allSettled(EXTRA.map(pingOne));
  for (const result of extras) {
    if (result.status === 'fulfilled' && result.value) items.push(result.value);
  }

  // OS-side fallback: aggregator has been returning latest=[] -- ping any
  // OS dashboard that didn't come back from system-health so the dblife
  // grid never shows gray dots for live URLs.
  const presentNames = new Set(items.map((i) => i.name));
  const missingOs = OS_FALLBACK.filter((e) => !presentNames.has(DISPLAY_NAMES[e.name] || e.name));
  if (missingOs.length) {
    const fills = await Promise.allSettled(missingOs.map(pingOne));
    for (const result of fills) {
      if (result.status === 'fulfilled' && result.value) items.push(result.value);
    }
  }

  const overall = worstBucket(items.map((i) => i.bucket));
  return { ok: true, overall, items };
}

async function pingOne(entry) {
  const started = Date.now();
  try {
    const r = await fetch(entry.url, { method: 'GET', redirect: 'manual' });
    const elapsed = Date.now() - started;
    return {
      name: DISPLAY_NAMES[entry.name] || entry.name,
      url: entry.url,
      bucket: bucketOf(r.status, elapsed),
      status_code: r.status,
      response_time_ms: elapsed,
      checked_at: new Date().toISOString(),
    };
  } catch (e) {
    return {
      name: DISPLAY_NAMES[entry.name] || entry.name,
      url: entry.url,
      bucket: 'red',
      status_code: null,
      response_time_ms: Date.now() - started,
      checked_at: new Date().toISOString(),
    };
  }
}

function bucketOf(status, ms) {
  if (status == null) return 'red';
  if (status >= 200 && status < 300) return (ms > 3000) ? 'yellow' : 'green';
  if (status >= 300 && status < 400) return 'green';
  if (status === 401 || status === 403) return 'yellow';
  return 'red';
}

function worstBucket(buckets) {
  if (buckets.includes('red'))    return 'red';
  if (buckets.includes('yellow')) return 'yellow';
  if (buckets.includes('green'))  return 'green';
  return 'unknown';
}
