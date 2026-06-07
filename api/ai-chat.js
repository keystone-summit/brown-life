// Claude chat proxy with persistent per-session history in Supabase.
// POST {session_id, message}  -> {reply, session_id}
// GET  ?session_id=X          -> {messages: [...]}

const { requireUser } = require('./_lib/auth');
const { supaSelect, supaInsert } = require('./_lib/supa');

const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL   || 'claude-sonnet-4-6';
function systemPrompt(name) {
  return `You are a helpful, candid personal assistant inside ${name}'s Brown Life dashboard.
Be concise, practical, and direct. When asked about health, fitness, supplements, or finances,
give thoughtful guidance but defer to a qualified professional for medical/legal/tax decisions.
Today's date is provided in context.`;
}

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
      const sid = url.searchParams.get('session_id') || 'default';
      const rows = await supaSelect('dblife_chat_messages',
        `user_id=eq.${uid}&session_id=eq.${encodeURIComponent(sid)}&order=created_at.asc&limit=200`);
      return res.end(JSON.stringify({ messages: rows }));
    }

    if (req.method !== 'POST') {
      res.statusCode = 405; return res.end(JSON.stringify({ error: 'method not allowed' }));
    }

    if (!ANTHROPIC_KEY) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }));
    }

    const body = await readJson(req);
    const sid = (body.session_id || 'default').toString().slice(0, 100);
    const message = (body.message || '').toString().trim();
    if (!message) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'message required' })); }

    // Load history (last 30 messages for context, keeps it cheap)
    const history = await supaSelect('dblife_chat_messages',
      `user_id=eq.${uid}&session_id=eq.${encodeURIComponent(sid)}&order=created_at.desc&limit=30`);
    history.reverse();

    const messages = history.map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: message });

    const today = new Date().toISOString().slice(0, 10);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2048,
        system: `${systemPrompt(me.name)}\n\nToday's date: ${today}`,
        messages,
      }),
    });

    if (!r.ok) {
      const txt = await r.text();
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: `anthropic ${r.status}: ${txt.slice(0, 500)}` }));
    }

    const data  = await r.json();
    const reply = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();

    // Persist both turns
    await supaInsert('dblife_chat_messages', { user_id: uid, session_id: sid, role: 'user',      content: message }, { returning: false });
    await supaInsert('dblife_chat_messages', { user_id: uid, session_id: sid, role: 'assistant', content: reply   }, { returning: false });

    return res.end(JSON.stringify({ reply, session_id: sid }));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
