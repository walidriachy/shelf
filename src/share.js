// Turns a Shelf Page (index.html + sub-pages + images + styles) into ONE self-contained HTML file,
// so it can be sent to anyone or put online as a single link. Your edited version of each page
// (*.mine.html) is used when there is one.
const fs = require('fs');
const path = require('path');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon' };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const cssKey = (f) => path.basename(f).replace(/[^\w-]/g, '_');

// An image as a data: address. Very large photos are scaled down to screen size for the shared copy
// (the saved copy keeps the originals).
function encodeImage(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return ''; }
  const ext = path.extname(file).toLowerCase();
  let type = MIME[ext] || 'application/octet-stream';
  if (buf.length > 400e3 && /png|jpe?g|webp/.test(ext)) {
    try {
      const { nativeImage } = require('electron');
      let img = nativeImage.createFromBuffer(buf);
      const { width } = img.getSize();
      if (width > 1800) img = img.resize({ width: 1800, quality: 'best' });
      const jpg = img.toJPEG(82), png = ext === '.png' ? img.toPNG() : null;
      // Keep PNG when it has transparency worth keeping and isn't much bigger.
      const out = png && png.length < jpg.length * 1.5 ? [png, 'image/png'] : [jpg, 'image/jpeg'];
      if (out[0].length && out[0].length < buf.length) { buf = out[0]; type = out[1]; }
    } catch {}
  }
  return `data:${type};base64,${buf.toString('base64')}`;
}

function pageFiles(dir) {
  const names = fs.readdirSync(dir).filter(f => /^(index|p-[0-9a-f]+)\.html$/.test(f));
  // index first, then the rest in a stable order
  return names.sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
}

function bundle(dir) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error('This link has no Shelf Page');
  const css = fs.readFileSync(path.join(dir, 'shelf-page.css'), 'utf8');
  // Each image is stored once (pages often repeat the same icon or cover) and filled in on open.
  const images = {};
  const usedInCss = new Set(), usedInImg = new Set();
  const keyOf = (rel) => {
    const name = path.basename(rel);
    if (!(name in images)) images[name] = encodeImage(path.join(dir, 'img', name));
    return images[name] ? name : '';
  };

  let title = 'Shelf Page';
  const sections = [];
  for (const name of pageFiles(dir)) {
    const id = name.replace(/\.html$/, '');
    const mine = path.join(dir, id + '.mine.html');
    const html = fs.readFileSync(fs.existsSync(mine) ? mine : path.join(dir, name), 'utf8');
    const t = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
    if (id === 'index') title = t || title;
    const cls = (html.match(/<body[^>]*class="([^"]*)"/i) || [])[1] || '';
    let body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1] || '';
    body = body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
      .replace(/<img([^>]*?)\ssrc="img\/([^"]+)"/g, (m, attrs, f) => keyOf(f) && usedInImg.add(path.basename(f)) ? `<img${attrs} data-si="${esc(path.basename(f))}" src="${BLANK}"` : m)
      .replace(/url\((['"]?)img\/([^'")]+)\1\)/g, (m, q, f) => { if (!keyOf(f)) return m; usedInCss.add(path.basename(f)); return `var(--si-${cssKey(f)})`; })
      // links between pages become in-file links
      .replace(/href="(index|p-[0-9a-f]+)(?:\.mine)?\.html(#[^"]*)?"/g, (m, p, frag) => `href="#${p}${frag ? '~' + frag.slice(1) : ''}"`);
    sections.push(`<section class="sp" id="${id}" data-cls="${esc(cls.trim())}" data-title="${esc(t)}">${body}</section>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${css}
.sp{display:none}.sp.on{display:block}
:root{${Object.keys(images).filter(k => images[k] && usedInCss.has(k)).map(k => `--si-${cssKey(k)}:url("${images[k]}")`).join(';')}}</style></head>
<body>
${sections.join('\n')}
<script type="application/json" id="shelf-images">${JSON.stringify(Object.fromEntries([...usedInImg].map(k => [k, images[k]]))).replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var imgs = JSON.parse(document.getElementById('shelf-images').textContent);
  document.querySelectorAll('img[data-si]').forEach(function (i) { var d = imgs[i.getAttribute('data-si')]; if (d) i.src = d; });
  function show() {
    var h = decodeURIComponent(location.hash.slice(1)), parts = h.split('~'), id = parts[0] || 'index', frag = parts[1];
    var s = document.getElementById(id);
    if (!s || !s.classList.contains('sp')) {   // a link to a spot inside a page
      var el = h && document.getElementById(h); s = el ? el.closest('.sp') : null; frag = h;
      if (!s) s = document.getElementById('index');
    }
    document.querySelectorAll('.sp.on').forEach(function (x) { x.classList.remove('on'); });
    s.classList.add('on');
    document.body.className = s.getAttribute('data-cls') || '';
    document.title = s.getAttribute('data-title') || document.title;
    var target = frag && document.getElementById(frag);
    if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', show);
  show();
})();
</script>
</body></html>`;
}

module.exports = { bundle };
