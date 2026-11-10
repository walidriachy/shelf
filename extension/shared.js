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

// ---------- Private Google files ----------
// Shelf's own window can't sign in to Google (Google blocks sign-in inside apps), but this browser
// is signed in. So for Google Docs, Sheets, Slides and Drive files the extension downloads the same
// files Shelf would ask for, using this browser's sign-in, and hands them to Shelf.
const GD = 'https://docs.google.com';

function googleKind(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^www\./, ''); let m;
  if (h === 'docs.google.com' && (m = u.pathname.match(/\/document\/d\/([\w-]+)/))) return { kind: 'gdoc', id: m[1] };
  if (h === 'docs.google.com' && (m = u.pathname.match(/\/spreadsheets\/d\/([\w-]+)/))) return { kind: 'gsheet', id: m[1], gid: (u.hash.match(/gid=(\d+)/) || u.search.match(/gid=(\d+)/) || [])[1] };
  if (h === 'docs.google.com' && (m = u.pathname.match(/\/presentation\/d\/([\w-]+)/))) return { kind: 'gslides', id: m[1] };
  if (h === 'drive.google.com' && ((m = u.pathname.match(/\/file\/d\/([\w-]+)/)) || (m = [null, u.searchParams.get('id')])) && m[1]) return { kind: 'gdrive', id: m[1] };
  return null;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const MAX_FILE = 80 * 1024 * 1024;
async function grab(url) {
  try {
    const r = await fetch(url, { credentials: 'include', redirect: 'follow' });
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_FILE) return null;
    return { url: r.url || url, status: r.status, ok: r.ok, type: (r.headers.get('content-type') || '').toLowerCase(), disposition: r.headers.get('content-disposition') || '', data: toBase64(buf) };
  } catch { return null; }
}

// Returns { requested url: response } for everything Shelf will want, or null if it isn't a Google file.
async function collectGoogle(url) {
  const k = googleKind(url);
  if (!k) return null;
  const want = [];
  if (k.kind === 'gdoc') for (const f of ['md', 'txt', 'html', 'docx', 'pdf']) want.push(`${GD}/document/d/${k.id}/export?format=${f}`);
  if (k.kind === 'gslides') want.push(`${GD}/presentation/d/${k.id}/export/txt`, `${GD}/presentation/d/${k.id}/export/pdf`);
  if (k.kind === 'gdrive') want.push(`https://drive.google.com/uc?export=download&id=${k.id}`);
  if (k.kind === 'gsheet') {
    want.push(`${GD}/spreadsheets/d/${k.id}/export?format=xlsx`, `${GD}/spreadsheets/d/${k.id}/htmlview`);
  }
  const out = {};
  await Promise.all(want.map(async (w) => { const r = await grab(w); if (r) out[w] = r; }));
  if (k.kind === 'gsheet') {
    // Every tab as CSV, found the same way Shelf finds them.
    const hv = out[`${GD}/spreadsheets/d/${k.id}/htmlview`];
    let gids = [];
    try { const h = atob(hv.data); for (const m of h.matchAll(/name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g)) gids.push(m[2]); } catch {}
    if (!gids.length) gids = [k.gid || '0'];
    await Promise.all(gids.slice(0, 20).map(async (g) => { const w = `${GD}/spreadsheets/d/${k.id}/export?format=csv&gid=${g}`; const r = await grab(w); if (r) out[w] = r; }));
  }
  return Object.keys(out).length ? out : null;
}

// Saves a link; Google files go with their downloaded files so private ones work too.
async function saveLinkWithFiles(item) {
  let fetched = null;
  try { fetched = await collectGoogle(item.url); } catch {}
  if (!fetched) return saveLink(item);
  try { return { ...(await shelfFetch('/add-files', { method: 'POST', body: JSON.stringify({ ...item, fetched }) })), withFiles: true, queued: false }; }
  catch (e) { if (e.auth) throw e; return saveLink(item); }   // Shelf closed: queue the link itself
}
