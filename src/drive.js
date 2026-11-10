// Reads Google Drive links through Google Drive for desktop, when it's installed and signed in on this
// computer. Drive for desktop keeps a local list of the files in your Drive and the files themselves, so
// Shelf can save a private Drive PDF or Word file from its link without signing in to Google.
// Only read, never changed. If Drive for desktop isn't there, everything here quietly returns null.
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
const FOLDER = 'application/vnd.google-apps.folder';
const GOOGLE_TYPES = {
  'application/vnd.google-apps.document': ['Google Doc', (id) => `https://docs.google.com/document/d/${id}/edit`],
  'application/vnd.google-apps.spreadsheet': ['Google Sheet', (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`],
  'application/vnd.google-apps.presentation': ['Google Slides', (id) => `https://docs.google.com/presentation/d/${id}/edit`],
  'application/vnd.google-apps.form': ['Google Form', (id) => `https://docs.google.com/forms/d/${id}/edit`],
  'application/vnd.google-apps.drawing': ['Google Drawing', (id) => `https://docs.google.com/drawings/d/${id}/edit`],
  [FOLDER]: ['Folder', (id) => `https://drive.google.com/drive/folders/${id}`],
};
const LIVE = 'trashed = 0 AND is_tombstone = 0';

// Which Drive page a link is: { view: 'recent' | 'starred' | 'shared' | 'my-drive' | 'folder' | 'file', id }.
function driveTarget(url) {
  let u; try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^www\./, '');
  let m;
  if (h === 'drive.google.com') {
    const p = u.pathname.replace(/\/u\/\d+(?=\/)/, '');
    if ((m = p.match(/^\/drive(?:\/u\/\d+)?\/folders\/([\w-]+)/))) return { view: 'folder', id: m[1] };
    if ((m = p.match(/^\/drive\/(recent|starred|shared-with-me|my-drive|home|computers|quota|search)\b/))) return { view: { 'shared-with-me': 'shared', home: 'recent', search: 'recent' }[m[1]] || m[1] };
    if (/^\/drive\/?$/.test(p)) return { view: 'my-drive' };
    if ((m = p.match(/^\/file\/d\/([\w-]+)/))) return { view: 'file', id: m[1] };
    if (/^\/(open|uc)$/.test(p) && u.searchParams.get('id')) return { view: 'file', id: u.searchParams.get('id') };
  }
  return null;
}

// Drive for desktop's local item list for each signed-in account, paired with where its files are.
function accounts() {
  const base = isWin ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'DriveFS')
    : path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'DriveFS');
  let dirs = [];
  try { dirs = fs.readdirSync(base).map(d => path.join(base, d)).filter(d => fs.existsSync(path.join(d, 'metadata_sqlite_db'))); } catch { return []; }
  const mounts = [];
  if (isWin) { for (const l of 'DEFGHIJKLMNOPQRSTUVWXYZ') { const r = `${l}:\\`; try { if (fs.existsSync(path.join(r, 'My Drive'))) mounts.push(r); } catch {} } }
  else { const cs = path.join(os.homedir(), 'Library', 'CloudStorage'); try { for (const d of fs.readdirSync(cs)) if (d.startsWith('GoogleDrive-')) mounts.push(path.join(cs, d)); } catch {} }
  return dirs.map(d => ({ db: path.join(d, 'metadata_sqlite_db'), mounts }));
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

// A helper bound to one account's item list: titles, parents and paths of items.
function catalog(db, mounts) {
  const byStable = db.prepare('SELECT stable_id, id, local_title, mime_type, is_folder, modified_date, viewed_by_me_date, file_size FROM items WHERE stable_id = ?');
  const parentOf = db.prepare('SELECT parent_stable_id FROM stable_parents WHERE item_stable_id = ? LIMIT 1');
  const cache = new Map();
  // Folder names from the top ("My Drive", "Work", …) down to the item.
  function chain(sid) {
    if (cache.has(sid)) return cache.get(sid);
    const out = [];
    let cur = sid, guard = 0;
    while (cur && guard++ < 64) {
      const it = byStable.get(cur);
      if (!it) break;
      out.unshift(it.local_title);
      const p = parentOf.get(cur);
      cur = p ? p.parent_stable_id : null;
    }
    cache.set(sid, out);
    return out;
  }
  // The item's place on this computer, if it's in My Drive.
  let mount = null;
  function localPath(sid) {
    const c = chain(sid);
    if (c[0] !== 'My Drive') return '';
    if (mount === null) {
      // Several Google accounts: use the mount whose My Drive has this item's top folder.
      mount = mounts.find(m => c.length < 2 || fs.existsSync(path.join(m, 'My Drive', c[1]))) || mounts[0] || '';
    }
    return mount ? path.join(mount, ...c) : '';
  }
  return { chain, localPath };
}

// Where a Drive file is on this computer (through Drive for desktop), or null.
function localFile(id) {
  for (const acc of accounts()) {
    let db;
    try {
      db = openDb(acc.db);
      const it = db.prepare(`SELECT stable_id, id, local_title, mime_type, file_size FROM items WHERE id = ? AND ${LIVE} AND is_folder = 0`).get(id);
      if (!it) continue;
      const p = catalog(db, acc.mounts).localPath(it.stable_id);
      if (p && fs.existsSync(p)) return { path: p, name: it.local_title, mime: it.mime_type, size: Number(it.file_size || 0), google: !!GOOGLE_TYPES[it.mime_type] };
    } catch (e) { console.error('Drive for desktop', e.message); }
    finally { try { db && db.close(); } catch {} }
  }
  return null;
}

const available = () => accounts().length > 0;

module.exports = { driveTarget, localFile, available };
