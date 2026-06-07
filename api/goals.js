// Goals + subtasks
// GET    /api/goals                       list goals (with subtasks)
// POST   /api/goals                       create goal {title, description, target_date, progress}
// PATCH  /api/goals?id=N                  update goal
// DELETE /api/goals?id=N                  delete goal
// POST   /api/goals?id=N&sub=1            create subtask {title}
// PATCH  /api/goals?sub_id=N              update subtask {done?, title?}
// DELETE /api/goals?sub_id=N              delete subtask

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
    const id     = url.searchParams.get('id');
    const subId  = url.searchParams.get('sub_id');
    const isSub  = url.searchParams.get('sub') === '1';

    if (req.method === 'GET') {
      const goals = await supaSelect('dblife_goals', `user_id=eq.${uid}&archived=eq.false&order=created_at.desc&limit=200`);
      const subs  = await supaSelect('dblife_goal_subtasks', `user_id=eq.${uid}&order=position.asc,created_at.asc&limit=2000`);
      const byGoal = {};
      for (const s of subs) (byGoal[s.goal_id] = byGoal[s.goal_id] || []).push(s);
      return res.end(JSON.stringify({ goals: goals.map(g => ({ ...g, subtasks: byGoal[g.id] || [] })) }));
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (isSub) {
        if (!id || !body.title) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id and title required' })); }
        const out = await supaInsert('dblife_goal_subtasks', { goal_id: Number(id), user_id: uid, title: body.title, position: body.position || 0 });
        return res.end(JSON.stringify({ subtask: out[0] }));
      }
      if (!body.title) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'title required' })); }
      const row = {
        user_id:     uid,
        title:       body.title,
        description: body.description || null,
        progress:    Math.max(0, Math.min(100, Number(body.progress) || 0)),
        target_date: body.target_date || null,
      };
      const out = await supaInsert('dblife_goals', row);
      return res.end(JSON.stringify({ goal: { ...out[0], subtasks: [] } }));
    }

    if (req.method === 'PATCH') {
      if (subId) {
        const body = await readJson(req);
        delete body.user_id;
        const out = await supaPatch('dblife_goal_subtasks', `id=eq.${subId}&user_id=eq.${uid}`, body);
        return res.end(JSON.stringify({ subtask: out[0] }));
      }
      if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
      const body = await readJson(req);
      delete body.user_id;
      if (body.progress !== undefined) body.progress = Math.max(0, Math.min(100, Number(body.progress) || 0));
      body.updated_at = new Date().toISOString();
      const out = await supaPatch('dblife_goals', `id=eq.${id}&user_id=eq.${uid}`, body);
      return res.end(JSON.stringify({ goal: out[0] }));
    }

    if (req.method === 'DELETE') {
      if (subId) { await supaDelete('dblife_goal_subtasks', `id=eq.${subId}&user_id=eq.${uid}`); return res.end(JSON.stringify({ ok: true })); }
      if (!id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
      await supaDelete('dblife_goals', `id=eq.${id}&user_id=eq.${uid}`);
      return res.end(JSON.stringify({ ok: true }));
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'method not allowed' }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
