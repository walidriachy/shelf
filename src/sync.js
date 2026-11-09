// Free cloud sync through one private GitHub Gist.
// Every computer running Shelf with the same GitHub token reads and writes the same gist.
// Only links and categories go up; your tokens never leave the machine.

const FILE = 'shelf.json';
const DESCRIPTION = 'Shelf links (synced by the Shelf app)';
const API = 'https://api.github.com';

function headers(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'Shelf-App' };
}

async function gh(token, method, path, body) {
  const res = await fetch(API + path, { method, headers: headers(token), body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message ? `GitHub: ${json.message}` : `GitHub error ${res.status}`);
  return json;
}

async function findGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await gh(token, 'GET', `/gists?per_page=100&page=${page}`);
    const hit = list.find(g => g.description === DESCRIPTION && g.files && g.files[FILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  return null;
}

async function readGist(token, id) {
  const g = await gh(token, 'GET', `/gists/${id}`);
  const f = g.files && g.files[FILE];
  if (!f) return null;
  let content = f.content;
  if (f.truncated && f.raw_url) content = await (await fetch(f.raw_url, { headers: headers(token) })).text();
  try { return JSON.parse(content); } catch { return null; }
}

function merge(local, remote) {
  const byId = new Map();
  for (const l of [...(remote?.links || []), ...local.links]) {
    const cur = byId.get(l.id);
    if (!cur || (l.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(l.id, l);
  }
  const categories = [...new Set([...(local.categories || []), ...(remote?.categories || [])])];
  return { links: [...byId.values()], categories };
}

// Full text copies are packed into archive-N.json files (each under ~900 KB) next to shelf.json.
// Original files like PDFs stay on the computer that saved them; their extracted text is synced.
const fs = require('fs');
const path = require('path');
const CHUNK = 900000;
const PER_LINK = 200000;

function localArchives(root, ids) {
  const out = {};
  for (const id of ids) {
    try { out[id] = fs.readFileSync(path.join(root, id, 'content.md'), 'utf8').slice(0, PER_LINK); } catch {}
  }
  return out;
}

function packChunks(archives) {
  const chunks = [];
  let cur = {}, size = 0;
  for (const id of Object.keys(archives).sort()) {
    const len = archives[id].length + id.length + 10;
    if (size + len > CHUNK && size > 0) { chunks.push(cur); cur = {}; size = 0; }
    cur[id] = archives[id]; size += len;
  }
  if (size > 0) chunks.push(cur);
  return chunks;
}

async function fileContent(token, f) {
  if (!f.truncated) return f.content;
  return (await fetch(f.raw_url, { headers: headers(token) })).text();
}

async function sync(store, archiveRoot) {
  const s = store.settings();
  const token = s.gistToken;
  if (!token) return { ok: false, message: 'Cloud sync is off' };

  let id = s.gistId || await findGist(token);
  let gist = null;
  if (id) { try { gist = await gh(token, 'GET', `/gists/${id}`); } catch { id = null; } }
  let remote = null;
  if (gist && gist.files[FILE]) { try { remote = JSON.parse(await fileContent(token, gist.files[FILE])); } catch {} }
  const merged = merge(store.data, remote);
  store.data.links = merged.links;
  store.data.categories = merged.categories;
  store.save();

  // Bring down saved copies this computer doesn't have yet.
  const live = merged.links.filter(l => !l.deleted).map(l => l.id);
  const remoteChunks = {};
  if (gist && archiveRoot) {
    for (const [name, f] of Object.entries(gist.files)) {
      if (!/^archive-\d+\.json$/.test(name)) continue;
      try {
        const text = await fileContent(token, f);
        remoteChunks[name] = text;
        for (const [lid, content] of Object.entries(JSON.parse(text))) {
          const file = path.join(archiveRoot, lid.replace(/[^\w-]/g, ''), 'content.md');
          if (live.includes(lid) && !fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
        }
      } catch {}
    }
  }

  const files = { [FILE]: { content: JSON.stringify({ version: 2, links: merged.links, categories: merged.categories }) } };
  if (archiveRoot) {
    const chunks = packChunks(localArchives(archiveRoot, live));
    chunks.forEach((c, i) => {
      const text = JSON.stringify(c);
      if (remoteChunks[`archive-${i}.json`] !== text) files[`archive-${i}.json`] = { content: text };
    });
    for (const name of Object.keys(remoteChunks)) { const i = +name.match(/\d+/)[0]; if (i >= chunks.length) files[name] = null; }
  }
  if (id) await gh(token, 'PATCH', `/gists/${id}`, { files });
  else id = (await gh(token, 'POST', '/gists', { public: false, description: DESCRIPTION, files: Object.fromEntries(Object.entries(files).filter(([, v]) => v)) })).id;

  store.setSettings({ gistId: id, lastSync: Date.now() });
  return { ok: true, message: `Synced ${merged.links.filter(l => !l.deleted).length} links`, gistId: id };
}

module.exports = { sync };
