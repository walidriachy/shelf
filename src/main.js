const { app, BrowserWindow, ipcMain, shell, clipboard, globalShortcut, Notification, nativeTheme, protocol, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');
const { Store } = require('./store');
const { fetchMeta } = require('./meta');
const { analyze, ask, provider, aiWorks } = require('./ai');
const { findClaude } = require('./claude');
const { read, get: fetchUrl, openSignIn, openCopy, kindOf, isNotion } = require('./reader');
const shelfPage = require('./shelfpage');
const isYouTube = (u) => { try { return kindOf(u).kind === 'youtube'; } catch { return false; } };
const { sync } = require('./sync');
const library = require('./library');
const r2 = require('./r2');

const BRIDGE_PORT = +(globalThis.process.env.SHELF_BRIDGE_PORT || 47321);
const ANALYSIS_VERSION = 3;
let win, store, syncTimer, syncing = false, watcher, moving = false;

// Each link's saved copy lives in its own folder: content.md, notes.md, original files, screenshot.
const archiveRoot = () => path.join(store.libraryDir, 'archive');
const archiveDir = (id) => path.join(archiveRoot(), String(id).replace(/[^\w-]/g, ''));
const contentCache = new Map();
function contentOf(id) {
  if (contentCache.has(id)) return contentCache.get(id);
  let c = '';
  try { c = fs.readFileSync(path.join(archiveDir(id), 'content.md'), 'utf8').slice(0, 80000); } catch {}
  contentCache.set(id, c);
  return c;
}
// Move a folder, even between drives (a cloud drive is often a separate volume).
function moveDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); }
  catch { fs.cpSync(from, to, { recursive: true }); fs.rmSync(from, { recursive: true, force: true }); }
}
function listFiles(id) {
  const dir = archiveDir(id);
  const size = (p) => { const st = fs.statSync(p); return st.isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0) : st.size; };
  try {
    return fs.readdirSync(dir).filter(f => !f.startsWith('.')).map(f => {
      if (f === 'notion') return { name: 'notion/index.html', size: size(path.join(dir, f)) };   // Shelf Page folder
      return { name: f, size: size(path.join(dir, f)) };
    });
  } catch { return []; }
}

protocol.registerSchemesAsPrivileged([{ scheme: 'shelf', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function pushState() { send('state', { links: store.links(), categories: store.categories() }); }

// A link copied from a sign-in screen or a redirect points at the real page in its parameters
// (accounts.google.com/...?continue=…, google.com/url?q=…): save that page, not the sign-in screen.
function unwrapRedirect(u) {
  const isSignIn = /(^|\.)accounts\.google\.com$/.test(u.hostname) || /\/(signin|login|sign-in|log-in|auth|oauth)\b/i.test(u.pathname);
  const isGoogleUrl = /(^|\.)google\.[a-z.]+$/.test(u.hostname) && u.pathname === '/url';
  if (!isSignIn && !isGoogleUrl) return u;
  for (const k of ['continue', 'followup', 'q', 'url', 'next', 'redirect', 'redirect_uri', 'redirect_url', 'return_to', 'returnTo', 'service_url']) {
    const v = u.searchParams.get(k);
    if (v && /^https?:\/\//i.test(v)) { try { const t = new URL(v); if (t.href !== u.href && !/\/(signin|login)\b/i.test(t.pathname)) return unwrapRedirect(t); } catch {} }
  }
  return u;
}

function normalizeInput(raw) {
  let url = String(raw || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { const u = new URL(url); return u.hostname.includes('.') ? unwrapRedirect(u).href : null; } catch { return null; }
}

// Files the Chrome extension downloaded for a link, waiting for that link to be read.
const browserFiles = new Map();

async function addLink(raw, note = '', fetched = null, page = null) {
  const url = normalizeInput(raw);
  if (!url) return { ok: false, error: 'That does not look like a link' };
  const existing = store.findByUrl(url);
  if (existing) {
    // Sent again from the browser with its files (e.g. it was private before): read it again with them.
    // Sent again from the browser (e.g. it was private before): read it again with what the browser sent.
    if (fetched || page) { browserFiles.set(existing.id, { fetched, page }); processLink(existing.id); }
    return { ok: true, duplicate: true, refreshed: !!(fetched || page), link: existing };
  }
  const link = store.add({ url, note, title: new URL(url).hostname.replace(/^www\./, '') });
  if (fetched || page) browserFiles.set(link.id, { fetched, page });
  pushState();
  processLink(link.id);
  return { ok: true, link };
}

// Links whose AI step failed (Claude signed out, offline, …) are finished automatically once AI answers again.
let retrying = false;
async function retryAiFailures() {
  if (retrying) return;
  const failed = store.links().filter(l => !l.deleted && l.status === 'ready' && /^AI:/.test(l.error || ''));
  if (!failed.length) return;
  retrying = true;
  try { if (await aiWorks(store.settings())) for (const l of failed) processLink(l.id); }
  finally { retrying = false; }
}

// What a built Shelf Page says it's a copy of.
function pageLabel(source = '') {
  if (/Google Doc/.test(source)) return 'a Google Doc';
  if (/Slides/.test(source)) return 'a Google Slides deck';
  if (/pdf/i.test(source)) return 'a PDF';
  if (/word|docx|officedocument/i.test(source)) return 'a Word document';
  return '';
}

// Links saved before Shelf built pages for Docs, Word files and PDFs: build theirs from the files
// already in the archive. Nothing is downloaded again and no AI is used.
async function buildMissingPages() {
  for (const l of store.links()) {
    if (l.deleted || l.page || l.pageTried || isNotion(l.url) || !shelfPage.canHavePage(l.files)) continue;
    let n = 0;
    try { n = await shelfPage.buildFromArchive(archiveDir(l.id), { title: l.title, label: pageLabel(l.source) }); } catch (e) { console.error('Shelf Page', e.message); }
    store.update(l.id, n ? { page: 'notion/index.html', pages: 1, pageTried: true } : { pageTried: true });
    if (n) { pushState(); scheduleSync(); }
  }
}

// Work through links two at a time so pasting many at once doesn't overload the computer.
const queue = [];
let running = 0;
function processLink(id) {
  if (!queue.includes(id)) queue.push(id);
  const l = store.find(id);
  if (l && l.status !== 'pending') { store.update(id, { status: 'pending' }); pushState(); }
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const id = queue.shift();
    running++;
    doProcess(id).catch(e => { store.update(id, { status: 'ready', error: e.message }); pushState(); })
      .finally(() => { running--; pump(); });
  }
}

async function doProcess(id) {
  const link = store.find(id);
  if (!link || link.deleted) return;
  store.update(id, { status: 'pending', error: '' });
  pushState();
  const dir = archiveDir(id);
  const host = (() => { try { return new URL(link.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const hadCopy = fs.existsSync(path.join(dir, 'content.md'));

  // 1. Read the link and save Shelf's own copy.
  let r = null, readError = '';
  // Read into a scratch folder on this computer first, so a half-saved copy never reaches the cloud folder.
  const incoming = path.join(app.getPath('userData'), 'incoming', path.basename(dir));
  fs.rmSync(incoming, { recursive: true, force: true });
  const sent = browserFiles.get(id) || {}; browserFiles.delete(id);
  try { r = await read(link.url, incoming, { fetched: sent.fetched, page: sent.page, libraryDir: store.libraryDir }); }
  catch (e) { readError = e.message; }

  let unusable = !r || r.dead || r.driveView || (r.private && !(r.markdown || '').trim());
  // If a re-read comes back far smaller than the copy we have, the page probably didn't load fully: keep the fuller copy.
  if (!unusable && hadCopy) {
    const oldLen = contentOf(id).length, newLen = (r.markdown || '').length;
    if (oldLen > 2000 && newLen < oldLen * 0.4 && !r.page) { unusable = true; r.partial = true; }
  }
  if (r && !unusable) {
    // Google Docs, Word files and PDFs get Shelf's own editable page too, like Notion pages.
    if (!r.page && !isNotion(link.url)) {
      try { await shelfPage.buildFromArchive(incoming, { docHtml: r.docHtml, title: r.title, fetcher: fetchUrl, label: pageLabel(r.source) }); }
      catch (e) { console.error('Shelf Page', e.message); }
    }
    // Replace the old copy with the fresh one.
    moveDir(incoming, dir);
  } else {
    fs.rmSync(incoming, { recursive: true, force: true });
    // A Drive page saved by an older Shelf as a list of files: that list isn't wanted, drop it.
    if (r && r.driveView) fs.rmSync(dir, { recursive: true, force: true });
  }
  contentCache.delete(id);

  let offline = '';
  if (unusable && r && r.partial) offline = '';
  else if (unusable) {
    if (r && r.driveView) offline = 'This is a Google Drive page, not a file. Drive keeps this address while a file is open in its preview. To save the file itself: in the preview click ⋮ → Open in new window and copy that address, or right-click the file → Share → Copy link.';
    else if (hadCopy) offline = r && r.private ? 'The original is now private. Showing Shelf’s saved copy.' : 'The original link no longer works. Showing Shelf’s saved copy.';
    else if (r && r.private) offline = 'This page is private, so only the address was saved. Use Settings → Sign in to sites, then re-read it.';
    else if (r && r.dead) offline = 'The page could not be found.';
    else offline = 'Could not open the page' + (readError ? ` (${readError})` : '') + '.';
  }

  // Fill in basics a rendered page may lack (titles/images for Google files and PDFs).
  let meta = {};
  if (!r || !r.title || (!r.image && r.kind === 'web')) { try { meta = await fetchMeta(link.url); } catch {} }
  // A private page's preview info is the sign-in screen's ("Sign in", accounts.google.com): don't use it.
  if (r && (r.private || r.viaBrowser)) meta = {};
  const shot = fs.existsSync(path.join(dir, 'screenshot.jpg'));

  // 2. Analyse the saved content with AI.
  const info = {
    url: link.url, host, source: r?.source || (hadCopy ? link.source : ''),
    title: (r && (!unusable || r.driveView) && r.title) || link.title || meta.title || host,
    description: (r && r.description) || meta.description || link.description || '',
    content: contentOf(id), note: link.note, problem: offline, related: relatedTitles(link),
  };
  let a = await analyze(info, store.categories(), store.settings());
  if (a.aiError) a = await analyze(info, store.categories(), store.settings()); // one retry

  // Save the AI's notes as part of the copy too.
  if (a.notes) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'notes.md'), a.notes); }

  const fresh = store.find(id);
  store.update(id, {
    url: (r && !unusable && r.url) || link.url,
    title: (a.title && a.title.length > 3 ? a.title : info.title).slice(0, 200),
    description: info.description,
    // Notion pages share one generic preview image, so Shelf's own screenshot is more useful there.
    image: (r && r.kind === 'notion') ? '' : ((r && r.image) || meta.image || link.image || ''),
    shot,
    favicon: (r && r.favicon) || meta.favicon || link.favicon || (host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : ''),
    source: info.source,
    category: fresh.categoryLocked ? fresh.category : a.category,
    type: a.type || '', tags: a.tags, summary: a.summary, offers: a.offers, pricing: a.pricing || '',
    useFor: a.useFor || [], keyPoints: a.keyPoints || [], notes: a.notes || fresh.notes || '',
    files: listFiles(id).map(f => f.name),
    copy: bestCopy(id),
    page: fs.existsSync(path.join(dir, 'notion', 'index.html')) ? 'notion/index.html' : '',
    pages: fs.existsSync(path.join(dir, 'notion', 'index.html')) ? (isNotion(link.url) ? (r && !unusable && r.pages) || fresh.pages || 1 : 1) : 0,
    archivedAt: (r && !unusable) ? Date.now() : (fresh.archivedAt || 0),
    contentChars: contentOf(id).length,
    offline, status: 'ready', v: ANALYSIS_VERSION,
    pageTried: isNotion(link.url) || (r && !unusable) ? true : fresh.pageTried,
    video: (r && !unusable && r.video) || fresh.video || undefined,
    videoTried: isYouTube(link.url) ? true : undefined,
    error: a.aiError ? 'AI: ' + a.aiError : '',
  });
  pushState();
  scheduleSync();
}

const backupsOn = () => { const s = store.settings(); return !!(s.gistToken || (s.r2On && s.r2AccessKeyId)); };
function scheduleSync(delay = 4000) {
  if (!backupsOn()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  if (syncing) return scheduleSync(3000);
  syncing = true;
  send('sync', { state: 'syncing' });
  try {
    const s = store.settings(), results = [];
    if (s.r2On && s.r2AccessKeyId) results.push(await r2.backup(store, (m) => send('sync', { state: 'syncing', message: m })));
    if (s.gistToken) results.push(await sync(store, archiveRoot()));
    contentCache.clear();
    const r = { ok: results.every(x => x.ok), message: results.map(x => x.message).join(' · ') };
    send('sync', { state: r.ok ? 'ok' : 'off', message: r.message, at: Date.now() });
    pushState();
    return r;
  } catch (e) {
    send('sync', { state: 'error', message: e.message });
    return { ok: false, message: e.message };
  } finally { syncing = false; }
}

// Small local server so the Chrome extension can hand links to the app.
function startBridge() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shelf-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const ok = req.headers['x-shelf-token'] === store.settings().bridgeToken;
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/ping') return reply(ok ? 200 : 401, { app: 'shelf', ok });
    if (!ok) return reply(401, { ok: false, error: 'Wrong connection key. Copy it from Shelf > Settings.' });
    if (req.method === 'GET' && req.url === '/categories') return reply(200, { ok: true, categories: store.categories() });
    // A Google file sent by the extension together with the files it downloaded using the browser's sign-in.
    if (req.method === 'POST' && req.url === '/add-files') {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > 400 * 1024 * 1024) return req.destroy(); chunks.push(c); });
      req.on('end', async () => {
        try {
          const { url, note, category, fetched, page } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const obj = (x) => x && typeof x === 'object' ? x : null;
          const r = await addLink(url, note, obj(fetched), obj(page));
          if (!r.ok) return reply(400, r);
          if (category && !r.duplicate) store.update(r.link.id, { category, categoryLocked: true });
          reply(200, r);
        } catch (e) { reply(400, { ok: false, error: e.message }); }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/add') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', async () => {
        try {
          const { url, note, category } = JSON.parse(body || '{}');
          const r = await addLink(url, note);
          if (r.ok && category && !r.duplicate) store.update(r.link.id, { category, categoryLocked: true });
          reply(r.ok ? 200 : 400, r);
        } catch (e) { reply(400, { ok: false, error: e.message }); }
      });
      return;
    }
    reply(404, { ok: false });
  });
  server.on('error', e => console.error('Bridge error', e.message));
  server.listen(BRIDGE_PORT, '127.0.0.1');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 820, minHeight: 560,
    title: 'Shelf',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111111' : '#fafaf9',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const snap = globalThis.process.env.SHELF_SNAPSHOT;
  if (snap) setTimeout(async () => {
    if (globalThis.process.env.SHELF_SNAPSHOT_JS) { await win.webContents.executeJavaScript(globalThis.process.env.SHELF_SNAPSHOT_JS).catch(() => {}); await new Promise(r => setTimeout(r, 1200)); }
    require('fs').writeFileSync(snap, (await win.webContents.capturePage()).toPNG());
  }, +(globalThis.process.env.SHELF_SNAPSHOT_DELAY || 6000));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); } });
}

ipcMain.handle('init', () => ({
  links: store.links(), categories: store.categories(),
  settings: publicSettings(), platform: process.platform, port: BRIDGE_PORT,
}));
ipcMain.handle('add', (_, url, note) => addLink(url, note));
ipcMain.handle('update', (_, id, patch) => {
  if ('category' in patch) patch.categoryLocked = true;
  const l = store.update(id, patch); pushState(); scheduleSync(); return l;
});
ipcMain.handle('remove', (_, id) => {
  for (const o of store.links()) if ((o.related || []).includes(id)) store.update(o.id, { related: o.related.filter(x => x !== id) });
  store.remove(id); contentCache.delete(id);
  fs.rmSync(archiveDir(id), { recursive: true, force: true });
  pushState(); scheduleSync(); return true;
});
ipcMain.handle('reprocess', (_, id) => { processLink(id); return true; });
ipcMain.handle('reprocess-all', () => { const ls = store.links(); ls.forEach(l => processLink(l.id)); return ls.length; });
ipcMain.handle('ask', (_, q) => ask(q, store.links().map(l => (l.related || []).length ? { ...l, relatedTitles: relatedTitles(l) } : l), store.settings(), contentOf));

// Connected links: a video and the PDF / Notion page / Google Doc that explains it, and so on.
// Connections go both ways and are stored on both links.
function liveRelated(l) { return (l.related || []).filter(rid => { const o = store.find(rid); return o && !o.deleted && rid !== l.id; }); }
function relatedTitles(l) { return liveRelated(l).map(rid => { const o = store.find(rid); return `${o.title || o.url}${o.type ? ` (${o.type})` : ''}`; }).join('; '); }
function link2(a, b, on) {
  for (const [x, y] of [[a, b], [b, a]]) {
    const l = store.find(x); if (!l) continue;
    const set = new Set(liveRelated(l));
    if (on) set.add(y); else set.delete(y);
    store.update(x, { related: [...set] });
  }
}
ipcMain.handle('connect', async (_, id, target) => {
  const l = store.find(id);
  if (!l) return { ok: false, error: 'Link not found' };
  let other = store.find(String(target || ''));
  if (!other) {
    const r = await addLink(target, '');
    if (!r.ok) return r;
    other = r.link;
  }
  if (other.id === id) return { ok: false, error: 'That is this same link' };
  link2(id, other.id, true);
  pushState(); scheduleSync();
  return { ok: true, link: other };
});
ipcMain.handle('disconnect', (_, id, otherId) => { link2(id, otherId, false); pushState(); scheduleSync(); return true; });
ipcMain.handle('detail', (_, id) => {
  const dir = archiveDir(id);
  const readText = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  return { content: readText('content.md'), notes: readText('notes.md'), files: listFiles(id) };
});
// The best exact copy for a link: page snapshot, then original PDF, then any other original file.
function bestCopy(id) {
  const files = listFiles(id).map(f => f.name);
  return ['page.mhtml', 'original.pdf'].find(f => files.includes(f)) || files.find(f => f.startsWith('original')) || '';
}
function openSaved(id, name) {
  const base = archiveDir(id);
  const file = path.resolve(base, String(name));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file)) return 'File not found';
  if (/\.(mhtml|pdf|jpg|png|md|txt|html)$/i.test(file)) { openCopy(file, store.find(id)?.title); return ''; }
  return shell.openPath(file); // .docx / .xlsx open in Word, Excel, Numbers, etc.
}
ipcMain.handle('open-file', (_, id, name) => openSaved(id, name));
ipcMain.handle('open-copy', (_, id, which) => {
  const page = path.join(archiveDir(id), 'notion', 'index.html');
  if (which !== 'snapshot' && fs.existsSync(page)) { openShelfPage(id); return ''; }
  const f = bestCopy(id); return f ? openSaved(id, f) : 'No saved copy yet';
});
ipcMain.handle('show-folder', (_, id) => { const d = archiveDir(id); if (fs.existsSync(d)) shell.showItemInFolder(path.join(d, fs.readdirSync(d)[0] || '')); return true; });
ipcMain.handle('signin', (_, url) => { openSignIn(url); return true; });
ipcMain.handle('open', (_, url) => shell.openExternal(url));
ipcMain.handle('add-category', (_, name) => { const c = store.addCategory(name); pushState(); scheduleSync(); return c; });
ipcMain.handle('remove-category', (_, name) => { const c = store.removeCategory(name); pushState(); scheduleSync(); return c; });
ipcMain.handle('settings', (_, patch) => {
  if (patch && patch.gistToken !== undefined && patch.gistToken !== store.settings().gistToken) patch.gistId = '';
  if (patch) {
    delete patch.libraryDir;
    // Pasted keys and tokens never contain spaces; drop line breaks a wrapped Terminal line adds.
    for (const k of Object.keys(patch)) if (/token|key|secret/i.test(k) && typeof patch[k] === 'string') patch[k] = patch[k].replace(/\s+/g, '');
    store.setSettings(patch);
  }
  if (patch && (patch.gistToken || patch.r2On || patch.r2AccessKeyId)) scheduleSync(200);
  if (patch && (patch.claudeToken || patch.provider || patch.replicateToken || patch.claudeModel)) setTimeout(retryAiFailures, 500);
  return publicSettings();
});
ipcMain.handle('r2-test', async () => {
  const c = r2.client(store.settings());
  if (!c) return { ok: false, message: 'Fill in all four R2 fields first' };
  try { const l = await c.list(); return { ok: true, message: `Connected. ${l.size} Shelf files in the bucket.` }; }
  catch (e) { return { ok: false, message: e.message }; }
});
ipcMain.handle('r2-open-token', () => shell.openExternal(r2.TOKEN_URL));
ipcMain.handle('r2-connect', async (_, token, accountId) => {
  try {
    const cfg = await r2.connect(token, accountId, (m) => send('r2-step', m));
    store.setSettings(cfg);
    send('r2-step', 'Backing up…');
    const r = await runSync();
    return { ok: true, message: r.message, settings: publicSettings() };
  } catch (e) { return { ok: false, message: e.message, needAccount: !!e.needAccount }; }
});
ipcMain.handle('r2-disconnect', () => {
  store.setSettings({ r2On: false, r2AccountId: '', r2Bucket: '', r2AccessKeyId: '', r2Secret: '' });
  return publicSettings();
});
ipcMain.handle('library', () => libraryInfo());
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder for your Shelf library', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = path.basename(r.filePaths[0]) === 'Shelf' ? r.filePaths[0] : path.join(r.filePaths[0], 'Shelf');
  return { dir, ...library.peek(dir) };
});
ipcMain.handle('set-library', (_, target) => setLibrary(target));
ipcMain.handle('show-library', () => { shell.openPath(store.libraryDir); return true; });
ipcMain.handle('sync-now', () => runSync());
ipcMain.handle('copy', (_, text) => { clipboard.writeText(String(text)); return true; });
ipcMain.handle('export', () => JSON.stringify({ links: store.links(), categories: store.categories() }, null, 2));

function libraryInfo() {
  const def = store.defaultLibrary();
  const places = library.detect().map(p => ({ ...p, ...library.peek(p.dir) }));
  return { dir: store.libraryDir, defaultDir: def, where: library.describe(store.libraryDir, def), places, links: store.links().length };
}

// Move the library to another folder (or join a library another computer already keeps there).
async function setLibrary(target) {
  const def = store.defaultLibrary();
  const to = target === 'local' ? def : path.resolve(String(target));
  const from = store.libraryDir;
  if (path.resolve(from) === to) return { ok: true, info: libraryInfo() };
  if (running || queue.length) return { ok: false, message: 'Shelf is still reading links. Try again when they are done.' };
  if (moving) return { ok: false, message: 'Already moving' };
  moving = true;
  send('sync', { state: 'syncing', message: 'Moving library…' });
  try {
    stopWatch();
    const before = store.data.links.length;
    library.mergeInto(from, to, (n, total) => send('sync', { state: 'syncing', message: `Moving library ${n}/${total}` }));
    store.setSettings({ libraryDir: to === def ? undefined : to });
    store.open(to);
    contentCache.clear();
    // The copy on this computer is only removed once everything is safely in the new place.
    if (path.resolve(from) === path.resolve(def) && store.data.links.length >= before) fs.rmSync(from, { recursive: true, force: true });
    startWatch();
    pushState();
    send('sync', { state: backupsOn() ? 'ok' : 'off', message: `Library is now in ${library.describe(to, def).name}` });
    scheduleSync(500);
    return { ok: true, info: libraryInfo() };
  } catch (e) {
    try { store.open(from); startWatch(); } catch {}
    send('sync', { state: 'error', message: e.message });
    return { ok: false, message: e.message };
  } finally { moving = false; }
}

// When the library sits in iCloud Drive / Google Drive, other computers change files in it: pick those up.
let reloadTimer;
function onLibraryChange() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { if (!moving && store.reload()) { contentCache.clear(); pushState(); } }, 800);
}
function startWatch() {
  stopWatch();
  try { watcher = fs.watch(path.join(store.libraryDir, 'links'), onLibraryChange); watcher.on('error', () => {}); } catch {}
}
function stopWatch() { try { watcher && watcher.close(); } catch {} watcher = null; }

// ---- Shelf Pages: viewing and editing ----------------------------------------------------------------
// A page window shows Shelf's Notion-style copy. Edits are saved next to the original page as
// "<page>.mine.html", so the original stays untouched and "Reset to original" just removes your version.
const pageWindows = new Map(); // webContents id -> { id, folder }
const mineOf = (f) => f.replace(/\.html$/, '.mine.html');
const pageName = (name) => { const n = path.basename(String(name || '')).replace(/\.mine\.html$/, '.html'); return /^[\w-]+\.html$/.test(n) ? n : null; };

function openShelfPage(id) {
  const folder = path.join(archiveDir(id), 'notion');
  require('./notion').refresh(folder);
  const start = fs.existsSync(path.join(folder, 'index.mine.html')) ? 'index.mine.html' : 'index.html';
  const s = require('electron').session.fromPartition('shelf-page');
  if (!s.__shelf) { s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?):/i.test(d.url) })); s.__shelf = true; }
  const w = new BrowserWindow({
    width: 1100, height: 880, title: store.find(id)?.title || 'Shelf Page',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff',
    webPreferences: { partition: 'shelf-page', preload: path.join(__dirname, 'page-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const wcId = w.webContents.id;
  pageWindows.set(wcId, { id, folder });
  w.on('closed', () => pageWindows.delete(wcId));
  // Unsaved edits: ask instead of silently refusing to close or leave the page.
  w.webContents.on('will-prevent-unload', (e) => {
    const r = dialog.showMessageBoxSync(w, { type: 'question', buttons: ['Discard changes', 'Keep editing'], defaultId: 1, cancelId: 1, message: 'Discard your unsaved changes?', detail: 'Click Save first if you want to keep them.' });
    if (r === 0) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  // Moving between pages of the copy: always show your version of a page when there is one.
  w.webContents.on('will-navigate', (e, target) => {
    if (target.startsWith('file://')) {
      try {
        const p = path.normalize(decodeURIComponent(new URL(target).pathname));
        const name = pageName(p);
        if (path.dirname(p) === folder && name) {
          const mine = path.join(folder, mineOf(name));
          if (fs.existsSync(mine) && !p.endsWith('.mine.html')) { e.preventDefault(); w.loadFile(mine, { hash: new URL(target).hash.slice(1) || undefined }); }
          return;
        }
      } catch {}
    }
    e.preventDefault();
    if (/^(https?:|mailto:)/i.test(target)) shell.openExternal(target);
  });
  w.loadFile(path.join(folder, start));
  return w;
}

function pageCtx(e) { return pageWindows.get(e.sender.id); }
function markEdited(ctx) {
  const edited = fs.readdirSync(ctx.folder).some(f => f.endsWith('.mine.html'));
  const l = store.find(ctx.id);
  if (l && !!l.edited !== edited) { store.update(ctx.id, { edited }); pushState(); }
}
ipcMain.handle('page-confirm', (e, message, detail, ok) => {
  if (globalThis.process.env.SHELF_TEST_PAGE) return true;
  const w = BrowserWindow.fromWebContents(e.sender);
  return dialog.showMessageBoxSync(w, { type: 'question', buttons: [String(ok || 'OK'), 'Cancel'], defaultId: 1, cancelId: 1, message: String(message), detail: String(detail || '') }) === 0;
});
// Sharing a Shelf Page: one self-contained HTML file, exported to disk or put online through R2.
const SHARE_DAYS = 7;
const pageFolder = (id) => path.join(archiveDir(id), 'notion');
const safeName = (t) => String(t || 'Shelf Page').replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Shelf Page';
async function exportPage(id, parent) {
  const l = store.find(id);
  if (!l || !fs.existsSync(path.join(pageFolder(id), 'index.html'))) return { ok: false, error: 'This link has no Shelf Page' };
  const html = require('./share').bundle(pageFolder(id));
  const r = await dialog.showSaveDialog(parent || win, { title: 'Export Shelf Page', defaultPath: path.join(app.getPath('documents'), safeName(l.title) + '.html'), filters: [{ name: 'Web page', extensions: ['html'] }] });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(r.filePath, html);
  shell.showItemInFolder(r.filePath);
  return { ok: true, file: r.filePath, size: Buffer.byteLength(html) };
}
async function sharePage(id) {
  const l = store.find(id);
  if (!l || !fs.existsSync(path.join(pageFolder(id), 'index.html'))) return { ok: false, error: 'This link has no Shelf Page' };
  const c = store.settings().r2On ? r2.client(store.settings()) : null;
  if (!c) return { ok: false, needR2: true, error: 'Connect Cloudflare R2 in Settings → Backup & sync to make share links.' };
  const html = require('./share').bundle(pageFolder(id));
  // Keep the same address when sharing again, so the newest version replaces the old one.
  const key = (l.share && l.share.key) || `share/${require('crypto').randomBytes(16).toString('hex')}/${safeName(l.title).replace(/[^\w-]+/g, '-').toLowerCase()}.html`;
  await c.put(key, html, 'text/html; charset=utf-8');
  const url = c.link(key, SHARE_DAYS * 86400);
  const share = { key, url, at: Date.now(), expires: Date.now() + SHARE_DAYS * 86400e3 };
  store.update(id, { share });
  clipboard.writeText(url);
  pushState(); scheduleSync();
  return { ok: true, ...share };
}
async function unsharePage(id) {
  const l = store.find(id);
  if (!l || !l.share) return { ok: true };
  const c = r2.client(store.settings());
  if (c) { try { await c.del(l.share.key); } catch (e) { return { ok: false, error: e.message }; } }
  store.update(id, { share: null });
  pushState(); scheduleSync();
  return { ok: true };
}
const wrap = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return { ok: false, error: e.message }; } };
ipcMain.handle('export-page', wrap((_, id) => exportPage(id)));
ipcMain.handle('share-page', wrap((_, id) => sharePage(id)));
ipcMain.handle('unshare-page', wrap((_, id) => unsharePage(id)));
ipcMain.handle('page-export', wrap((e) => { const c = pageCtx(e); return c ? exportPage(c.id, BrowserWindow.fromWebContents(e.sender)) : { ok: false }; }));
ipcMain.handle('page-share', wrap((e) => { const c = pageCtx(e); return c ? sharePage(c.id) : { ok: false }; }));

ipcMain.handle('page-info', (e, name) => {
  const ctx = pageCtx(e), n = pageName(name);
  return { mine: !!(ctx && n && fs.existsSync(path.join(ctx.folder, mineOf(n)))) };
});
ipcMain.handle('page-save', (e, name, html) => {
  const ctx = pageCtx(e), n = pageName(name);
  if (!ctx || !n || typeof html !== 'string' || html.length > 20e6) return { ok: false, message: 'Could not save this page' };
  fs.writeFileSync(path.join(ctx.folder, mineOf(n)), html);
  markEdited(ctx);
  scheduleSync();
  return { ok: true };
});
ipcMain.handle('page-reset', (e, name) => {
  const ctx = pageCtx(e), n = pageName(name);
  if (!ctx || !n) return false;
  fs.rmSync(path.join(ctx.folder, mineOf(n)), { force: true });
  markEdited(ctx);
  scheduleSync();
  return true;
});
ipcMain.handle('page-image', async (e) => {
  const ctx = pageCtx(e);
  if (!ctx) return null;
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Add an image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const ext = path.extname(r.filePaths[0]).toLowerCase();
  const name = 'mine-' + Date.now().toString(36) + ext;
  fs.mkdirSync(path.join(ctx.folder, 'img'), { recursive: true });
  fs.copyFileSync(r.filePaths[0], path.join(ctx.folder, 'img', name));
  return 'img/' + name;
});

function publicSettings() {
  const s = store.settings();
  return {
    r2On: !!s.r2On, r2AccountId: s.r2AccountId || '', r2Bucket: s.r2Bucket || '', r2AccessKeyId: s.r2AccessKeyId || '',
    hasR2Secret: !!s.r2Secret, r2LastBackup: s.r2LastBackup || 0,
    library: { dir: store.libraryDir, where: library.describe(store.libraryDir, store.defaultLibrary()) },
    model: s.model, bridgeToken: s.bridgeToken, gistId: s.gistId || '', lastSync: s.lastSync || 0,
    hasReplicate: !!s.replicateToken, hasGist: !!s.gistToken,
    replicateHint: s.replicateToken ? '••••' + s.replicateToken.slice(-4) : '',
    gistHint: s.gistToken ? '••••' + s.gistToken.slice(-4) : '',
    provider: s.provider || 'auto', activeProvider: provider(s), claudeFound: !!findClaude(),
    claudeModel: s.claudeModel || 'haiku', hasClaudeToken: !!s.claudeToken,
    claudeHint: s.claudeToken ? '••••' + s.claudeToken.slice(-4) : '',
  };
}

// SHELF_DATA lets you point at a separate data folder (handy for testing). Set before the
// single-instance lock, which belongs to the data folder, so a test copy can run beside Shelf.
if (globalThis.process.env.SHELF_DATA) app.setPath('userData', globalThis.process.env.SHELF_DATA);
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'));
    // shelf://archive/<id>/<file> serves saved screenshots to the window.
    protocol.handle('shelf', (req) => {
      const u = new URL(req.url);
      const [id, file] = u.pathname.split('/').filter(Boolean);
      if (u.hostname !== 'archive' || !id || !file) return new Response('Not found', { status: 404 });
      const p = path.join(archiveDir(id), path.basename(decodeURIComponent(file)));
      if (!fs.existsSync(p)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(p).toString());
    });
    createWindow();
    startBridge();
    // Dev only: open the first Shelf Page and run a script in it (used for automated checks).
    if (globalThis.process.env.SHELF_TEST_PAGE) setTimeout(async () => {
      const l = store.links().find(x => x.page);
      const w = openShelfPage(l.id);
      const out = globalThis.process.env.SHELF_TEST_PAGE;
      const tlog = (...a) => { fs.appendFileSync(out + '/result.txt', a.join(' ') + '\n'); };
      const steps = JSON.parse(fs.readFileSync(out + '/steps.json', 'utf8'));
      tlog('START', l && l.id);
      await new Promise(r => setTimeout(r, 2500));
      for (const [i, st] of steps.entries()) {
        try { const r = await w.webContents.executeJavaScript(st.js); tlog('STEP', i, JSON.stringify(r)); } catch (e) { tlog('STEP', i, 'ERR', e.message); }
        await new Promise(r => setTimeout(r, st.wait || 800));
        if (st.shot) fs.writeFileSync(path.join(out, st.shot + '.png'), (await w.webContents.capturePage()).resize({ width: 900 }).toPNG());
      }
      tlog('FILES', fs.readdirSync(path.join(archiveDir(l.id), 'notion')).join(','), 'edited', store.find(l.id).edited);
      app.quit();
    }, 3000);
    startWatch();
    setInterval(onLibraryChange, 60 * 1000); // in case a change notification is missed
    // Save whatever link is on the clipboard from anywhere.
    globalShortcut.register('CommandOrControl+Shift+L', async () => {
      const r = await addLink(clipboard.readText());
      if (Notification.isSupported()) new Notification({ title: 'Shelf', body: r.ok ? (r.duplicate ? 'Already saved' : 'Saved link from clipboard') : 'No link on the clipboard' }).show();
    });
    // Retry anything left half-done, and upgrade links saved before the detailed analysis existed.
    // Notion links saved before Shelf Pages existed get one re-read to build theirs.
    const needsPage = (l) => (isNotion(l.url) && !l.page && !l.pageTried) || (isYouTube(l.url) && !l.videoTried);
    for (const l of store.links()) if (l.status === 'pending' || (l.v || 0) < ANALYSIS_VERSION || needsPage(l)) processLink(l.id);
    setTimeout(() => buildMissingPages().catch(e => console.error('Shelf Pages', e.message)), 3000);
    setTimeout(retryAiFailures, 20 * 1000);
    setInterval(retryAiFailures, 15 * 60 * 1000);
    scheduleSync(1500);
    setInterval(() => scheduleSync(0), 5 * 60 * 1000);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
