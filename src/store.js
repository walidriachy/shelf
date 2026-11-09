// Shelf's storage.
//
// The library (links + saved copies) lives in one folder that can sit inside iCloud Drive,
// Google Drive or any synced folder:
//   <library>/links/<id>.json      one small file per link, so two computers never overwrite each other
//   <library>/categories.json
//   <library>/archive/<id>/...     exact copies, original files, screenshots, text
//
// Settings and tokens stay on this computer only (<config>/settings.json), never in the cloud folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CATEGORIES = ['AI', 'Design', 'Development', 'Skills & Learning', 'Tools', 'Inspiration', 'Other'];

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

class Store {
  constructor(configDir) {
    this.configDir = configDir;
    this.settingsFile = path.join(configDir, 'settings.json');
    this.written = new Map(); // id -> last JSON we wrote, to skip no-op writes and ignore our own file events
    const legacy = readJson(path.join(configDir, 'shelf.json'), null);
    this.s = readJson(this.settingsFile, null) || { ...(legacy && legacy.settings) };
    if (!this.s.bridgeToken) this.s.bridgeToken = crypto.randomBytes(12).toString('hex');
    if (!this.s.model) this.s.model = 'meta/meta-llama-3-70b-instruct';
    this.saveSettings();
    this.data = { links: [], categories: [] };
    this.open(this.s.libraryDir || this.defaultLibrary());
    if (legacy) this.migrateLegacy(legacy);
  }

  defaultLibrary() { return path.join(this.configDir, 'library'); }

  // Point the store at a library folder and load it.
  open(dir) {
    this.libraryDir = dir;
    fs.mkdirSync(path.join(dir, 'links'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    this.written.clear();
    this.data.links = this.readLinks();
    const cats = readJson(path.join(dir, 'categories.json'), null);
    this.data.categories = Array.isArray(cats) && cats.length ? cats : DEFAULT_CATEGORIES.slice();
    if (!cats) this.saveCategories();
  }

  readLinks() {
    const dir = path.join(this.libraryDir, 'links');
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const l = readJson(path.join(dir, f), null);
      if (l && l.id) out.push(l);
    }
    return out;
  }

  // Files from shelf 1.x (one big shelf.json in the app folder) become the new layout.
  migrateLegacy(legacy) {
    const byId = new Map(this.data.links.map(l => [l.id, l]));
    for (const l of legacy.links || []) {
      const cur = byId.get(l.id);
      if (!cur || (l.updatedAt || 0) > (cur.updatedAt || 0)) { byId.set(l.id, l); this.writeLink(l); }
    }
    this.data.links = [...byId.values()];
    this.data.categories = [...new Set([...this.data.categories, ...(legacy.categories || [])])];
    this.saveCategories();
    const oldArchive = path.join(this.configDir, 'archive');
    if (fs.existsSync(oldArchive)) {
      for (const id of fs.readdirSync(oldArchive)) {
        const to = path.join(this.libraryDir, 'archive', id);
        if (!fs.existsSync(to)) fs.cpSync(path.join(oldArchive, id), to, { recursive: true });
      }
      fs.rmSync(oldArchive, { recursive: true, force: true });
    }
    fs.renameSync(path.join(this.configDir, 'shelf.json'), path.join(this.configDir, 'shelf.json.before-v2'));
  }

  linkFile(id) { return path.join(this.libraryDir, 'links', `${String(id).replace(/[^\w-]/g, '')}.json`); }

  writeLink(l) {
    const text = JSON.stringify(l, null, 1);
    if (this.written.get(l.id) === text) return;
    writeAtomic(this.linkFile(l.id), text);
    this.written.set(l.id, text);
  }

  saveCategories() { writeAtomic(path.join(this.libraryDir, 'categories.json'), JSON.stringify(this.data.categories, null, 1)); }
  saveSettings() { fs.mkdirSync(this.configDir, { recursive: true }); writeAtomic(this.settingsFile, JSON.stringify(this.s, null, 2)); }

  // Kept for code that changes data.links / data.categories in bulk (cloud sync merges).
  save() { for (const l of this.data.links) this.writeLink(l); this.saveCategories(); }

  // Pick up changes another computer made through the shared folder. Returns true if anything changed.
  reload() {
    const disk = this.readLinks();
    const byId = new Map(this.data.links.map(l => [l.id, l]));
    let changed = false;
    for (const l of disk) {
      const cur = byId.get(l.id);
      if (!cur || (l.updatedAt || 0) > (cur.updatedAt || 0)) { byId.set(l.id, l); this.written.set(l.id, JSON.stringify(l, null, 1)); changed = true; }
    }
    if (changed) this.data.links = [...byId.values()];
    const cats = readJson(path.join(this.libraryDir, 'categories.json'), null);
    if (Array.isArray(cats)) {
      const merged = [...new Set([...this.data.categories, ...cats])];
      if (merged.length !== this.data.categories.length) { this.data.categories = merged; changed = true; }
    }
    return changed;
  }

  // Visible links (deleted ones stay as small tombstones so other computers delete them too).
  links() { return this.data.links.filter(l => !l.deleted).sort((a, b) => b.createdAt - a.createdAt); }
  find(id) { return this.data.links.find(l => l.id === id); }
  findByUrl(url) { return this.data.links.find(l => !l.deleted && normalize(l.url) === normalize(url)); }

  add(partial) {
    const now = Date.now();
    const link = {
      id: crypto.randomUUID(), url: partial.url, title: '', description: '', image: '', favicon: '',
      category: 'Other', tags: [], summary: '', note: partial.note || '', status: 'pending',
      createdAt: now, updatedAt: now, ...partial,
    };
    this.data.links.push(link);
    this.writeLink(link);
    return link;
  }

  update(id, patch) {
    const link = this.find(id);
    if (!link) return null;
    Object.assign(link, patch, { updatedAt: Date.now() });
    if (link.category && !link.deleted && !this.data.categories.includes(link.category)) { this.data.categories.push(link.category); this.saveCategories(); }
    this.writeLink(link);
    return link;
  }

  remove(id) {
    const l = this.find(id);
    if (!l) return null;
    for (const k of Object.keys(l)) if (!['id', 'url', 'createdAt'].includes(k)) delete l[k];
    return this.update(id, { deleted: true });
  }

  settings() { return this.s; }
  setSettings(patch) { Object.assign(this.s, patch); this.saveSettings(); return this.s; }

  categories() { return this.data.categories; }
  addCategory(name) {
    name = String(name || '').trim();
    if (name && !this.data.categories.includes(name)) { this.data.categories.push(name); this.saveCategories(); }
    return this.data.categories;
  }
  removeCategory(name) {
    this.data.categories = this.data.categories.filter(c => c !== name);
    for (const l of this.data.links) if (l.category === name) { l.category = 'Other'; l.updatedAt = Date.now(); this.writeLink(l); }
    if (!this.data.categories.includes('Other')) this.data.categories.push('Other');
    this.saveCategories();
    return this.data.categories;
  }
}

function normalize(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return (u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '') + u.search).toLowerCase();
  } catch { return String(url).toLowerCase(); }
}

module.exports = { Store, normalize, DEFAULT_CATEGORIES, readJson, writeAtomic };
