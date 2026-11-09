// Where the library lives: this computer only, or a cloud drive folder (iCloud Drive, Google Drive,
// Dropbox, OneDrive) so the cloud app keeps it backed up and the same on every computer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson } = require('./store');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function cloudStorage(prefix) {
  const base = path.join(os.homedir(), 'Library', 'CloudStorage');
  try { return fs.readdirSync(base).filter(n => n.startsWith(prefix)).map(n => path.join(base, n)); } catch { return []; }
}

function driveLetters() {
  const out = [];
  for (const c of 'DEFGHIJKLMNOPQRSTUVWXYZ') out.push(`${c}:\\`);
  return out;
}

// Each cloud service's folder on this computer, if its app is installed and signed in.
function detect() {
  const home = os.homedir();
  const mac = process.platform === 'darwin', win = process.platform === 'win32';
  const found = [];
  const add = (id, name, dir, account = '') => { if (dir && isDir(dir) && !found.some(f => f.id === id)) found.push({ id, name, root: dir, account }); };

  // iCloud Drive
  if (mac) add('icloud', 'iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  if (win) add('icloud', 'iCloud Drive', path.join(home, 'iCloudDrive'));

  // Google Drive (Drive for desktop)
  if (mac) {
    for (const d of cloudStorage('GoogleDrive-')) add('gdrive', 'Google Drive', path.join(d, 'My Drive'), path.basename(d).replace('GoogleDrive-', ''));
    add('gdrive', 'Google Drive', path.join(home, 'Google Drive', 'My Drive'));
  }
  if (win) {
    for (const d of driveLetters()) add('gdrive', 'Google Drive', path.join(d, 'My Drive'));
    add('gdrive', 'Google Drive', path.join(home, 'Google Drive', 'My Drive'));
  }

  // Dropbox and OneDrive, for people who use those instead.
  if (mac) for (const d of cloudStorage('Dropbox')) add('dropbox', 'Dropbox', d);
  add('dropbox', 'Dropbox', path.join(home, 'Dropbox'));
  if (mac) for (const d of cloudStorage('OneDrive')) add('onedrive', 'OneDrive', d);
  if (win) add('onedrive', 'OneDrive', process.env.OneDrive || path.join(home, 'OneDrive'));

  return found.map(f => ({ ...f, dir: path.join(f.root, 'Shelf') }));
}

// Which kind of place a library folder is in, for the label in Settings.
function describe(dir, defaultDir) {
  if (path.resolve(dir) === path.resolve(defaultDir)) return { id: 'local', name: 'This computer only' };
  const hit = detect().find(f => path.resolve(dir).startsWith(path.resolve(f.root) + path.sep) || path.resolve(dir) === path.resolve(f.root));
  return hit ? { id: hit.id, name: hit.name } : { id: 'folder', name: 'Custom folder' };
}

function linkIds(dir) {
  try { return fs.readdirSync(path.join(dir, 'links')).filter(f => f.endsWith('.json') && !f.startsWith('.')).map(f => f.slice(0, -5)); } catch { return []; }
}

// Copy one library into another. Links that exist in both keep whichever was changed last;
// saved copies are added when missing. Nothing in the destination is deleted.
function mergeInto(from, to, onProgress = () => {}) {
  fs.mkdirSync(path.join(to, 'links'), { recursive: true });
  fs.mkdirSync(path.join(to, 'archive'), { recursive: true });
  const ids = linkIds(from);
  let n = 0;
  for (const id of ids) {
    const src = readJson(path.join(from, 'links', `${id}.json`), null);
    const dstFile = path.join(to, 'links', `${id}.json`);
    const dst = readJson(dstFile, null);
    if (src && (!dst || (src.updatedAt || 0) > (dst.updatedAt || 0))) fs.copyFileSync(path.join(from, 'links', `${id}.json`), dstFile);
    const a = path.join(from, 'archive', id), b = path.join(to, 'archive', id);
    if (isDir(a)) {
      fs.mkdirSync(b, { recursive: true });
      for (const f of fs.readdirSync(a)) {
        if (f.startsWith('.')) continue;
        const target = path.join(b, f);
        const newer = src && dst && (src.updatedAt || 0) > (dst.updatedAt || 0);
        if (!fs.existsSync(target) || newer) fs.cpSync(path.join(a, f), target, { recursive: true });
      }
    }
    onProgress(++n, ids.length);
  }
  const cats = [...new Set([...(readJson(path.join(to, 'categories.json'), []) || []), ...(readJson(path.join(from, 'categories.json'), []) || [])])];
  if (cats.length) fs.writeFileSync(path.join(to, 'categories.json'), JSON.stringify(cats, null, 1));
  return ids.length;
}

// Is this folder already a Shelf library (for example, made by Shelf on another computer)?
function peek(dir) {
  const ids = linkIds(dir);
  let live = 0;
  for (const id of ids) { const l = readJson(path.join(dir, 'links', `${id}.json`), null); if (l && !l.deleted) live++; }
  return { exists: isDir(dir), links: live };
}

module.exports = { detect, describe, mergeInto, peek, isDir };
