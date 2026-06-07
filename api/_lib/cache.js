// In-memory TTL cache. Lives for the lifetime of a warm serverless container.
// Good enough for dblife snapshot endpoints — keeps downstream load low and
// the UI snappy. Cold starts pay one fresh fetch.

const store = new Map();

function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { store.delete(key); return null; }
  return hit;
}

function set(key, value, ttlMs) {
  const fetchedAt = Date.now();
  store.set(key, { value, fetchedAt, expiresAt: fetchedAt + ttlMs });
}

async function withCache(key, ttlMs, loader) {
  const hit = get(key);
  if (hit) return { value: hit.value, cached: true, fetchedAt: hit.fetchedAt };
  const value = await loader();
  set(key, value, ttlMs);
  return { value, cached: false, fetchedAt: Date.now() };
}

module.exports = { get, set, withCache };
