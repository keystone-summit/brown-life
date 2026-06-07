// Calendar events CRUD
// GET    /api/events?from=ISO&to=ISO   list
// POST   /api/events                    create  {title, description, start_at, end_at, all_day, color}
// PATCH  /api/events?id=N               update
// DELETE /api/events?id=N               delete

const { requireUser } = require('./_lib/auth');
const { supaSelect, supaInsert, supaPatch, supaDelete } = require('./_lib/supa');

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

module.exports = async function (req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  const uid = me.id;
  res.setHeader('Content-Type', 'application/json');

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET') {
      const from = url.searchParams.get('from');
      const to   = url.searchParams.get('to');
      const filters = [`user_id=eq.${uid}`];
      if (from) filters.push(`start_at=gte.${encodeURIComponent(from)}`);
      if (to)   filters.push(`start_at=lt.${encodeURIComponent(to)}`);
      filters.push('order=start_at.asc');
      filters.push('limit=500');
      const rows = await supaSelect('dblife_events', filters.join('&'));
      return res.end(JSON.stringify({ events: rows }));
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!body.title || !body.start_at) {
        res.statusCode = 400; return res.end(JSON.stringify({ error: 'title and start_at required' }));
      }
      const row = {
        user_id:     uid,
        title:       body.title,
        description: body.description || null,
        start_at:    body.start_at,
        end_at:      body.end_at || null,
        all_day:     !!body.all_day,
        color:       body.color || '#d4a44c',
      };
      const out = await supaInsert('dblife_events', row);
      return res.end(JSON.stringify({ event: out[0] }));
    }

    if (req.method === 'PATCH') {
      const id = url.searchParams.get('id');
      if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
      const body = await readJson(req);
      delete body.user_id;
      body.updated_at = new Date().toISOString();
      const out = await supaPatch('dblife_events', `id=eq.${id}&user_id=eq.${uid}`, body);
      return res.end(JSON.stringify({ event: out[0] }));
    }

    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
      await supaDelete('dblife_events', `id=eq.${id}&user_id=eq.${uid}`);
      return res.end(JSON.stringify({ ok: true }));
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method not allowed' }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
