// Supplements + intake log
// GET    /api/supplements                  list supplements + today's log entries
// POST   /api/supplements                  create  {name, dose, frequency, brand, refill_date, notes}
// PATCH  /api/supplements?id=N             update
// DELETE /api/supplements?id=N             delete
// POST   /api/supplements?id=N&take=1      log an intake (today, now)
// DELETE /api/supplements?log_id=N         undo a log entry

const { requireUser } = require('./_lib/auth');
const { supaSelect, supaInsert, supaPatch, supaDelete } = require('./_lib/supa');

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

function todayBoundsIso() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const end   = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
  return { start, end };
}

module.exports = async function (req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  const uid = me.id;
  res.setHeader('Content-Type', 'application/json');

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id     = url.searchParams.get('id');
    const logId  = url.searchParams.get('log_id');
    const take   = url.searchParams.get('take') === '1';

    if (req.method === 'GET') {
      const supps = await supaSelect('dblife_supplements', `user_id=eq.${uid}&active=eq.true&order=name.asc&limit=200`);
      const { start, end } = todayBoundsIso();
      const log   = await supaSelect('dblife_supplement_log',
        `user_id=eq.${uid}&taken_at=gte.${encodeURIComponent(start)}&taken_at=lt.${encodeURIComponent(end)}&order=taken_at.desc&limit=500`);
      return res.end(JSON.stringify({ supplements: supps, today_log: log }));
    }

    if (req.method === 'POST') {
      if (take) {
        if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
        const out = await supaInsert('dblife_supplement_log', { supplement_id: Number(id), user_id: uid });
        return res.end(JSON.stringify({ log: out[0] }));
      }
      const body = await readJson(req);
      if (!body.name) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'name required' })); }
      const row = {
        user_id:     uid,
        name:        body.name,
        dose:        body.dose || null,
        frequency:   body.frequency || null,
        brand:       body.brand || null,
        refill_date: body.refill_date || null,
        notes:       body.notes || null,
      };
      const out = await supaInsert('dblife_supplements', row);
      return res.end(JSON.stringify({ supplement: out[0] }));
    }

    if (req.method === 'PATCH') {
      if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
      const body = await readJson(req);
      delete body.user_id;
      body.updated_at = new Date().toISOString();
      const out = await supaPatch('dblife_supplements', `id=eq.${id}&user_id=eq.${uid}`, body);
      return res.end(JSON.stringify({ supplement: out[0] }));
    }

    if (req.method === 'DELETE') {
      if (logId) { await supaDelete('dblife_supplement_log', `id=eq.${logId}&user_id=eq.${uid}`); return res.end(JSON.stringify({ ok: true })); }
      if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
      // soft-delete: mark inactive (preserves log history)
      await supaPatch('dblife_supplements', `id=eq.${id}&user_id=eq.${uid}`, { active: false, updated_at: new Date().toISOString() });
      return res.end(JSON.stringify({ ok: true }));
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method not allowed' }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
