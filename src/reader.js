// Reads a link and saves Shelf's own copy of it, so the content survives even if the link dies.
// - Web pages (including Notion and other script-heavy pages) are rendered in a hidden browser window.
// - Google Docs / Sheets / Slides are exported (text + the original file).
// - PDFs and Drive files are downloaded and their text extracted.
const { BrowserWindow, session, shell } = require('electron');
const notion = require('./notion');
const drive = require('./drive');
const fs = require('fs');
const path = require('path');

const PARTITION = 'persist:shelf-reader';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MAX_CONTENT = 600000;

function ses() {
  const s = session.fromPartition(PARTITION);
  s.setUserAgent(UA);
  return s;
}

function kindOf(url) {
  const u = new URL(url);
  const h = u.hostname.replace(/^www\./, '');
  let m;
  if (h === 'docs.google.com' && (m = u.pathname.match(/\/document\/d\/([\w-]+)/))) return { kind: 'gdoc', id: m[1] };
  if (h === 'docs.google.com' && (m = u.pathname.match(/\/spreadsheets\/d\/([\w-]+)/))) return { kind: 'gsheet', id: m[1], gid: (u.hash.match(/gid=(\d+)/) || u.search.match(/gid=(\d+)/) || [])[1] };
  if (h === 'docs.google.com' && (m = u.pathname.match(/\/presentation\/d\/([\w-]+)/))) return { kind: 'gslides', id: m[1] };
  if (h === 'drive.google.com' && (m = u.pathname.match(/\/file\/d\/([\w-]+)/) || [null, u.searchParams.get('id')]) && m[1]) return { kind: 'gdrive', id: m[1] };
  if (/(^|\.)notion\.(so|site|com)$/.test(h)) return { kind: 'notion' };   // notion.so, app.notion.com, *.notion.site
  const yt = youtubeId(u);
  if (yt) return { kind: 'youtube', id: yt };
  return { kind: 'web' };
}

function youtubeId(u) {
  const h = u.hostname.replace(/^(www|m|music)\./, '');
  let m;
  if (h === 'youtu.be') return (u.pathname.match(/^\/([\w-]{11})/) || [])[1] || '';
  if (h !== 'youtube.com' && h !== 'youtube-nocookie.com') return '';
  if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
  if ((m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/))) return m[1];
  return '';
}

const clock = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

// Runs inside the YouTube page: the video's details and chapters, then plays the video (muted, in a
// hidden window) with captions switched on, so YouTube's own player loads the captions. Shelf picks
// those up as the page receives them. This is the same text you see with CC turned on.
const YT_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const p = window.ytInitialPlayerResponse || {};
  const vd = p.videoDetails || {}, mf = (p.microformat || {}).playerMicroformatRenderer || {};
  const out = {
    id: vd.videoId || '', title: vd.title || document.title.replace(/ - YouTube$/, ''), channel: vd.author || '',
    seconds: +vd.lengthSeconds || 0, description: vd.shortDescription || '', keywords: vd.keywords || [],
    published: mf.publishDate || mf.uploadDate || '', views: +vd.viewCount || 0, category: mf.category || '',
    hasCaptions: !!((p.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks,
    chapters: [], status: (p.playabilityStatus || {}).status || '',
  };
  try {
    const find = (o, key, acc = [], depth = 0) => { if (!o || typeof o !== 'object' || depth > 40) return acc; if (o[key]) acc.push(o[key]); for (const k in o) find(o[k], key, acc, depth + 1); return acc; };
    for (const c of find(window.ytInitialData || {}, 'chapterRenderer')) out.chapters.push({ t: (c.timeRangeStartMillis || 0) / 1000, title: (c.title || {}).simpleText || '' });
  } catch {}
  if (!out.hasCaptions) return out;
  const mp = () => document.querySelector('#movie_player');
  for (let i = 0; i < 20 && !(mp() && mp().getOption); i++) await sleep(500);
  const pl = mp();
  if (!pl || !pl.getOption) return out;
  try { pl.mute(); pl.playVideo(); } catch {}
  await sleep(1500);
  // Wait out any ad before the video (skipping it when YouTube allows).
  for (let i = 0; i < 60 && pl.classList.contains('ad-showing'); i++) {
    document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click();
    await sleep(1000);
  }
  try {
    pl.loadModule('captions'); await sleep(800);
    const tl = pl.getOption('captions', 'tracklist') || [];
    const lang = (navigator.language || 'en').slice(0, 2);
    const pick = tl.find(t => t.languageCode.startsWith(lang) && t.kind !== 'asr') || tl.find(t => /^en/.test(t.languageCode) && t.kind !== 'asr')
      || tl.find(t => t.kind !== 'asr') || tl.find(t => t.languageCode.startsWith(lang)) || tl[0];
    if (pick) { pl.setOption('captions', 'track', {}); await sleep(300); pl.setOption('captions', 'track', pick); out.lang = pick.languageCode + (pick.kind === 'asr' ? ' (auto)' : ''); }
  } catch {}
  return out;
})()`;

// Turns YouTube's caption data into [{t, text}].
function parseCaptions(body) {
  const out = [];
  try {
    const j = JSON.parse(body);
    for (const e of j.events || []) {
      if (!e.segs) continue;
      const text = e.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (text) out.push({ t: (e.tStartMs || 0) / 1000, text });
    }
    return out;
  } catch {}
  // Older XML format.
  const dec = (x) => x.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  for (const m of body.matchAll(/<(?:text|p)[^>]*?(?:start="([\d.]+)"|t="(\d+)")[^>]*>([\s\S]*?)<\/(?:text|p)>/g)) {
    const text = dec(m[3]).replace(/\s+/g, ' ').trim();
    if (text) out.push({ t: m[1] ? +m[1] : +m[2] / 1000, text });
  }
  return out;
}

// Which caption requests each hidden YouTube window has made.
const captionUrls = new Map();
let captionWatch = false;
function watchCaptions() {
  if (captionWatch) return;
  captionWatch = true;
  ses().webRequest.onBeforeRequest({ urls: ['*://*.youtube.com/api/timedtext*'] }, (d, cb) => {
    if (captionUrls.has(d.webContentsId)) captionUrls.get(d.webContentsId).push(d.url);
    cb({});
  });
}

async function readYouTube(k, url, dir) {
  const watch = `https://www.youtube.com/watch?v=${k.id}`;
  watchCaptions();
  // A hidden (not off-screen) window, because the video has to really play for captions to load.
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const wid = win.webContents.id;
  captionUrls.set(wid, []);
  let v, transcript = [];
  try {
    await Promise.race([win.loadURL(watch, { userAgent: UA }).catch(() => {}), new Promise(r => setTimeout(r, 25000))]);
    for (let i = 0; i < 30; i++) {
      const ready = await win.webContents.executeJavaScript(`!!(window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails)`).catch(() => false);
      if (ready) break;
      await new Promise(r => setTimeout(r, 500));
    }
    v = await Promise.race([
      win.webContents.executeJavaScript(YT_SCRIPT),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 90000)),
    ]);
    if (v && v.hasCaptions) {
      for (let i = 0; i < 20 && !captionUrls.get(wid).length; i++) await new Promise(r => setTimeout(r, 400));
      // The newest request is the track Shelf switched on; try older ones if it comes back empty.
      for (const u of [...captionUrls.get(wid)].reverse()) {
        const body = await win.webContents.executeJavaScript(`fetch(${JSON.stringify(u)}).then(r => r.ok ? r.text() : '')`).catch(() => '');
        transcript = parseCaptions(body || '');
        if (transcript.length) break;
      }
    }
  } finally { captionUrls.delete(wid); win.destroy(); }
  if (!v || (!v.title && !v.description)) return null;

  // Chapters: from YouTube itself, or the timestamps listed in the description.
  let chapters = [...new Map((v.chapters || []).filter(c => c.title).map(c => [c.t + c.title, c])).values()].sort((a, b) => a.t - b.t);
  if (!chapters.length) {
    for (const line of v.description.split('\n')) {
      const m = line.match(/^\s*[-•▶]?\s*\(?((?:\d+:)?\d{1,2}:\d{2})\)?\s*[-–—:|]?\s*(.+)$/);
      if (m) chapters.push({ t: m[1].split(':').map(Number).reduce((a, b) => a * 60 + b, 0), title: m[2].trim() });
    }
    if (chapters.length < 2) chapters = [];
  }

  // Thumbnail as the card image.
  let shot = '';
  for (const q of ['maxresdefault', 'sddefault', 'hqdefault']) {
    try { const r = await get(`https://i.ytimg.com/vi/${k.id}/${q}.jpg`); if (r.ok && r.buf.length > 3000) { shot = save(dir, 'screenshot.jpg', r.buf); break; } } catch {}
  }

  // The transcript, grouped into readable paragraphs of about 30 seconds each.
  const paras = [];
  for (const s of transcript) {
    const last = paras[paras.length - 1];
    if (last && s.t - last.t < 30) last.text += ' ' + s.text; else paras.push({ t: s.t, text: s.text });
  }
  const linkTo = (t) => `https://www.youtube.com/watch?v=${k.id}&t=${Math.floor(t)}s`;
  const md = [
    `# ${v.title}`,
    '',
    `**Video** by ${v.channel || 'unknown'}${v.seconds ? ` · ${clock(v.seconds)}` : ''}${v.published ? ` · published ${v.published.slice(0, 10)}` : ''}${v.views ? ` · ${v.views.toLocaleString('en-US')} views` : ''}`,
    '',
    v.description && `## Description\n\n${v.description}`,
    chapters.length && `## Chapters\n\n${chapters.map(c => `- [${clock(c.t)}](${linkTo(c.t)}) ${c.title}`).join('\n')}`,
    paras.length ? `## Transcript${v.lang ? ` (${v.lang})` : ''}\n\n${paras.map(p => `[${clock(p.t)}](${linkTo(p.t)}) ${p.text}`).join('\n\n')}`
      : `## Transcript\n\n_${v.hasCaptions ? 'YouTube did not show the transcript this time. Re-read the link to try again.' : 'This video has no captions, so only its title, description and chapters were saved.'}_`,
    v.keywords.length && `\nKeywords: ${v.keywords.join(', ')}`,
  ].filter(Boolean).join('\n');
  if (paras.length) save(dir, 'transcript.txt', paras.map(p => `[${clock(p.t)}] ${p.text}`).join('\n'));

  return {
    title: v.title, description: v.description.split('\n').find(l => l.trim()) || '', url: watch,
    image: `https://i.ytimg.com/vi/${k.id}/hqdefault.jpg`, favicon: 'https://www.youtube.com/favicon.ico',
    markdown: md.slice(0, MAX_CONTENT), screenshot: shot,
    files: [paras.length && { name: 'transcript.txt', label: 'Transcript' }, shot && { name: shot, label: 'Thumbnail' }].filter(Boolean),
    source: paras.length ? 'YouTube video (with transcript)' : 'YouTube video',
    video: { id: k.id, channel: v.channel, seconds: v.seconds, chapters: chapters.length, transcript: paras.length > 0 },
    dead: !v.title && v.status && v.status !== 'OK',
  };
}

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await ses().fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, url: res.url || url, type, buf, disposition: res.headers.get('content-disposition') || '' };
  } finally { clearTimeout(t); }
}

const isSignInUrl = (u) => { try { const x = new URL(u); return /(^|\.)accounts\.google\.com$|^login\.|^signin\./.test(x.hostname) || /\/(signin|login|sign-in|log-in)(\/|$)|ServiceLogin/i.test(x.pathname); } catch { return false; } };
const looksLikeLogin = (r) => r.type.includes('text/html') && /accounts\.google\.com|ServiceLogin|signin/i.test(r.url + r.buf.slice(0, 4000).toString());

function save(dir, name, data) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), data); return name; }

async function pdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true }).promise;
  let title = '';
  try { title = (await doc.getMetadata()).info?.Title || ''; } catch {}
  const pages = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages && total < MAX_CONTENT; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let text = '', lastY;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const y = it.transform[5];
      if (lastY !== undefined && Math.abs(y - lastY) > 2) text += '\n';
      text += it.str;
      if (it.hasEOL) text += '\n';
      lastY = y;
    }
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    pages.push(`## Page ${i}\n\n${text}`);
    total += text.length;
  }
  return { title, pages: doc.numPages, markdown: pages.join('\n\n') };
}

function csvToTable(csv, maxRows = 300) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (q) { if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && csv[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter(r => r.some(x => x.trim()));
  if (!clean.length) return '_(empty)_';
  const width = Math.max(...clean.map(r => r.length));
  const fmt = r => '| ' + Array.from({ length: width }, (_, i) => String(r[i] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()).join(' | ') + ' |';
  const out = [fmt(clean[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...clean.slice(1, maxRows + 1).map(fmt)];
  if (clean.length - 1 > maxRows) out.push(`\n_…${clean.length - 1 - maxRows} more rows in the saved spreadsheet file._`);
  return out.join('\n');
}

// ---------- Google files ----------
async function readGoogle(k, url, dir, fetchFn = get, fromBrowser = false) {
  const base = 'https://docs.google.com';
  const files = [];
  if (k.kind === 'gdoc') {
    let r = await fetchFn(`${base}/document/d/${k.id}/export?format=md`);
    if (!r.ok || looksLikeLogin(r)) r = await fetchFn(`${base}/document/d/${k.id}/export?format=txt`);
    if (!r.ok || looksLikeLogin(r)) return { private: true };
    const markdown = r.buf.toString('utf8');
    try { const d = await fetchFn(`${base}/document/d/${k.id}/export?format=docx`); if (d.ok && !looksLikeLogin(d)) files.push({ name: save(dir, 'original.docx', d.buf), label: 'Word copy (.docx)' }); } catch {}
    try { const p = await fetchFn(`${base}/document/d/${k.id}/export?format=pdf`); if (p.ok && !looksLikeLogin(p)) files.push({ name: save(dir, 'original.pdf', p.buf), label: 'PDF copy' }); } catch {}
    // The HTML export keeps the Doc's formatting, colours, tables and pictures: Shelf builds its own page from it.
    let docHtml = '';
    try { const h = await fetchFn(`${base}/document/d/${k.id}/export?format=html`); if (h.ok && !looksLikeLogin(h) && /html/.test(h.type)) docHtml = h.buf.toString('utf8'); } catch {}
    const title = (markdown.match(/^#\s+(.+)$/m) || [])[1] || markdown.trim().split('\n')[0].slice(0, 120);
    return { title, markdown, files, docHtml, source: 'Google Doc' };
  }
  if (k.kind === 'gsheet') {
    const x = await fetchFn(`${base}/spreadsheets/d/${k.id}/export?format=xlsx`);
    if (!x.ok || looksLikeLogin(x)) return { private: true };
    files.push({ name: save(dir, 'original.xlsx', x.buf), label: 'Spreadsheet copy (.xlsx)' });
    // Find every tab so the text copy covers the whole spreadsheet, not just the first sheet.
    let sheets = [];
    let title = '';
    try {
      const h = (await fetchFn(`${base}/spreadsheets/d/${k.id}/htmlview`)).buf.toString('utf8');
      title = ((h.match(/<title>([^<]*)<\/title>/) || [])[1] || '').replace(/ - Google (Drive|Sheets)$/, '');
      for (const m of h.matchAll(/name:\s*"((?:[^"\\]|\\.)*)"[^}]*?gid:\s*"(\d+)"/g)) sheets.push({ name: JSON.parse(`"${m[1]}"`), gid: m[2] });
    } catch {}
    if (!sheets.length) sheets = [{ name: 'Sheet', gid: k.gid || '0' }];
    const parts = [];
    for (const s of sheets.slice(0, 20)) {
      try {
        const c = await fetchFn(`${base}/spreadsheets/d/${k.id}/export?format=csv&gid=${s.gid}`);
        if (c.ok && !looksLikeLogin(c)) parts.push(`## ${s.name}\n\n${csvToTable(c.buf.toString('utf8'))}`);
      } catch {}
    }
    // Also keep a snapshot of the sheet exactly as it looks.
    if (!fromBrowser) { try { await render(`${base}/spreadsheets/d/${k.id}/htmlview`, dir, { wait: 2500 }); } catch {} }
    return { title, markdown: parts.join('\n\n'), files, source: 'Google Sheet' };
  }
  if (k.kind === 'gslides') {
    const t = await fetchFn(`${base}/presentation/d/${k.id}/export/txt`);
    if (!t.ok || looksLikeLogin(t)) return { private: true };
    try { const p = await fetchFn(`${base}/presentation/d/${k.id}/export/pdf`); if (p.ok && !looksLikeLogin(p)) files.push({ name: save(dir, 'original.pdf', p.buf), label: 'Slides as PDF' }); } catch {}
    const markdown = t.buf.toString('utf8');
    return { title: markdown.trim().split('\n')[0].slice(0, 120), markdown, files, source: 'Google Slides' };
  }
  if (k.kind === 'gdrive') {
    const r = await fetchFn(`https://drive.google.com/uc?export=download&id=${k.id}`);
    if (!r.ok || looksLikeLogin(r)) return { private: true };
    if (r.type.includes('pdf')) return readPdf(r, dir, 'Google Drive PDF');
    const name = (r.disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1] || 'original.bin';
    if (r.type.includes('text/html')) return null; // a Drive preview page; fall back to rendering it
    files.push({ name: save(dir, 'original' + (path.extname(decodeURIComponent(name)) || '.bin'), r.buf), label: `Original file (${decodeURIComponent(name)})` });
    const markdown = /text|json|csv|markdown/.test(r.type) ? r.buf.toString('utf8').slice(0, MAX_CONTENT) : await docxText(name, r.buf);
    return { title: decodeURIComponent(name), markdown, files, source: 'Google Drive file' };
  }
  return null;
}

// Text of a Word file, so it can be read, searched and summarised like any other copy.
async function docxText(name, buf) {
  if (!/\.docx$/i.test(decodeURIComponent(String(name || '')))) return '';
  try { return (await require('mammoth').extractRawText({ buffer: buf })).value.slice(0, MAX_CONTENT); } catch { return ''; }
}

async function readPdf(r, dir, source = 'PDF') {
  const files = [{ name: save(dir, 'original.pdf', r.buf), label: 'Original PDF' }];
  const p = await pdfText(r.buf);
  const fallback = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'Document');
  const title = p.title || p.markdown.replace(/^## Page 1\s*/, '').split('\n').find(l => l.trim().length > 3)?.slice(0, 140) || fallback;
  return { title, markdown: p.markdown, files, source: `${source}, ${p.pages} page${p.pages === 1 ? '' : 's'}` };
}

// ---------- Rendered pages ----------
// Runs inside the page: turns the visible content into Markdown and collects metadata.
const EXTRACT = String.raw`(() => {
  const meta = (keys) => { for (const k of keys) { const el = document.querySelector('meta[property="' + k + '"], meta[name="' + k + '"]'); if (el && el.content && el.content.trim()) return el.content.trim(); } return ''; };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const icon = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
  const pick = ['.notion-page-content', 'article', 'main', '[role="main"]', '#content', '.content'];
  let root = null;
  for (const s of pick) { const el = document.querySelector(s); if (el && el.innerText && el.innerText.trim().length > 200) { root = el; break; } }
  const isNotion = !!document.querySelector('.notion-page-content');
  if (!root) root = document.body;
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','CANVAS','BUTTON','INPUT','SELECT','TEXTAREA','FORM','TEMPLATE']);
  const SKIP_BODY = new Set(['NAV','FOOTER','ASIDE']);
  const junk = /cookie|consent|gdpr|newsletter-popup|modal|banner-ad|advert/i;
  const hidden = (el) => { const cs = getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true'; };
  const inline = (node) => {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { s += n.textContent.replace(/\s+/g, ' '); continue; }
      if (n.nodeType !== 1 || SKIP.has(n.tagName) || hidden(n)) continue;
      const t = n.tagName;
      if (t === 'BR') s += '\n';
      else if (t === 'A') { const txt = inline(n).trim(); const href = abs(n.getAttribute('href') || ''); s += (txt && href.startsWith('http')) ? '[' + txt + '](' + href + ')' : txt; }
      else if (t === 'STRONG' || t === 'B') { const x = inline(n).trim(); s += x ? '**' + x + '** ' : ''; }
      else if (t === 'EM' || t === 'I') { const x = inline(n).trim(); s += x ? '*' + x + '* ' : ''; }
      else if (t === 'CODE') s += '\x60' + n.textContent + '\x60';
      else if (t === 'IMG') { const alt = (n.alt || '').trim(); if (alt && n.naturalWidth > 80) s += ' [image: ' + alt + '] '; }
      else s += inline(n);
    }
    return s;
  };
  const out = [];
  const push = (s) => { s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim(); if (s) out.push(s); };
  const table = (t) => {
    const rows = [...t.querySelectorAll('tr')].map(tr => [...tr.children].map(c => c.innerText.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()));
    if (!rows.length) return;
    const w = Math.max(...rows.map(r => r.length));
    const f = (r) => '| ' + Array.from({ length: w }, (_, i) => r[i] || '').join(' | ') + ' |';
    push([f(rows[0]), '| ' + Array(w).fill('---').join(' | ') + ' |', ...rows.slice(1, 400).map(f)].join('\n'));
  };
  const walk = (el, depth) => {
    for (const n of el.children) {
      const t = n.tagName;
      if (SKIP.has(t) || hidden(n)) continue;
      if (root === document.body && SKIP_BODY.has(t)) continue;
      if (junk.test((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : ''))) continue;
      const cls = typeof n.className === 'string' ? n.className : '';
      if (/^H[1-6]$/.test(t)) { push('#'.repeat(+t[1]) + ' ' + n.innerText.replace(/\s+/g, ' ')); continue; }
      if (isNotion && /notion-(header|sub_header|sub_sub_header)-block/.test(cls)) { const lvl = cls.includes('sub_sub') ? 4 : cls.includes('sub_header') ? 3 : 2; push('#'.repeat(lvl) + ' ' + n.innerText.replace(/\s+/g, ' ')); continue; }
      if (isNotion && /notion-(bulleted_list|numbered_list|to_do|toggle)-block/.test(cls)) { push('  '.repeat(depth) + '- ' + inline(n).trim().split('\n')[0]); const kids = n.querySelector('[class*="notion-"][class*="-block"]'); if (kids && n.innerText.includes('\n')) walk(n, depth + 1); continue; }
      if (t === 'P') { push(inline(n)); continue; }
      if (t === 'UL' || t === 'OL') { let i = 1; for (const li of n.children) { if (li.tagName !== 'LI' || hidden(li)) continue; const lead = t === 'OL' ? (i++) + '. ' : '- '; const nested = li.querySelector('ul,ol'); let txt = inline(li).trim(); push('  '.repeat(depth) + lead + txt.split('\n')[0]); if (nested) walk(li, depth + 1); } continue; }
      if (t === 'PRE') { push('\x60\x60\x60\n' + n.innerText + '\n\x60\x60\x60'); continue; }
      if (t === 'BLOCKQUOTE') { push(inline(n).trim().split('\n').map(l => '> ' + l).join('\n')); continue; }
      if (t === 'TABLE') { table(n); continue; }
      if (t === 'IMG') { const alt = (n.alt || '').trim(); if (alt && n.naturalWidth > 120) push('[image: ' + alt + ']'); continue; }
      // A block with only text/inline content becomes a paragraph; otherwise go deeper.
      const hasBlock = [...n.children].some(c => /^(DIV|P|UL|OL|H[1-6]|TABLE|PRE|BLOCKQUOTE|SECTION|ARTICLE|HEADER|LI|FIGURE|MAIN)$/.test(c.tagName));
      if (!hasBlock) { const txt = inline(n).trim(); if (txt) push(txt); }
      else walk(n, depth);
    }
  };
  walk(root, 0);
  // Drop repeated lines (menus, footers repeated across sections).
  const seen = new Set();
  const md = out.filter(l => { const k = l.toLowerCase(); if (l.length < 120 && seen.has(k)) return false; seen.add(k); return true; }).join('\n\n');
  const text = (document.body.innerText || '');
  return {
    title: meta(['og:title', 'twitter:title']) || document.title || '',
    description: meta(['og:description', 'description', 'twitter:description']),
    image: abs(meta(['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'])),
    favicon: icon ? abs(icon.getAttribute('href')) : '',
    markdown: md,
    loginWall: text.length < 1500 && /log ?in|sign ?in|request access|you need access|continue with google/i.test(text),
    url: location.href,
  };
})()`;

async function render(url, dir, { wait = 1500, notionCapture = false } = {}) {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860,
    webPreferences: { partition: PARTITION, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    // Some sites (Notion, Google) never "finish" loading, so don't wait for that. Start the load,
    // then wait until real content shows up and stops changing.
    let loadError = null;
    const loaded = win.loadURL(url, { userAgent: UA }).catch(e => { loadError = e; });
    await Promise.race([loaded, new Promise(r => setTimeout(r, 25000))]);
    const probe = `(() => { const n = document.querySelector('.notion-page-content') || document.body; return n ? n.innerText.length : 0; })()`;
    // Scroll the window and any inner scrolling panels (Notion, Google) so lazy content loads.
    const scroll = `(async () => {
      const panes = [document.scrollingElement, ...[...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY))].filter(Boolean);
      for (let i = 0; i < 14; i++) { panes.forEach(p => p.scrollTop += p.clientHeight * 0.9); await new Promise(r => setTimeout(r, 300)); }
      panes.forEach(p => p.scrollTop = 0);
    })()`;
    await new Promise(r => setTimeout(r, wait));
    let last = -1, stable = 0;
    const until = Date.now() + 25000;
    while (Date.now() < until) {
      await win.webContents.executeJavaScript(scroll).catch(() => {});
      const len = await win.webContents.executeJavaScript(probe).catch(() => 0);
      if (len > 0 && Math.abs(len - last) < 20) { if (++stable >= 2) break; } else stable = 0;
      last = len;
      await new Promise(r => setTimeout(r, 900));
    }
    if (last <= 0 && loadError && !/ERR_ABORTED/.test(loadError.message)) throw new Error('Could not open the page');
    await new Promise(r => setTimeout(r, 500));
    const data = await win.webContents.executeJavaScript(EXTRACT);
    let screenshot = '';
    try {
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 800 });
      if (!img.isEmpty()) screenshot = save(dir, 'screenshot.jpg', img.resize({ width: 1000 }).toJPEG(78));
    } catch {}
    // The exact copy: a complete snapshot of the page as it looks now (layout, styles, images, text) in one file.
    let snapshot = '';
    try {
      await win.webContents.savePage(path.join(dir, 'page.mhtml'), 'MHTML');
      if (fs.statSync(path.join(dir, 'page.mhtml')).size > 500) snapshot = 'page.mhtml';
    } catch {}
    // Notion: also take the page's real structure, for Shelf's own Notion-style copy.
    let structure = null;
    if (notionCapture) {
      const id = notion.pageIdFrom(win.webContents.getURL()) || notion.pageIdFrom(url);
      if (id) {
        try {
          structure = await Promise.race([
            win.webContents.executeJavaScript(notion.captureScript(id)),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 180000)),
          ]);
        } catch { structure = null; }
      }
    }
    return { ...data, screenshot, snapshot, structure };
  } finally { win.destroy(); }
}

// Main entry: returns everything Shelf knows about the link, and writes the saved copy into `dir`.
// Files the Chrome extension downloaded with the browser's Google sign-in: { requested url: response }.
function fetchedGetter(fetched) {
  return async (u) => {
    const r = fetched[u];
    if (!r) return { ok: false, status: 404, url: u, type: '', buf: Buffer.alloc(0), disposition: '' };
    return { ok: !!r.ok, status: r.status || 0, url: r.url || u, type: String(r.type || '').toLowerCase(), buf: Buffer.from(r.data || '', 'base64'), disposition: r.disposition || '' };
  };
}

// The page as the user saw it in their browser (sent by the extension): used when Shelf can't open
// the page itself, e.g. a private page or one behind a sign-in.
function fromBrowserPage(url, dir, page) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  if (page.mhtml) files.push({ name: save(dir, 'page.mhtml', Buffer.from(page.mhtml, 'base64')), label: 'Exact copy of the page (from your browser)' });
  if (page.screenshot) files.push({ name: save(dir, 'screenshot.jpg', Buffer.from(page.screenshot, 'base64')), label: 'Screenshot' });
  const markdown = String(page.text || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_CONTENT);
  return { title: String(page.title || '').trim(), description: page.description || '', image: page.image || '', url, markdown, files, screenshot: page.screenshot ? 'screenshot.jpg' : '', source: 'Private page · via your browser', viaBrowser: true };
}

async function read(url, dir, opts = {}) {
  let result = null, err = null;
  try { result = await readOwn(url, dir, opts); } catch (e) { err = e; }
  const failed = !result || result.private || result.dead || (result.loginWall && (result.markdown || '').length < 400);
  if (opts.page && failed && (opts.page.mhtml || opts.page.text)) {
    result = { ...fromBrowserPage(url, dir, opts.page), kind: kindOf(url).kind };
    if (result.markdown) save(dir, 'content.md', result.markdown);
    return result;
  }
  if (err) throw err;
  return result;
}

// A private Drive file read from this computer through Google Drive for desktop.
async function readDriveLocal(id, url, dir) {
  const f = drive.localFile(id);
  if (!f || f.google || f.size > 300 * 1024 * 1024) return null;   // Google Docs live online; huge files are skipped
  const buf = await fs.promises.readFile(f.path);                   // Drive for desktop downloads it if needed
  const r = { ok: true, status: 200, url, type: f.mime || '', buf, disposition: '' };
  if (/pdf/.test(f.mime) || buf.slice(0, 5).toString() === '%PDF-') { const out = await readPdf(r, dir, 'Google Drive PDF'); out.title = out.title || f.name; out.source += ' · via Drive for desktop'; return out; }
  const ext = path.extname(f.name) || '';
  const markdown = /^text\/|json|csv|markdown/.test(f.mime) ? buf.toString('utf8').slice(0, MAX_CONTENT) : await docxText(f.name, buf);
  return { title: f.name, markdown, files: [{ name: save(dir, 'original' + ext, buf), label: `Original file (${f.name})` }], source: 'Google Drive file · via Drive for desktop' };
}

// A file attached from this computer (no link): Shelf keeps its own copy and reads it like a linked one.
async function readLocalFile(src, name, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = await fs.promises.readFile(src);
  const ext = path.extname(name).toLowerCase();
  let out;
  if (ext === '.pdf' || buf.slice(0, 5).toString() === '%PDF-') {
    out = await readPdf({ buf, url: 'file:///' + encodeURIComponent(name) }, dir, 'PDF file');
  } else if (ext === '.docx') {
    out = { title: path.basename(name, ext), markdown: await docxText(name, buf), files: [{ name: save(dir, 'original.docx', buf), label: `Original file (${name})` }], source: 'Word file' };
  } else {
    out = { title: path.basename(name, ext), markdown: buf.toString('utf8').slice(0, MAX_CONTENT), files: [{ name: save(dir, 'original' + (ext || '.txt'), buf), label: `Original file (${name})` }], source: 'Text file' };
  }
  out.kind = 'file';
  if (out.markdown) save(dir, 'content.md', out.markdown);
  return out;
}

async function readOwn(url, dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const k = kindOf(url);
  let result = null;

  // A Drive page (Recent, Starred, a folder, …) is a list, not a file. Drive keeps this address while a file is
  // open in its preview, so tell the person how to get the file's own link instead of calling it private.
  const view = drive.driveTarget(url);
  if (view && view.view !== 'file') {
    const name = { recent: 'Recent', starred: 'Starred', shared: 'Shared with me', 'my-drive': 'My Drive', folder: 'a folder', computers: 'Computers', quota: 'Storage' }[view.view] || 'Drive';
    return { driveView: true, title: `Google Drive – ${name}`, url, markdown: '', files: [], source: 'Google Drive page', kind: 'gdrive-view' };
  }

  if (k.kind.startsWith('g')) {
    if (opts.fetched) {
      try { result = await readGoogle(k, url, dir, fetchedGetter(opts.fetched), true); } catch (e) { result = null; }
      if (result && !result.private) { result.viaBrowser = true; result.source = (result.source || 'Google file') + ' · via your browser'; }
      else result = null;   // the browser couldn't open it either: try the normal way below
    }
    if (!result) { try { result = await readGoogle(k, url, dir); } catch (e) { result = null; } }
    // A Drive file Shelf can't open online (private): read it from Drive for desktop on this computer.
    if (k.kind === 'gdrive' && (!result || result.private)) {
      try { const l = await readDriveLocal(k.id, url, dir); if (l) result = l; } catch (e) { console.error('Drive file', e.message); }
    }
    if (result && result.private) {
      return { private: true, kind: k.kind, url, markdown: '', files: [], source: 'Private Google file' };
    }
  }

  if (k.kind === 'youtube') {
    try { result = await readYouTube(k, url, dir); } catch { result = null; }
  }

  if (!result && k.kind === 'web') {
    // Check what the link points to first; PDFs and other files are downloaded instead of rendered.
    try {
      const head = await get(url);
      if (head.type.includes('pdf') || head.buf.slice(0, 5).toString() === '%PDF-') result = await readPdf(head, dir);
      else if (head.type && !/html|xml|text\/plain/.test(head.type) && head.ok) {
        const ext = path.extname(new URL(head.url).pathname) || '';
        result = { title: decodeURIComponent(new URL(head.url).pathname.split('/').pop() || url), markdown: await docxText(ext, head.buf), files: [{ name: save(dir, 'original' + ext, head.buf), label: 'Original file' }], source: head.type.split(';')[0] };
      } else if (head.type.includes('text/plain')) {
        result = { title: new URL(head.url).pathname.split('/').pop() || url, markdown: head.buf.toString('utf8').slice(0, MAX_CONTENT), files: [{ name: save(dir, 'original.txt', head.buf), label: 'Original text file' }], source: 'Text file' };
      }
    } catch { /* fall through to rendering */ }
  }

  if (!result) {
    const r = await render(url, dir, { wait: k.kind === 'notion' ? 4500 : 1800, notionCapture: k.kind === 'notion' });
    let md = (r.markdown || '').slice(0, MAX_CONTENT);
    let page = '';
    if (r.structure && Object.keys(r.structure.block || {}).length > 1) {
      try {
        const pdir = path.join(dir, 'notion');
        fs.mkdirSync(pdir, { recursive: true });
        const images = await notion.downloadImages(r.structure, pdir, (u) => get(u));
        fs.writeFileSync(path.join(pdir, 'page.json'), JSON.stringify(r.structure));
        if (notion.build(r.structure, images, pdir)) page = 'notion/index.html';
        const full = notion.allText(r.structure);
        if (md.length < full.length * 0.6) md = full;   // the rendered page came out short; Notion's own data is complete
        const extra = notion.extraText(r.structure);
        if (extra.trim()) md = (md + '\n\n---\n' + extra).slice(0, MAX_CONTENT);
      } catch (e) { page = ''; }
    }
    // Sent to a sign-in screen: the page is private. Keep the link as given; never save the sign-in screen.
    if (isSignInUrl(r.url) && !isSignInUrl(url)) {
      for (const f of [r.snapshot, r.screenshot]) if (f) fs.rmSync(path.join(dir, f), { force: true });
      return { private: true, kind: k.kind, url, markdown: '', files: [], source: k.kind.startsWith('g') ? 'Private Google file' : 'Private page' };
    }
    result = {
      title: (r.structure && notion.pageTitle(r.structure)) || r.title, description: r.description, image: r.image, favicon: r.favicon, url: r.url,
      markdown: md, files: [page && { name: page, label: 'Shelf Page' }, r.snapshot && { name: r.snapshot, label: 'Exact copy of the page' }, r.screenshot && { name: r.screenshot, label: 'Screenshot' }].filter(Boolean), screenshot: r.screenshot, page,
      pages: r.structure ? r.structure.pages : 0,
      source: k.kind === 'notion' ? 'Notion page' : k.kind === 'youtube' ? 'YouTube video' : k.kind.startsWith('g') ? 'Google page' : 'Web page',
      private: r.loginWall && md.length < 400, loginWall: !!r.loginWall,
      dead: md.length < 600 && /(page|file|document) (couldn.t|could not|cannot|can.t) be found|page not found|404|no longer (exists|available)|has been (deleted|removed)/i.test(md + ' ' + r.title),
    };
  }

  result.url = result.url || url;
  result.kind = k.kind;
  if (result.markdown) save(dir, 'content.md', result.markdown);
  return result;
}

// Opens a normal window that shares the reader's cookies, so you can sign in to Notion/Google once
// and Shelf can then read your private pages.
function openSignIn(url) {
  const w = new BrowserWindow({ width: 1100, height: 800, title: 'Sign in for Shelf', webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true } });
  w.loadURL(url, { userAgent: UA });
  return w;
}

// Opens Shelf's saved copy in its own window with the internet blocked, so what you see is
// always the saved copy, never the live page.
const VIEWER = 'shelf-viewer';
let viewerReady = false;
function openCopy(file, title) {
  const s = session.fromPartition(VIEWER);
  if (!viewerReady) {
    s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?):/i.test(d.url) }));
    viewerReady = true;
  }
  const isPdf = /\.pdf$/i.test(file);
  const w = new BrowserWindow({
    width: 1200, height: 860, title: `${title || 'Saved copy'} (saved copy)`,
    webPreferences: { partition: VIEWER, sandbox: true, contextIsolation: true, javascript: isPdf, plugins: isPdf },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const folder = path.dirname(file);
  w.webContents.on('will-navigate', (e, target) => {
    if (target.startsWith('file://')) {
      try { const p = decodeURIComponent(new URL(target).pathname); if (path.dirname(p) === folder && p.endsWith('.html')) return; } catch {}
    }
    e.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });
  if (!/\.html$/i.test(file)) w.on('page-title-updated', (e) => e.preventDefault());
  w.loadFile(file);
  return w;
}

const isNotion = (u) => { try { return kindOf(u).kind === 'notion'; } catch { return false; } };

module.exports = { read, readLocalFile, get, openSignIn, openCopy, kindOf, csvToTable, youtubeId, isNotion };
