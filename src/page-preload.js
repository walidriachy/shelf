// Runs in a Shelf Page window. Adds a small bar on top of the page with Edit / Save / Reset,
// and a formatting toolbar while editing. Edits are saved as "your version" next to the original.
const { ipcRenderer } = require('electron');

const CSS = `
#shelf-bar { position: fixed; top: 8px; right: 10px; z-index: 50; display: flex; gap: 6px; align-items: center; font: 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
#shelf-bar button, #shelf-tools button, #shelf-tools select { font: inherit; border: 1px solid var(--line); background: var(--bg); color: var(--text); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
#shelf-bar button:hover, #shelf-tools button:hover { background: var(--hover); }
#shelf-bar .primary { background: #2383e2; border-color: #2383e2; color: #fff; }
#shelf-bar .tag { color: var(--muted); padding: 0 4px; }
#shelf-tools { position: sticky; top: 44px; z-index: 40; display: none; flex-wrap: wrap; gap: 4px; justify-content: center; padding: 6px; margin: 0 auto; background: var(--bg); border-bottom: 1px solid var(--line); font: 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
body.shelf-editing #shelf-tools { display: flex; }
#shelf-tools button { padding: 5px 8px; min-width: 30px; }
#shelf-tools .sep { width: 1px; background: var(--line); margin: 2px 4px; }
body.shelf-editing .page [contenteditable="true"]:focus { outline: none; }
body.shelf-editing .content, body.shelf-editing .title { caret-color: #2383e2; }
body.shelf-editing .todo .box { cursor: pointer; }
#shelf-toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: #2f2f2f; color: #fff; padding: 8px 14px; border-radius: 8px; font: 13px -apple-system, sans-serif; opacity: 0; transition: opacity .2s; z-index: 60; pointer-events: none; }
#shelf-toast.on { opacity: 1; }
`;

let editing = false, dirty = false, info = { mine: false };

function el(tag, attrs = {}, text = '') { const e = document.createElement(tag); Object.assign(e, attrs); if (text) e.textContent = text; return e; }
function toast(t) { const n = document.getElementById('shelf-toast'); n.textContent = t; n.classList.add('on'); clearTimeout(n._t); n._t = setTimeout(() => n.classList.remove("on"), 3200); }
const editables = () => [document.querySelector('.title'), document.querySelector('.content'), document.querySelector('.props')].filter(Boolean);
const file = () => decodeURIComponent(location.pathname.split('/').pop()).replace(/\.mine\.html$/, '.html');

function renderBar() {
  const bar = document.getElementById('shelf-bar');
  bar.innerHTML = '';
  if (editing) {
    bar.append(el('span', { className: 'tag' }, dirty ? 'Unsaved changes' : 'Editing'));
    bar.append(el('button', { onclick: () => stop(false) }, 'Cancel'));
    bar.append(el('button', { className: 'primary', onclick: save }, 'Save'));
  } else {
    if (info.mine) {
      bar.append(el('span', { className: 'tag' }, 'Your version'));
      bar.append(el('button', { onclick: reset, title: 'Go back to the page as it was saved from Notion' }, 'Reset to original'));
    }
    bar.append(el('button', { onclick: exportFile, title: 'Save as one file that opens in any browser' }, 'Export'));
    bar.append(el('button', { onclick: shareLink, title: 'Make a link anyone can open (uses your Cloudflare R2)' }, 'Share'));
    bar.append(el('button', { className: 'primary', onclick: start }, 'Edit'));
  }
}

function start() {
  editing = true; dirty = false;
  document.body.classList.add('shelf-editing');
  for (const e of editables()) e.contentEditable = 'true';
  // Toggles stay open while editing so their contents can be changed.
  document.querySelectorAll('details').forEach(d => { d.dataset.wasOpen = d.open ? '1' : ''; d.open = true; });
  // Non-text pieces shouldn't be typed into.
  document.querySelectorAll('.todo .box, img, .chip').forEach(x => x.contentEditable = 'false');
  (document.querySelector('.content') || document.body).focus();
  renderBar();
}

const ask = (message, detail, ok) => ipcRenderer.invoke('page-confirm', message, detail, ok);

async function stop(keep) {
  if (!keep && dirty && !(await ask('Discard your changes?', 'Your edits since the last save will be lost.', 'Discard changes'))) return;
  // Throw the changes away by reloading the saved page. Turn off the unsaved-changes guard first,
  // or it would block the reload.
  if (!keep) { editing = false; dirty = false; location.reload(); return; }
  editing = false; dirty = false;
  document.body.classList.remove('shelf-editing');
  document.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
  document.querySelectorAll('details').forEach(d => { d.open = !!d.dataset.wasOpen; delete d.dataset.wasOpen; });
  renderBar();
}

// The page as HTML, without Shelf's own editing bits and without anything that could run code.
function cleanHtml() {
  const doc = document.documentElement.cloneNode(true);
  doc.querySelectorAll('#shelf-bar, #shelf-tools, #shelf-toast, #shelf-style, script, iframe, object, embed').forEach(n => n.remove());
  doc.querySelector('body').classList.remove('shelf-editing');
  doc.querySelectorAll('*').forEach(n => {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || a.name === 'contenteditable' || a.name === 'data-was-open') n.removeAttribute(a.name);
      else if ((a.name === 'href' || a.name === 'src') && /^\s*javascript:/i.test(a.value)) n.setAttribute(a.name, '#');
    }
  });
  doc.querySelectorAll('details').forEach(d => d.removeAttribute('open'));
  return '<!doctype html>' + doc.outerHTML;
}

async function save() {
  const r = await ipcRenderer.invoke('page-save', file(), cleanHtml());
  if (!r.ok) { toast(r.message || 'Could not save'); return; }
  info.mine = true;
  dirty = false;
  if (!location.pathname.endsWith('.mine.html')) { location.replace(file().replace(/\.html$/, '.mine.html')); return; }
  stop(true);
  toast('Saved as your version');
}

async function exportFile() {
  const r = await ipcRenderer.invoke('page-export');
  if (r && r.ok) toast('Exported'); else if (r && !r.canceled) toast(r.error || 'Could not export');
}
async function shareLink() {
  toast('Uploading…');
  const r = await ipcRenderer.invoke('page-share');
  toast(r && r.ok ? 'Link copied. Anyone with it can view this page for 7 days.' : (r && r.error) || 'Could not share');
}

async function reset() {
  if (!(await ask('Go back to the original page?', 'Your changes to this page will be deleted.', 'Reset to original'))) return;
  await ipcRenderer.invoke('page-reset', file());
  location.href = file();
}

function cmd(c, v) { document.execCommand(c, false, v); dirty = true; renderBar(); }
function insert(html) { document.execCommand('insertHTML', false, html); dirty = true; renderBar(); }
function selText() { return String(window.getSelection() || '').replace(/[<>&]/g, '') || ''; }

function tools() {
  const t = el('div', { id: 'shelf-tools' });
  const b = (label, title, fn) => t.append(el('button', { title, onmousedown: (e) => { e.preventDefault(); fn(); } }, label));
  const sep = () => t.append(el('span', { className: 'sep' }));
  b('B', 'Bold (⌘B)', () => cmd('bold'));
  b('I', 'Italic (⌘I)', () => cmd('italic'));
  b('U', 'Underline (⌘U)', () => cmd('underline'));
  b('S', 'Strikethrough', () => cmd('strikeThrough'));
  b('</>', 'Inline code', () => insert(`<code>${selText() || 'code'}</code>&nbsp;`));
  b('Link', 'Add a link to the selected text', () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { toast('Select some text first'); return; }
    const range = sel.getRangeAt(0).cloneRange();
    const box = el('input', { placeholder: 'https://… then Enter', style: 'font:inherit;padding:5px 8px;border-radius:6px;border:1px solid #2383e2;width:220px;background:var(--bg);color:var(--text)' });
    t.append(box); box.focus();
    const done = (ok) => {
      const u = box.value.trim(); box.remove();
      sel.removeAllRanges(); sel.addRange(range);
      if (ok && /^(https?:|mailto:)/i.test(u)) cmd('createLink', u);
      else if (ok && u) toast('Links must start with https://');
    };
    box.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
    box.onblur = () => box.isConnected && done(false);
  });
  sep();
  b('Text', 'Plain text', () => cmd('formatBlock', 'div'));
  b('H1', 'Heading 1', () => cmd('formatBlock', 'h1'));
  b('H2', 'Heading 2', () => cmd('formatBlock', 'h2'));
  b('H3', 'Heading 3', () => cmd('formatBlock', 'h3'));
  sep();
  b('• List', 'Bulleted list', () => cmd('insertUnorderedList'));
  b('1. List', 'Numbered list', () => cmd('insertOrderedList'));
  b('☐ To-do', 'To-do', () => insert(`<div class="todo"><span class="box" contenteditable="false"></span><span class="tt">${selText() || 'To-do'}</span></div><div class="text"><br></div>`));
  b('▸ Toggle', 'Toggle', () => insert(`<details class="toggle" open><summary>${selText() || 'Toggle'}</summary><div class="indent"><div class="text">Inside the toggle</div></div></details><div class="text"><br></div>`));
  sep();
  b('Quote', 'Quote', () => cmd('formatBlock', 'blockquote'));
  b('💡 Callout', 'Callout', () => insert(`<div class="callout bg-gray"><span class="cicon">💡</span><div class="cbody"><div>${selText() || 'Callout'}</div></div></div><div class="text"><br></div>`));
  b('Code', 'Code block', () => insert(`<div class="code"><div class="lang"></div><pre><code>${selText() || 'code'}</code></pre></div><div class="text"><br></div>`));
  b('—', 'Divider', () => insert('<hr><div class="text"><br></div>'));
  b('Image', 'Add an image from your computer', async () => { const r = await ipcRenderer.invoke('page-image'); if (r) insert(`<figure class="image"><img src="${r}" alt=""></figure><div class="text"><br></div>`); });
  sep();
  b('↶', 'Undo (⌘Z)', () => cmd('undo'));
  b('↷', 'Redo (⇧⌘Z)', () => cmd('redo'));
  return t;
}

window.addEventListener('DOMContentLoaded', async () => {
  info = await ipcRenderer.invoke('page-info', decodeURIComponent(location.pathname.split('/').pop()));
  const onMine = location.pathname.endsWith('.mine.html');
  if (info.mine && !onMine) { location.replace(file().replace(/\.html$/, '.mine.html') + location.hash); return; }
  const style = el('style', { id: 'shelf-style' }); style.textContent = CSS; document.head.append(style);
  document.body.append(el('div', { id: 'shelf-bar' }), el('div', { id: 'shelf-toast' }));
  const crumbs = document.querySelector('.crumbs');
  (crumbs || document.body.firstChild).after(tools());
  renderBar();

  document.addEventListener('input', () => { if (editing && !dirty) { dirty = true; renderBar(); } });
  document.addEventListener('click', (e) => {
    const box = e.target.closest('.todo .box');
    if (box && editing) { box.parentElement.classList.toggle('done'); box.textContent = box.parentElement.classList.contains('done') ? '✓' : ''; dirty = true; renderBar(); return; }
    // While editing, clicking a link places the cursor instead of leaving the page.
    if (editing && e.target.closest('a')) e.preventDefault();
    if (editing && e.target.closest('summary')) e.preventDefault();
  }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (editing) save(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e' && !editing) { e.preventDefault(); start(); }
    if (e.key === 'Escape' && editing) stop(false);
  });
  // Paste as plain text so pasted content takes on the page's style.
  document.addEventListener('paste', (e) => {
    if (!editing) return;
    const text = e.clipboardData.getData('text/plain');
    if (text) { e.preventDefault(); document.execCommand('insertText', false, text); }
  });
  window.addEventListener('beforeunload', (e) => { if (editing && dirty) { e.preventDefault(); e.returnValue = ''; } });
});
