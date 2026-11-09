// Talks to the Shelf desktop app on this computer. If the app is closed, links wait in a queue.
const SHELF = 'http://127.0.0.1:47321';

async function getKey() { return (await chrome.storage.local.get('key')).key || ''; }

async function shelfFetch(path, opts = {}) {
  const key = await getKey();
  const res = await fetch(SHELF + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Shelf-Token': key, ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error('Connection key is wrong. Paste it from Shelf → Settings.'), { auth: true });
  if (!res.ok) throw new Error(body.error || 'Shelf refused the link');
  return body;
}

async function saveLink(item) {
  try { return { ...(await shelfFetch('/add', { method: 'POST', body: JSON.stringify(item) })), queued: false }; }
  catch (e) {
    if (e.auth) throw e;
    const { queue = [] } = await chrome.storage.local.get('queue');
    if (!queue.some(q => q.url === item.url)) queue.push(item);
    await chrome.storage.local.set({ queue });
    return { ok: true, queued: true };
  }
}

async function flushQueue() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  if (!queue.length) return 0;
  const left = [];
  for (const item of queue) { try { await shelfFetch('/add', { method: 'POST', body: JSON.stringify(item) }); } catch { left.push(item); } }
  await chrome.storage.local.set({ queue: left });
  return queue.length - left.length;
}
