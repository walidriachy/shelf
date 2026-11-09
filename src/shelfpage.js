// Builds Shelf's own editable copy (a "Shelf Page") from a Google Doc, a Word file or a PDF,
// in the same format as Notion Shelf Pages: <archive>/notion/index.html + img/ + shelf-page.css.
// Everything is converted in a hidden window with the internet blocked; images are saved locally.
const { BrowserWindow, session } = require('electron');
const { pathToFileURL } = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PART = 'shelf-convert';
const MAX_PDF_PAGES = 80;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function convSession() {
  const s = session.fromPartition(PART);
  if (!s.__shelf) { s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: /^(https?|wss?|ftp):/i.test(d.url) })); s.__shelf = true; }
  return s;
}

// Loads `html` in a hidden window (scripts in it removed, internet blocked) and runs `script` there.
async function inWindow(html, script, timeout = 120000) {
  convSession();
  const tmp = path.join(os.tmpdir(), `shelf-convert-${process.pid}-${crypto.randomBytes(4).toString('hex')}.html`);
  fs.writeFileSync(tmp, html);
  const w = new BrowserWindow({ show: false, width: 1000, height: 1200, webPreferences: { partition: PART, sandbox: true, contextIsolation: true, javascript: true } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await w.loadFile(tmp);
    let timer;
    return await Promise.race([
      w.webContents.executeJavaScript(script),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Took too long')), timeout); }),
    ]).finally(() => clearTimeout(timer));
  } finally {
    if (!w.isDestroyed()) w.destroy();
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- HTML (Google Docs export, Word via mammoth) → Shelf blocks ----------
// Runs inside the conversion window. Reads the real computed styles, so Google's class-based
// formatting (bold, colours, highlights, alignment) comes across.
const WALK = function () {
  const imgs = [];
  const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/ /g, ' ');
  const rgb = (c) => { const m = String(c).match(/[\d.]+/g); return m ? m.map(Number) : null; };
  const lum = (c) => { const m = rgb(c); if (!m || (m.length === 4 && m[3] === 0)) return null; return 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]; };
  const realColor = (c) => { const l = lum(c); return l !== null && l > 70 && !(rgb(c)[0] === rgb(c)[1] && rgb(c)[1] === rgb(c)[2] && l < 120); };
  const realBg = (c) => { const l = lum(c); return l !== null && l < 245; };
  const safe = (u) => { u = String(u || '').trim(); if (u.startsWith('#')) return esc(u); try { const x = new URL(u); if (x.hostname === 'www.google.com' && x.pathname === '/url' && x.searchParams.get('q')) u = x.searchParams.get('q'); } catch {} return /^(https?:|mailto:)/i.test(u) ? esc(u) : '#'; };
  const flags = (el) => {
    const s = getComputedStyle(el);
    return {
      b: parseInt(s.fontWeight, 10) >= 600, i: s.fontStyle === 'italic',
      u: /underline/.test(s.textDecorationLine), s: /line-through/.test(s.textDecorationLine),
      code: /mono|courier|consolas|menlo/i.test(s.fontFamily),
      color: realColor(s.color) ? s.color : '', bg: realBg(s.backgroundColor) ? s.backgroundColor : '',
      sup: s.verticalAlign === 'super', sub: s.verticalAlign === 'sub',
    };
  };
  const imgTag = (el) => {
    const src = el.getAttribute('src') || '';
    if (!src) return '';
    let i = imgs.indexOf(src); if (i < 0) { imgs.push(src); i = imgs.length - 1; }
    const w = parseInt(el.getAttribute('width') || el.style.width || '0', 10);
    return `<figure class="image"${w && w < 680 ? ` style="max-width:${w}px"` : ''}><img src="@@IMG${i}@@" alt=""></figure>`;
  };
  const LIST = /^(UL|OL)$/;

  // Inline content of a block. Pictures inside it are collected in `figs` and placed after the block.
  function inline(el, figs, base) {
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { out += esc(n.nodeValue.replace(/[\uE000-\uF8FF]/g, '')); continue; }
      if (n.nodeType !== 1) continue;
      const t = n.tagName;
      if (LIST.test(t) || t === 'TABLE' || t === 'SCRIPT' || t === 'STYLE') continue;
      if (t === 'BR') { out += '<br>'; continue; }
      if (t === 'IMG') { figs.push(imgTag(n)); continue; }
      let h = inline(n, figs, flags(n));
      if (!h) continue;
      if (t === 'A' && n.getAttribute('href')) { out += `<a class="link" href="${safe(n.getAttribute('href'))}">${h}</a>`; continue; }
      const f = flags(n), p = base;
      if (f.code && !p.code) h = `<code>${h}</code>`;
      if (f.b && !p.b) h = `<b>${h}</b>`;
      if (f.i && !p.i) h = `<i>${h}</i>`;
      if (f.u && !p.u && !n.closest('a')) h = `<u>${h}</u>`;
      if (f.s && !p.s) h = `<s>${h}</s>`;
      if ((f.sup || t === 'SUP') && !p.sup) h = `<sup>${h}</sup>`;
      if ((f.sub || t === 'SUB') && !p.sub) h = `<sub>${h}</sub>`;
      const st = [f.color && f.color !== p.color ? `color:${f.color}` : '', f.bg && f.bg !== p.bg ? `background:${f.bg}` : ''].filter(Boolean).join(';');
      if (st) h = `<span style="${st}">${h}</span>`;
      out += h;
    }
    return out;
  }
  const blockFlags = (el) => { const f = flags(el); return { ...f, color: '', bg: '' }; };
  const empty = (h) => !h.replace(/<br>|\s|&nbsp;/g, '').length;

  // Lists: Google writes nested lists as flat siblings (class lst-kix_…-N = level N); Word/mammoth nests them.
  function listItems(el, level, items) {
    const m = (el.className || '').match(/lst-kix_[\w]+-(\d+)/);
    const lv = m ? +m[1] : level;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const figs = [];
      items.push({ level: lv, tag: el.tagName.toLowerCase(), html: inline(li, figs, blockFlags(li)) + figs.join('') });
      for (const sub of li.children) if (LIST.test(sub.tagName)) listItems(sub, lv + 1, items);
    }
  }
  function listHtml(items) {
    let out = '';
    const stack = [];
    for (const it of items) {
      while (stack.length && stack[stack.length - 1].level > it.level) out += `</li></${stack.pop().tag}>`;
      const top = stack[stack.length - 1];
      if (!top || top.level < it.level) { out += `<${it.tag}>`; stack.push({ tag: it.tag, level: it.level }); }
      else { out += '</li>'; if (top.tag !== it.tag) { out += `</${top.tag}><${it.tag}>`; top.tag = it.tag; } }
      out += `<li>${it.html || '&nbsp;'}`;
    }
    while (stack.length) out += `</li></${stack.pop().tag}>`;
    return out;
  }

  function table(el) {
    const rows = [...el.querySelectorAll('tr')].filter(tr => tr.closest('table') === el);
    return `<div class="tablewrap"><table class="simple">${rows.map(tr => `<tr>${[...tr.children].map(td => {
      const tag = td.tagName === 'TH' ? 'th' : 'td';
      const parts = [];
      for (const c of td.children.length ? td.children : [td]) {
        const figs = [];
        if (LIST.test(c.tagName)) { const items = []; listItems(c, 0, items); parts.push(items.map(i => '• ' + i.html).join('<br>')); continue; }
        const h = inline(c, figs, blockFlags(c)) + figs.join('');
        if (!empty(h)) parts.push(h);
      }
      const span = (td.colSpan > 1 ? ` colspan="${td.colSpan}"` : '') + (td.rowSpan > 1 ? ` rowspan="${td.rowSpan}"` : '');
      return `<${tag}${span}>${parts.join('<br>')}</${tag}>`;
    }).join('')}</tr>`).join('')}</table></div>`;
  }

  let title = '';
  const out = [];
  function blocks(container) {
    const kids = [...container.children];
    for (let k = 0; k < kids.length; k++) {
      const el = kids[k], t = el.tagName;
      if (t === 'STYLE' || t === 'SCRIPT' || t === 'META' || t === 'TITLE') continue;
      // Comments exported with the Doc are left out: they're notes between collaborators, not the document.
      if (el.querySelector && el.querySelector('a[id^="cmnt"], a[href^="#cmnt_ref"]') && t === 'DIV') continue;
      if (LIST.test(t)) {
        const items = [];
        while (k < kids.length && LIST.test(kids[k].tagName)) { listItems(kids[k], 0, items); k++; }
        k--;
        out.push(listHtml(items));
        continue;
      }
      // Google Docs code blocks: paragraphs between the private marks U+EC03 (start) and U+EC02 (end).
      if (/\uEC03/.test(el.textContent)) {
        const lines = [];
        for (; k < kids.length; k++) {
          const tx = kids[k].textContent.replace(/\u00a0/g, ' ');
          const end = /\uEC02/.test(tx);
          const clean = tx.replace(/[\uE000-\uF8FF]/g, '');
          if (clean.trim() || !end) lines.push(clean);
          if (end) break;
        }
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        if (lines.length) out.push(`<div class="code"><pre><code>${esc(lines.join('\n'))}</code></pre></div>`);
        continue;
      }
      if (t === 'TABLE') { out.push(table(el)); continue; }
      if (t === 'HR') { out.push('<hr>'); continue; }
      if (t === 'IMG') { out.push(imgTag(el)); continue; }
      if (t === 'DIV' || t === 'SECTION' || t === 'ARTICLE' || t === 'MAIN' || t === 'BODY') { blocks(el); continue; }
      const figs = [];
      const h = inline(el, figs, blockFlags(el)).trim();
      if (!title && el.classList.contains('title') && !empty(h)) { title = el.textContent.trim(); out.push(...figs); continue; }
      const align = getComputedStyle(el).textAlign;
      const st = align === 'center' || align === 'right' ? ` style="text-align:${align}"` : '';
      const hm = t.match(/^H([1-6])$/);
      if (hm && !empty(h)) {
        const lv = Math.min(+hm[1], 3);
        const id = el.id || (el.querySelector('a[id]') || {}).id || '';
        out.push(`<h${lv} class="h"${id ? ` id="${esc(id)}"` : ''}${st}>${h}</h${lv}>`);
      } else if (t === 'BLOCKQUOTE' && !empty(h)) out.push(`<blockquote>${h}</blockquote>`);
      else if (t === 'PRE' && !empty(h)) out.push(`<div class="code"><pre><code>${esc(el.textContent)}</code></pre></div>`);
      else if (!empty(h)) out.push(`<div class="text${el.classList.contains('subtitle') ? ' c-gray' : ''}"${st}>${h}</div>`);
      out.push(...figs);
    }
  }
  blocks(document.body);
  return { title: title || document.title || '', body: out.join('\n'), imgs };
};

// Saves the pictures a converted page uses and swaps in their local addresses.
async function saveImages(body, imgs, pdir, fetcher) {
  const idir = path.join(pdir, 'img');
  fs.mkdirSync(idir, { recursive: true });
  const local = [];
  for (const src of imgs) {
    let buf = null, type = '';
    try {
      if (src.startsWith('data:')) { const m = src.match(/^data:([^;,]+)?(;base64)?,(.*)$/s); if (m) { type = m[1] || ''; buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])); } }
      else if (/^https?:/i.test(src) && fetcher) { const r = await fetcher(src); if (r.ok) { buf = r.buf; type = r.type || ''; } }
    } catch {}
    if (!buf || !buf.length) { local.push(''); continue; }
    const ext = /png/.test(type) ? '.png' : /gif/.test(type) ? '.gif' : /webp/.test(type) ? '.webp' : /svg/.test(type) ? '.svg' : '.jpg';
    const name = crypto.createHash('md5').update(src).digest('hex').slice(0, 16) + ext;
    fs.writeFileSync(path.join(idir, name), buf);
    local.push('img/' + name);
  }
  return body.replace(/<figure class="image"([^>]*)><img src="@@IMG(\d+)@@" alt=""><\/figure>/g, (m, attrs, i) =>
    local[+i] ? `<figure class="image"${attrs}><img src="${local[+i]}" alt=""></figure>` : '');
}

// The document's own first heading makes the best page title; it's moved up instead of shown twice.
function promoteTitle(title, body) {
  const m = body.match(/^\s*<h([123]) class="h"[^>]*>([\s\S]*?)<\/h\1>\s*/);
  if (!m) return { title, body };
  const text = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
  const norm = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  // A leading top-level heading is the document's own title; smaller ones only when they match.
  if (text && (m[1] === '1' || !title || norm(title) === norm(text))) return { title: text, body: body.slice(m[0].length) };
  return { title, body };
}

function writePage(pdir, { title, body, label }) {
  ({ title, body } = promoteTitle(title, body));
  fs.mkdirSync(pdir, { recursive: true });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title || 'Untitled')}</title><link rel="stylesheet" href="shelf-page.css"></head>
<body class="">
<nav class="crumbs"></nav>
<main class="page">
<h1 class="title">${esc(title || 'Untitled')}</h1>
<div class="content">${body}</div>
</main>
<footer class="shelf-foot">Saved by Shelf · a copy of ${esc(label)}</footer>
</body></html>`;
  fs.writeFileSync(path.join(pdir, 'index.html'), html);
  fs.copyFileSync(path.join(__dirname, 'shelf-page.css'), path.join(pdir, 'shelf-page.css'));
  fs.writeFileSync(path.join(pdir, '.built'), '99');   // not a Notion capture: nothing for refresh() to rebuild
  fs.writeFileSync(path.join(pdir, '.source'), label);
  return 1;
}

async function fromHtml(html, pdir, { title, label, fetcher }) {
  html = String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  const r = await inWindow(html, `(${WALK.toString()})()`);
  if (!r || !r.body || r.body.replace(/<[^>]+>/g, '').trim().length < 1) return 0;
  fs.rmSync(pdir, { recursive: true, force: true });
  const body = await saveImages(r.body, r.imgs, pdir, fetcher);
  return writePage(pdir, { title: title || r.title, body, label });
}

async function fromDocx(buf, pdir, { title, label = 'a Word document', fetcher }) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  return fromHtml(`<!doctype html><html><head><meta charset="utf-8"></head><body>${value}</body></html>`, pdir, { title, label, fetcher });
}

// ---------- PDF → Shelf blocks ----------
// Runs in the conversion window with pdf.js: rebuilds headings, paragraphs and lists from the text
// (font sizes and line gaps), and draws every page as a picture so charts and layout aren't lost.
const PDF = function (b64, pdfUrl, workerUrl, maxPages) {
  return (async () => {
    const pdfjs = await import(pdfUrl);
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const data = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
    let title = '';
    try { title = (await doc.getMetadata()).info?.Title || ''; } catch {}
    const n = Math.min(doc.numPages, maxPages);
    const pages = [];
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      // Lines: items on the same baseline.
      const lines = [];
      for (const it of tc.items) {
        if (!('str' in it) || !it.str) { if (it.hasEOL && lines.length) lines[lines.length - 1].eol = true; continue; }
        const size = Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.transform[0]) || 10;
        const y = it.transform[5], x = it.transform[4];
        const last = lines[lines.length - 1];
        if (last && !last.eol && Math.abs(last.y - y) < size * 0.5) { last.text += (x - last.endX > size * 0.25 && !/\s$/.test(last.text) && !/^\s/.test(it.str) ? ' ' : '') + it.str; last.endX = x + it.width; last.size = Math.max(last.size, size); }
        else lines.push({ text: it.str, y, x, endX: x + it.width, size, eol: false });
        if (it.hasEOL) lines[lines.length - 1].eol = true;
      }
      const vp = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      pages.push({ lines: lines.map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter(l => l.text), img: canvas.toDataURL('image/jpeg', 0.82), h: page.view[3] });
      page.cleanup();
    }
    return { title, total: doc.numPages, pages };
  })();
};

function pdfBody(r) {
  // Body text size = the size most characters use.
  const count = {};
  for (const p of r.pages) for (const l of p.lines) { const k = Math.round(l.size * 2) / 2; count[k] = (count[k] || 0) + l.text.length; }
  const body = +Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  // Running headers/footers: the same short line on most pages.
  const seen = {};
  for (const p of r.pages) for (const l of new Set(p.lines.map(l => l.text))) seen[l] = (seen[l] || 0) + 1;
  const repeated = (t) => r.pages.length >= 3 && seen[t] >= Math.max(3, r.pages.length * 0.5) && t.length < 120;
  const out = [];
  let para = null, list = null;
  const flushPara = () => { if (para) { out.push(`<div class="text">${esc(para)}</div>`); para = null; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${esc(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const BULLET = /^([•◦▪●○■\-–*])\s+/, NUM = /^(\d{1,3}|[a-z])[.)]\s+/;
  for (const p of r.pages) {
    let prev = null;
    for (const l of p.lines) {
      if (repeated(l.text) || /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d+)?$/i.test(l.text) || /^[*†‡§¶∗\s]+$/.test(l.text)) continue;
      const ratio = l.size / body;
      const gap = prev ? prev.y - l.y : 0;
      const newBlock = !prev || gap > l.size * 1.7 || gap < -l.size || Math.abs(l.size - prev.size) > body * 0.15;
      if (ratio >= 1.25 && l.text.length < 140) {
        flushPara(); flushList();
        const lv = ratio >= 1.8 ? 1 : ratio >= 1.45 ? 2 : 3;
        const lastH = out[out.length - 1] || '';
        if (prev && !newBlock && lastH.startsWith(`<h${lv}`)) out[out.length - 1] = lastH.replace(`</h${lv}>`, ` ${esc(l.text)}</h${lv}>`);
        else out.push(`<h${lv} class="h">${esc(l.text)}</h${lv}>`);
        prev = l; continue;
      }
      // Numbered section titles in body size ("2 Background", "3.1 Encoder") are headings too.
      const sec = l.text.match(/^(\d{1,2}(?:\.\d{1,2}){0,2})\s+[A-Z][^.!?]{1,70}$/);
      if (sec && newBlock) {
        flushPara(); flushList();
        const lv = Math.min(3, sec[1].split('.').length + 1);
        out.push(`<h${lv} class="h">${esc(l.text)}</h${lv}>`);
        prev = l; continue;
      }
      const b = l.text.match(BULLET), m = !b && l.text.match(NUM);
      if (b || (m && (newBlock || list))) {
        flushPara();
        const tag = b ? 'ul' : 'ol';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(l.text.replace(b ? BULLET : NUM, ''));
      } else if (list && !newBlock) {
        list.items[list.items.length - 1] += ' ' + l.text;
      } else {
        flushList();
        if (para && !newBlock) para = /[a-z]-$/.test(para) && /^[a-z]/.test(l.text) ? para.slice(0, -1) + l.text : para + ' ' + l.text;
        else { flushPara(); para = l.text; }
      }
      prev = l;
    }
    flushPara(); flushList();   // paragraphs don't run across pages' headers; join is good enough per page
  }
  return out;
}

async function fromPdf(buf, pdir, { title, label = 'a PDF' }) {
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfUrl = pathToFileURL(path.join(root, 'legacy/build/pdf.mjs')).href;
  const workerUrl = pathToFileURL(path.join(root, 'legacy/build/pdf.worker.mjs')).href;
  const r = await inWindow('<!doctype html><html><body></body></html>',
    `(${PDF.toString()})(${JSON.stringify(Buffer.from(buf).toString('base64'))}, ${JSON.stringify(pdfUrl)}, ${JSON.stringify(workerUrl)}, ${MAX_PDF_PAGES})`, 240000);
  if (!r || !r.pages || !r.pages.length) return 0;
  const blocks = pdfBody(r);
  const textChars = blocks.join('').replace(/<[^>]+>/g, '').length;
  fs.rmSync(pdir, { recursive: true, force: true });
  fs.mkdirSync(path.join(pdir, 'img'), { recursive: true });
  const shots = r.pages.map((p, i) => {
    const name = `page-${String(i + 1).padStart(3, '0')}.jpg`;
    fs.writeFileSync(path.join(pdir, 'img', name), Buffer.from(p.img.split(',')[1], 'base64'));
    return `<figure class="image"><img src="img/${name}" alt="Page ${i + 1}"><figcaption>Page ${i + 1}</figcaption></figure>`;
  });
  const more = r.total > r.pages.length ? `<div class="text c-gray">Showing the first ${r.pages.length} of ${r.total} pages. The full PDF is kept under Files.</div>` : '';
  // Scanned PDFs have no text: then the pages themselves are the content.
  const body = textChars > 200
    ? `<div class="callout bg-gray"><span class="cicon">📄</span><div class="cbody"><div>Rebuilt from the PDF's text so you can edit it. The original pages are at the bottom, and the PDF itself is under Files.</div></div></div>\n${blocks.join('\n')}\n<hr>\n<details class="toggle"><summary>Original pages (${r.pages.length})</summary><div class="indent">${shots.join('\n')}</div></details>${more}`
    : `${shots.join('\n')}${more}`;
  const firstH = (blocks.find(b => /^<h[12] /.test(b)) || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
  return writePage(pdir, { title: (r.title || firstH || title || '').trim() || 'PDF', body, label });
}

// Builds the Shelf Page for a saved link from what's in its archive folder, if it doesn't have one.
// `opts.docHtml`: a Google Doc's HTML export (best quality). Otherwise original.docx / original.pdf.
async function buildFromArchive(dir, opts = {}) {
  const pdir = path.join(dir, 'notion');
  if (fs.existsSync(path.join(pdir, 'index.html')) && !opts.force) return 0;
  const has = (f) => fs.existsSync(path.join(dir, f));
  const label = opts.label;
  try {
    if (opts.docHtml) { const n = await fromHtml(opts.docHtml, pdir, { title: opts.title, label: label || 'a Google Doc', fetcher: opts.fetcher }); if (n) return n; }
  } catch (e) { console.error('Doc page', e.message); }
  try {
    if (has('original.docx')) { const n = await fromDocx(fs.readFileSync(path.join(dir, 'original.docx')), pdir, { title: opts.title, label: label || 'a Word document', fetcher: opts.fetcher }); if (n) return n; }
  } catch (e) { console.error('Word page', e.message); }
  try {
    if (has('original.pdf')) return await fromPdf(fs.readFileSync(path.join(dir, 'original.pdf')), pdir, { title: opts.title, label: label || 'a PDF' });
  } catch (e) { console.error('PDF page', e.message); }
  return 0;
}

const canHavePage = (files) => (files || []).some(f => f === 'original.pdf' || f === 'original.docx');

module.exports = { buildFromArchive, fromHtml, fromDocx, fromPdf, canHavePage };
