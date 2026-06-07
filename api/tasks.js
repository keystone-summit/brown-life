// Kanban tasks CRUD
// GET    /api/tasks                  list all (ordered by status,position)
// POST   /api/tasks                  create {title, notes, status, priority, due_date, tags}
// PATCH  /api/tasks?id=N             update (status change auto-stamps completed_at)
// DELETE /api/tasks?id=N             delete

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
      const rows = await supaSelect('dblife_tasks', `user_id=eq.${uid}&order=status.asc,position.asc,created_at.desc&limit=1000`);
      return res.end(JSON.stringify({ tasks: rows }));
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!body.title) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'title required' })); }
      const row = {
        user_id:  uid,
        title:    body.title,
        notes:    body.notes || null,
        status:   ['todo','doing','done'].includes(body.status) ? body.status : 'todo',
        priority: ['low','medium','high'].includes(body.priority) ? body.priority : 'medium',
        due_date: body.due_date || null,
        tags:     Array.isArray(body.tags) ? body.tags : [],
        position: typeof body.position === 'number' ? body.position : 0,
      };
      const out = await supaInsert('dblife_tasks', row);
      return res.end(JSON.stringify({ task: out[0] }));
    }

    if (req.method === 'PATCH') {
      const id = url.searchParams.get('id');
      if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
      const body = await readJson(req);
      delete body.user_id; // never reassign ownership
      body.updated_at = new Date().toISOString();
      if (body.status === 'done' && body.completed_at === undefined) {
        body.completed_at = new Date().toISOString();
      } else if (body.status && body.status !== 'done') {
        body.completed_at = null;
      }
      const out = await supaPatch('dblife_tasks', `id=eq.${id}&user_id=eq.${uid}`, body);
      return res.end(JSON.stringify({ task: out[0] }));
    }

    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
      await supaDelete('dblife_tasks', `id=eq.${id}&user_id=eq.${uid}`);
      return res.end(JSON.stringify({ ok: true }));
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method not allowed' }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
