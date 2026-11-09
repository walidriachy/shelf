const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

let links = [], categories = [], settings = {}, view = 'All', sort = 'new', filter = '', editing = null;

function toast(text) {
  const t = $('#toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

function renderCats() {
  const counts = {};
  for (const l of links) counts[l.category] = (counts[l.category] || 0) + 1;
  const used = categories.filter(c => counts[c] || true);
  const row = (name, n, removable) => `<button class="cat ${view === name ? 'on' : ''}" data-cat="${esc(name)}">
      <span>${esc(name)}</span><span class="n ${removable ? 'has-x' : ''}">${n || ''}</span>
      ${removable ? `<span class="x" data-remove="${esc(name)}" title="Remove category">✕</span>` : ''}
    </button>`;
  $('#cats').innerHTML = row('All', links.length) + row('Recent', '') + '<div class="cat-sep"></div>' +
    used.map(c => row(c, counts[c], c !== 'Other')).join('');
}

function visibleLinks() {
  let list = links;
  if (view === 'Recent') list = list.filter(l => Date.now() - l.createdAt < 7 * 864e5);
  else if (view !== 'All') list = list.filter(l => l.category === view);
  if (filter) {
    const q = filter.toLowerCase();
    list = list.filter(l => [l.title, l.url, l.summary, l.description, l.note, l.offers, l.category, ...(l.tags || [])].join(' ').toLowerCase().includes(q));
  }
  list = list.slice();
  if (sort === 'az') list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

const shotUrl = (l) => l.shot ? `shelf://archive/${l.id}/screenshot.jpg` : '';
function thumb(l) {
  const letter = esc((l.title || host(l.url) || '?').trim()[0]?.toUpperCase() || '?');
  if (!l.image && l.shot) return `<img class="cover" src="${esc(shotUrl(l))}" loading="lazy" data-fallback="${esc(l.favicon)}" data-letter="${letter}">`;
  if (l.image) return `<img class="cover" src="${esc(l.image)}" loading="lazy" data-fallback="${esc(shotUrl(l) || l.favicon)}" data-letter="${letter}">`;
  if (l.favicon) return `<img class="fallback" src="${esc(l.favicon)}" loading="lazy" data-letter="${letter}">`;
  return `<span class="letter">${letter}</span>`;
}

function card(l) {
  const pending = l.status === 'pending';
  return `<article class="card ${pending ? 'pending' : ''}" data-id="${l.id}">
    <div class="thumb">${thumb(l)}</div>
    <button class="edit" data-edit="${l.id}">Edit</button>
    <div class="body">
      <div class="site">${l.favicon ? `<img src="${esc(l.favicon)}">` : ''}<span>${esc(host(l.url))}</span></div>
      <div class="title">${esc(l.title || host(l.url))}</div>
      ${pending ? '<div class="status">Reading and saving a copy…</div>' : ''}
      ${l.offline ? `<div class="err">${esc(l.offline)}</div>` : ''}
      ${l.summary ? `<div class="summary">${esc(l.summary)}</div>` : (!pending && l.description ? `<div class="summary">${esc(l.description)}</div>` : '')}
      ${l.offers && !/^(unknown|n\/a|none)\.?$/i.test(l.offers) ? `<div class="offers">${esc(l.offers)}</div>` : ''}
      ${l.note ? `<div class="note">${esc(l.note)}</div>` : ''}
      ${l.error ? `<div class="err">${esc(l.error)}</div>` : ''}
      <div class="meta"><span class="pill cat-pill">${esc(l.category)}</span>${l.type ? `<span class="pill type">${esc(l.type)}</span>` : ''}${(l.tags || []).filter(t => t !== String(l.category).toLowerCase()).slice(0, 6).map(t => `<span class="pill">${esc(t)}</span>`).join('')}</div>
      ${l.archivedAt ? `<div class="saved" title="Shelf keeps its own copy of this link">✓ ${l.page ? (l.edited ? 'Shelf Page · edited' : 'Shelf Page saved') : l.video ? (l.video.transcript ? 'Transcript saved' : 'Video details saved') : l.copy ? 'Exact copy saved' : 'Text copy saved'}${relCount(l) ? ` <span class="relbadge" title="Connected links">🔗 ${relCount(l)}</span>` : ''}${l.files && l.files.some(f => f.startsWith('original')) && l.copy !== 'page.mhtml' ? '' : ''}</div>` : ''}
    </div>
  </article>`;
}

function renderGrid() {
  const list = visibleLinks();
  $('#viewTitle').textContent = view === 'All' ? 'All links' : view;
  $('#count').textContent = list.length ? `${list.length}` : '';
  $('#grid').innerHTML = list.map(card).join('');
  $('#empty').classList.toggle('hidden', links.length > 0);
  if (links.length && !list.length) $('#grid').innerHTML = `<p class="muted">Nothing here${filter ? ` matching “${esc(filter)}”` : ''}.</p>`;
  wireImages($('#grid'));
}

function wireImages(root) {
  root.querySelectorAll('img[data-letter]').forEach(img => {
    img.addEventListener('error', () => {
      const fb = img.dataset.fallback;
      if (fb && img.src !== fb && img.classList.contains('cover')) { img.className = 'fallback'; img.src = fb; delete img.dataset.fallback; return; }
      img.replaceWith(Object.assign(document.createElement('span'), { className: 'letter', textContent: img.dataset.letter }));
    }, { once: false });
  });
}

function render() { renderCats(); renderGrid(); }

// Adding
$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#addInput');
  const value = input.value.trim();
  if (!value) return;
  const parts = value.split(/\s+/).filter(p => /\.|^https?:/.test(p));
  input.value = '';
  for (const p of (parts.length ? parts : [value])) {
    const r = await window.shelf.add(p);
    if (!r.ok) toast(r.error);
    else if (r.duplicate) toast('Already on your shelf');
  }
});

// Paste a link anywhere in the window (outside inputs) to save it.
document.addEventListener('paste', async (e) => {
  if (e.target.closest('input, textarea, dialog')) return;
  const text = e.clipboardData.getData('text');
  if (/^(https?:\/\/|www\.)\S+$/i.test(text.trim())) { const r = await window.shelf.add(text.trim()); toast(r.ok ? (r.duplicate ? 'Already on your shelf' : 'Saved') : r.error); }
});

$('#filterInput').addEventListener('input', (e) => { filter = e.target.value.trim(); renderGrid(); });

$('#sortSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  sort = b.dataset.sort;
  $('#sortSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  renderGrid();
});

$('#cats').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    e.stopPropagation();
    if (confirm(`Remove “${rm.dataset.remove}”? Its links move to Other.`)) {
      categories = await window.shelf.removeCategory(rm.dataset.remove);
      if (view === rm.dataset.remove) view = 'All';
    }
    return;
  }
  const b = e.target.closest('[data-cat]'); if (!b) return;
  view = b.dataset.cat; render();
});

$('#newCat').addEventListener('click', () => {
  const d = $('#prompt'); $('#pInput').value = ''; d.showModal(); $('#pInput').focus();
  d.onclose = async () => { if (d.returnValue === 'ok' && $('#pInput').value.trim()) { categories = await window.shelf.addCategory($('#pInput').value.trim()); render(); } };
});

$('#grid').addEventListener('click', (e) => {
  const ed = e.target.closest('[data-edit]');
  if (ed) { e.stopPropagation(); return openEdit(ed.dataset.edit); }
  const c = e.target.closest('.card'); if (!c) return;
  const l = links.find(x => x.id === c.dataset.id); if (!l) return;
  if (e.metaKey || e.ctrlKey) window.shelf.open(l.url); else openDetail(l.id);
});
$('#grid').addEventListener('contextmenu', (e) => {
  const c = e.target.closest('.card'); if (!c) return;
  e.preventDefault(); openEdit(c.dataset.id);
});

// Editing
function openEdit(id) {
  const l = links.find(x => x.id === id); if (!l) return;
  editing = l;
  $('#eTitle').value = l.title || '';
  $('#eCat').innerHTML = categories.map(c => `<option ${c === l.category ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('#eTags').value = (l.tags || []).join(', ');
  $('#eNote').value = l.note || '';
  $('#edit').showModal();
}
$('#edit').addEventListener('close', async () => {
  if ($('#edit').returnValue !== 'save' || !editing) return;
  await window.shelf.update(editing.id, {
    title: $('#eTitle').value.trim(), category: $('#eCat').value,
    tags: $('#eTags').value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean), note: $('#eNote').value.trim(),
  });
  toast('Saved');
});
$('#eDelete').addEventListener('click', async () => { await window.shelf.remove(editing.id); $('#edit').close(); toast('Deleted'); });
$('#eRedo').addEventListener('click', async () => {
  await window.shelf.update(editing.id, { categoryLocked: false });
  await window.shelf.reprocess(editing.id); $('#edit').close(); toast('Re-sorting…');
});

// Ask
const askPanel = $('#ask');
$('#askBtn').addEventListener('click', () => { askPanel.classList.toggle('open'); if (askPanel.classList.contains('open')) setTimeout(() => $('#askInput').focus(), 200); });
$('#askClose').addEventListener('click', () => askPanel.classList.remove('open'));
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); askPanel.classList.add('open'); $('#askInput').focus(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); $('#addInput').focus(); }
  if (e.key === 'Escape' && askPanel.classList.contains('open') && !document.querySelector('dialog[open]')) askPanel.classList.remove('open');
});

function bubble(cls, html) {
  const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html;
  $('#chat').appendChild(d); $('#chat').scrollTop = 1e9; return d;
}

$('#askForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#askInput').value.trim(); if (!q) return;
  $('#askInput').value = '';
  bubble('me', esc(q));
  const thinking = bubble('bot thinking', settings.activeProvider === 'claude' ? 'Asking Claude…' : settings.activeProvider === 'replicate' ? 'Looking through your shelf…' : 'Searching…');
  const r = await window.shelf.ask(q);
  thinking.classList.remove('thinking');
  thinking.innerHTML = esc(r.answer);
  const found = r.ids.map(id => links.find(l => l.id === id)).filter(Boolean);
  if (found.length) {
    const box = document.createElement('div'); box.className = 'hits';
    box.innerHTML = found.map(l => `<div class="hit" data-id="${l.id}">
      ${l.image || l.shot || l.favicon ? `<img src="${esc(l.image || shotUrl(l) || l.favicon)}">` : '<img>'}
      <div><div class="t">${esc(l.title)}</div><div class="s">${esc(l.summary || l.description || host(l.url))}</div></div></div>`).join('');
    box.addEventListener('click', (ev) => { const h = ev.target.closest('.hit'); if (h) openDetail(h.dataset.id); });
    $('#chat').appendChild(box); $('#chat').scrollTop = 1e9;
  }
});

// Settings
async function openSettings() {
  settings = await window.shelf.settings();
  $('#sReplicate').value = ''; $('#sReplicate').placeholder = settings.replicateHint || 'r8_…';
  $('#sGist').value = ''; $('#sGist').placeholder = settings.gistHint || 'ghp_…';
  $('#sModel').value = settings.model || '';
  $('#sProvider').value = settings.provider || 'auto';
  $('#sClaudeModel').value = settings.claudeModel || 'haiku';
  $('#sClaudeToken').value = ''; $('#sClaudeToken').placeholder = settings.claudeHint ? `Using token ${settings.claudeHint}` : 'Leave empty to use the account Claude Code is signed in with';
  $('#sClaudeClear').classList.toggle('hidden', !settings.hasClaudeToken);
  $('#sClaudeStatus').innerHTML = settings.claudeFound
    ? '<span class="good">●</span> Claude Code found on this computer. Shelf will use your Claude subscription.'
    : '<span class="bad">●</span> Claude Code isn’t installed here. Install it from claude.com/code and sign in, then reopen Shelf.';
  showProvider();
  $('#sKey').textContent = settings.bridgeToken;
  $('#sGistInfo').textContent = settings.hasGist ? (settings.lastSync ? `Last synced ${new Date(settings.lastSync).toLocaleString()}` : 'Not synced yet') : 'Off';
  showR2();
  renderLibrary(await window.shelf.library());
  $('#settings').showModal();
}

// Library folder
function renderLibrary(info) {
  $('#libWhere').textContent = info.where.name;
  $('#libPath').textContent = info.dir.split(/[\\/]/).filter(Boolean).slice(-3).join('/').replace(/^/, '…/'); $('#libPath').title = info.dir;
  const same = (a, b) => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');
  const rows = [{ id: 'local', name: 'This computer only', target: 'local', meta: 'No cloud', on: same(info.dir, info.defaultDir) }];
  for (const p of info.places) rows.push({ id: p.id, name: p.name, target: p.dir, on: same(info.dir, p.dir),
    meta: (p.account ? p.account + ' · ' : '') + (p.links ? `${p.links} links already there` : 'Shelf folder') });
  const custom = info.where.id === 'folder';
  rows.push({ id: 'pick', name: custom ? 'Custom folder' : 'Choose a folder…', target: 'pick', meta: custom ? 'Change' : 'Dropbox, OneDrive, a USB drive…', on: custom });
  if (!info.places.some(p => p.id === 'icloud')) rows.splice(1, 0, { id: 'icloud', name: 'iCloud Drive', target: '', meta: 'Not set up on this computer', off: true });
  if (!info.places.some(p => p.id === 'gdrive')) rows.splice(2, 0, { id: 'gdrive', name: 'Google Drive', target: '', meta: 'Install Google Drive for desktop', off: true });
  $('#libPlaces').innerHTML = rows.map(r => `<button type="button" class="place ${r.on ? 'on' : ''}" data-target="${esc(r.target)}" data-name="${esc(r.name)}" data-links="${esc((info.places.find(p => p.dir === r.target) || {}).links || 0)}" ${r.off ? 'disabled' : ''}>
    <span class="radio"></span><span class="pname">${esc(r.name)}</span><span class="pmeta">${esc(r.meta)}</span></button>`).join('');
}
$('#libPlaces').addEventListener('click', async (e) => {
  const b = e.target.closest('.place');
  if (!b || b.disabled || b.classList.contains('on') && b.dataset.target !== 'pick') return;
  let target = b.dataset.target, name = b.dataset.name, existing = +b.dataset.links;
  if (target === 'pick') {
    const r = await window.shelf.pickFolder();
    if (!r) return;
    target = r.dir; name = r.dir; existing = r.links;
  }
  const msg = target === 'local'
    ? 'Move your library back to this computer only?\n\nThe copy in the cloud folder stays where it is.'
    : `Move your library to ${name}?\n\n` + (existing ? `There are already ${existing} links there (probably from another computer). Your links will be added to them, nothing is removed.` : 'Your links and saved copies will be copied there, and the cloud app will back them up.');
  if (!confirm(msg)) return;
  $('#libPlaces').querySelectorAll('.place').forEach(x => x.disabled = true);
  const r = await window.shelf.setLibrary(target);
  if (!r.ok) { toast(r.message); renderLibrary(await window.shelf.library()); return; }
  renderLibrary(r.info);
  settings = await window.shelf.settings();
  toast(`Library is now in ${r.info.where.name}`);
});
$('#libShow').addEventListener('click', () => window.shelf.showLibrary());

// Cloudflare R2
function showR2() {
  const on = !!(settings.r2On && settings.r2AccessKeyId);
  $('#r2Setup').classList.toggle('hidden', on);
  $('#r2Done').classList.toggle('hidden', !on);
  $('#r2DoneBtns').classList.toggle('hidden', !on);
  $('#r2BucketName').textContent = settings.r2Bucket;
  $('#r2Token').value = '';
  $('#sR2Account').value = settings.r2AccountId; $('#sR2Bucket').value = settings.r2Bucket; $('#sR2Key').value = settings.r2AccessKeyId;
  $('#sR2Secret').value = ''; $('#sR2Secret').placeholder = settings.hasR2Secret ? 'Saved (type to replace)' : '';
  $('#sR2Info').textContent = on ? (settings.r2LastBackup ? `Last backup ${new Date(settings.r2LastBackup).toLocaleString()}` : 'Not backed up yet') : '';
}
$('#r2Open').addEventListener('click', () => window.shelf.r2OpenToken());
window.shelf.onR2Step((m) => { $('#sR2Info').textContent = m; });
$('#r2Connect').addEventListener('click', async () => {
  const btn = $('#r2Connect');
  btn.disabled = true;
  const r = await window.shelf.r2Connect($('#r2Token').value, $('#r2AccountId').value.trim());
  btn.disabled = false;
  if (!r.ok) { $('#sR2Info').textContent = r.message; if (r.needAccount) $('#r2AccountWrap').classList.remove('hidden'); return; }
  settings = r.settings; showR2(); setSync({});
  $('#sR2Info').textContent = r.message;
  toast('Cloudflare R2 connected');
});
$('#r2Disconnect').addEventListener('click', async () => {
  if (!confirm('Stop backing up to Cloudflare R2?\n\nThe backup already in your bucket is not deleted.')) return;
  settings = await window.shelf.r2Disconnect(); showR2(); setSync({});
});
function r2Patch() {
  if (!$('#r2Manual').open) return {};
  const p = { r2AccountId: $('#sR2Account').value.trim(), r2Bucket: $('#sR2Bucket').value.trim(), r2AccessKeyId: $('#sR2Key').value.trim() };
  if ($('#sR2Secret').value.trim()) p.r2Secret = $('#sR2Secret').value.trim();
  p.r2On = !!(p.r2AccountId && p.r2Bucket && p.r2AccessKeyId);
  return p;
}
$('#sR2Test').addEventListener('click', async () => {
  settings = await window.shelf.settings(r2Patch());
  $('#sR2Info').textContent = 'Checking…';
  const r = await window.shelf.r2Test();
  settings = await window.shelf.settings(); showR2();
  $('#sR2Info').textContent = r.message;
});
$('#sR2Now').addEventListener('click', async () => {
  $('#sR2Info').textContent = 'Backing up…';
  const r = await window.shelf.syncNow();
  $('#sR2Info').textContent = r.message;
});
$('#settingsBtn').addEventListener('click', openSettings);
function showProvider() {
  const p = $('#sProvider').value;
  const claude = p === 'claude' || (p === 'auto' && settings.claudeFound);
  $('#pClaude').classList.toggle('hidden', !claude);
  $('#pReplicate').classList.toggle('hidden', !(p === 'replicate' || (p === 'auto' && !settings.claudeFound)));
}
$('#sProvider').addEventListener('change', showProvider);
$('#sClaudeClear').addEventListener('click', async () => {
  settings = await window.shelf.settings({ claudeToken: '' });
  $('#sClaudeClear').classList.add('hidden');
  $('#sClaudeToken').placeholder = 'Leave empty to use the account Claude Code is signed in with';
  toast('Token removed');
});
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'save') return;
  const patch = { model: $('#sModel').value.trim() || 'meta/meta-llama-3-70b-instruct', provider: $('#sProvider').value, claudeModel: $('#sClaudeModel').value };
  if ($('#sClaudeToken').value.trim()) patch.claudeToken = $('#sClaudeToken').value.trim();
  if ($('#sReplicate').value.trim()) patch.replicateToken = $('#sReplicate').value.trim();
  if ($('#sGist').value.trim()) patch.gistToken = $('#sGist').value.trim();
  Object.assign(patch, r2Patch());
  settings = await window.shelf.settings(patch);
  setSync({});
  toast('Settings saved');
});
$('#sCopy').addEventListener('click', async () => { await window.shelf.copy(settings.bridgeToken); toast('Key copied'); });
$('#sSync').addEventListener('click', async () => {
  if ($('#sGist').value.trim()) settings = await window.shelf.settings({ gistToken: $('#sGist').value.trim() });
  const r = await window.shelf.syncNow(); $('#sGistInfo').textContent = r.message;
});
$('#sExport').addEventListener('click', async () => {
  const blob = new Blob([await window.shelf.exportAll()], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `shelf-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
});

// Sync indicator
function setSync(s) {
  const b = $('#syncBtn');
  b.className = 'sync ' + (s.state || '');
  const where = settings.library && settings.library.where;
  const cloudFolder = where && where.id !== 'local';
  const backups = settings.r2On || settings.hasGist;
  const idle = cloudFolder ? where.name : backups ? 'Backed up' : 'Local only';
  if (!s.state && (cloudFolder || backups)) b.classList.add('ok');
  $('#syncText').textContent = s.state === 'syncing' ? (s.message || 'Syncing…') : s.state === 'error' ? 'Backup failed' : idle;
  b.title = s.message || (cloudFolder ? `Library is in ${where.name}` : '');
}
$('#syncBtn').addEventListener('click', async () => { if (!settings.hasGist && !settings.r2On) return openSettings(); await window.shelf.syncNow(); });

window.shelf.onState((s) => { links = s.links; categories = s.categories; render(); });
window.shelf.onSync(setSync);

(async () => {
  const s = await window.shelf.init();
  links = s.links; categories = s.categories; settings = s.settings;
  if (s.platform !== 'darwin') { $('#kbd').textContent = 'Ctrl Shift L'; document.querySelector('.drag').style.height = '14px'; }
  setSync({});
  render();
})();

// Hide any other broken image (inline handlers are blocked by the page's security policy).
document.addEventListener('error', (e) => { const t = e.target; if (t.tagName === 'IMG' && !t.dataset.letter) t.style.visibility = 'hidden'; }, true);


// ---------- Detail view ----------
function mdInline(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<span class="muted">[image: $1]</span>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="#" data-url="$2">$1</a>');
}
// Small Markdown renderer for notes and saved copies. Input is escaped first.
function md(src) {
  const lines = esc(src || '').split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; html.push(`<pre>${buf.join('\n')}</pre>`); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { const n = Math.min(m[1].length + 1, 6); html.push(`<h${n}>${mdInline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = []; while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => mdInline(c.trim().replace(/\\\|/g, '|')));
      const body = rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      html.push(`<div class="tablewrap"><table><thead><tr>${cells(body[0]).map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.slice(1).map(r => `<tr>${cells(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*•]|\d+\.)\s+/.test(line)) {
      const items = []; const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*•]|\d+\.)\s+/.test(lines[i])) {
        const lm = lines[i].match(/^(\s*)([-*•]|\d+\.)\s+(.*)$/);
        items.push(`<li style="margin-left:${Math.min(lm[1].length, 8) * 8}px">${mdInline(lm[3].replace(/^\[( |x)\]\s*/i, (x, c) => c.trim() ? '☑ ' : '☐ '))}</li>`); i++;
      }
      html.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`); continue;
    }
    if (/^&gt;\s?/.test(line)) { const buf = []; while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, '')); html.push(`<blockquote>${mdInline(buf.join('<br>'))}</blockquote>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const buf = []; while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*\||\s*([-*•]|\d+\.)\s|&gt;)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    html.push(`<p>${mdInline(buf.join('<br>'))}</p>`);
  }
  return html.join('\n');
}

const fmtSize = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';
const FILE_LABELS = { 'notion/index.html': 'Shelf Page (Shelf’s own editable copy, opens offline)', 'page.mhtml': 'Exact copy of the page (opens offline)', 'content.md': 'Text for search (Markdown)', 'notes.md': 'Shelf notes (Markdown)', 'screenshot.jpg': 'Screenshot of the page', 'original.pdf': 'Original PDF', 'original.docx': 'Word copy', 'original.xlsx': 'Spreadsheet copy', 'original.txt': 'Original text file' };
let detailId = null, detailData = null, detailTab = 'notes';
const liveLink = (id) => links.find(x => x.id === id);
const relCount = (l) => (l.related || []).filter(liveLink).length;
const ytThumb = (l) => l.video ? `https://i.ytimg.com/vi/${l.video.id}/hqdefault.jpg` : '';
const clockOf = (s) => { s = Math.floor(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

function renderRelated() {
  const l = liveLink(detailId); if (!l) return;
  const rel = (l.related || []).map(liveLink).filter(Boolean);
  $('#dRelList').innerHTML = rel.length ? rel.map(o => `<div class="rel" data-rel="${esc(o.id)}">
      <img src="${esc(o.favicon || '')}" alt="" onerror="this.style.visibility='hidden'">
      <div class="rel-main"><div class="rel-title">${esc(o.title || host(o.url))}</div><div class="muted small">${esc(host(o.url))}${o.type ? ' · ' + esc(o.type) : ''}${o.status === 'pending' ? ' · reading…' : ''}</div></div>
      <button class="ghost small-btn" data-relopen="${esc(o.id)}">Open</button>
      <button class="icon" data-relx="${esc(o.id)}" title="Disconnect">✕</button>
    </div>`).join('') : `<p class="muted small rel-empty">${l.video ? 'Got a PDF, Notion page or doc that explains this video? Paste its link below to keep them together.' : 'Nothing connected yet. Paste a link or search your saved links below.'}</p>`;
}

function relSuggest() {
  const q = $('#dRelInput').value.trim().toLowerCase();
  const box = $('#dRelSug');
  const l = liveLink(detailId);
  if (!q || !l) { box.classList.add('hidden'); return; }
  const isUrl = /^(https?:\/\/|www\.)|\.[a-z]{2,}\//i.test(q);
  const taken = new Set([l.id, ...(l.related || [])]);
  const words = q.split(/\s+/).filter(Boolean);
  const hits = isUrl ? [] : links.filter(o => !taken.has(o.id)).map(o => {
    const hay = [o.title, o.url, o.category, o.type, ...(o.tags || [])].join(' ').toLowerCase();
    return [o, words.every(w => hay.includes(w)) ? words.length + ((o.title || '').toLowerCase().includes(q) ? 2 : 0) : 0];
  }).filter(x => x[1]).sort((a, b) => b[1] - a[1]).slice(0, 6).map(x => x[0]);
  box.innerHTML = (isUrl ? `<button data-relurl="1"><b>Connect this link</b><span class="muted small"> · Shelf saves and reads it too</span></button>` : '') +
    hits.map(o => `<button data-relpick="${esc(o.id)}"><img src="${esc(o.favicon || '')}" alt="" onerror="this.style.visibility='hidden'"> ${esc(o.title || host(o.url))} <span class="muted small">${esc(host(o.url))}</span></button>`).join('') +
    (!isUrl && !hits.length ? `<div class="muted small pad">No saved links match. Paste a full link to add a new one.</div>` : '');
  box.classList.remove('hidden');
}

async function relConnect(target) {
  const id = detailId;
  $('#dRelInput').value = ''; $('#dRelSug').classList.add('hidden');
  const r = await window.shelf.connect(id, target);
  if (!r || !r.ok) { toast((r && r.error) || 'Could not connect that link'); return; }
  toast(r.link && r.link.status === 'pending' ? 'Connected. Shelf is reading the new link…' : 'Connected');
}
$('#dRelInput').addEventListener('input', relSuggest);
$('#dRelInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); const v = $('#dRelInput').value.trim(); const first = $('#dRelSug [data-relpick]'); if (/^(https?:\/\/|www\.)|\.[a-z]{2,}\//i.test(v)) relConnect(v); else if (first) relConnect(first.dataset.relpick); }
  if (e.key === 'Escape' && $('#dRelInput').value) { e.preventDefault(); e.stopPropagation(); $('#dRelInput').value = ''; $('#dRelSug').classList.add('hidden'); }
});
$('#dRelSug').addEventListener('mousedown', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  e.preventDefault();
  if (b.dataset.relurl) relConnect($('#dRelInput').value.trim()); else relConnect(b.dataset.relpick);
});
$('#dRelInput').addEventListener('blur', () => setTimeout(() => $('#dRelSug').classList.add('hidden'), 150));
$('#dRelList').addEventListener('click', async (e) => {
  const x = e.target.closest('[data-relx]'); if (x) { await window.shelf.disconnect(detailId, x.dataset.relx); return; }
  const o = e.target.closest('[data-relopen], .rel'); if (o) openDetail(o.dataset.relopen || o.dataset.rel);
});

async function openDetail(id) {
  const l = links.find(x => x.id === id); if (!l) return;
  detailId = id;
  detailData = await window.shelf.detail(id);
  $('#dFav').src = l.favicon || ''; $('#dFav').style.visibility = l.favicon ? 'visible' : 'hidden';
  $('#dHost').textContent = host(l.url) + (l.source ? ` · ${l.source}` : '');
  $('#dTitle').textContent = l.title || host(l.url);
  $('#dOffline').textContent = l.offline || '';
  $('#dOffline').classList.toggle('hidden', !l.offline);
  $('#dPills').innerHTML = [`<span class="pill cat-pill">${esc(l.category)}</span>`, l.type && `<span class="pill type">${esc(l.type)}</span>`, l.pricing && l.pricing !== 'unknown' && `<span class="pill">${esc(l.pricing)}</span>`, l.archivedAt && `<span class="pill">saved ${new Date(l.archivedAt).toLocaleDateString()}</span>`].filter(Boolean).join('');
  $('#dSummary').textContent = l.summary || l.description || '';
  $('#dOffers').innerHTML = [l.offers && `<div><b>What it offers</b> ${esc(l.offers)}</div>`, l.note && `<div><b>Your note</b> ${esc(l.note)}</div>`].filter(Boolean).join('');
  $('#dTags').innerHTML = (l.tags || []).map(t => `<span class="pill">${esc(t)}</span>`).join('');
  $('#dUse').innerHTML = l.useFor && l.useFor.length ? `<h4>Use it when you need</h4><ul>${l.useFor.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  $('#dPoints').innerHTML = l.keyPoints && l.keyPoints.length ? `<h4>Key points</h4><ul>${l.keyPoints.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  $('#dRelInput').value = ''; $('#dRelSug').classList.add('hidden');
  renderRelated();
  $('#dCopy').classList.toggle('hidden', !l.copy && !l.page);
  $('#dCopy').textContent = l.page ? 'Open Shelf Page' : 'Open saved copy';
  $('#dTabs [data-tab=copy]').textContent = l.video ? 'Video' : 'Saved copy';
  showTab(l.video || l.copy || l.page ? 'copy' : (detailData.notes || l.notes ? 'notes' : 'content'));
  if (!$('#detail').open) $('#detail').showModal();
  $('#detail .dwrap').scrollTop = 0;
}

function shareBox(l) {
  const s = l.share, live = s && s.expires > Date.now();
  const status = !s ? `Send it to anyone as one file, or as a link that opens in any browser (needs Cloudflare R2, link works for ${7} days).`
    : live ? `Shared. Anyone with the link can view it until ${new Date(s.expires).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}. It shows the page as it was when you shared it, with your edits.`
    : 'The share link has expired. Click Share again for a new one.';
  return `<div class="copybox sharebox"><div><b>Share</b><div class="muted small">${esc(status)}</div>${live ? `<div class="sharelink"><input readonly value="${esc(s.url)}"><button class="ghost" data-share="copy">Copy</button></div>` : ''}</div>
    <div class="row-btns"><button class="ghost" data-share="export">Export file</button><button class="${live ? 'ghost' : 'primary'}" data-share="link">${s ? (live ? 'Update link' : 'Share again') : 'Share link'}</button>${s ? `<button class="ghost" data-share="stop">Stop sharing</button>` : ''}</div></div>`;
}

async function shareAction(what) {
  const l = links.find(x => x.id === detailId); if (!l) return;
  if (what === 'copy') { await window.shelf.copy(l.share.url); toast('Link copied'); return; }
  if (what === 'export') { const r = await window.shelf.exportPage(l.id); if (r.ok) toast('Exported. It opens in any browser, offline.'); else if (!r.canceled) toast(r.error || 'Could not export'); return; }
  if (what === 'stop') { const r = await window.shelf.unsharePage(l.id); toast(r.ok ? 'Stopped sharing. The link no longer works.' : (r.error || 'Could not stop sharing')); return; }
  toast('Uploading…');
  const r = await window.shelf.sharePage(l.id);
  if (r.ok) toast('Link copied. Paste it anywhere to share.');
  else if (r.needR2) { toast('Share links use your Cloudflare R2 (10 GB free). Connect it in Settings, or use Export file.'); }
  else toast(r.error || 'Could not share');
}

function showTab(tab) {
  detailTab = tab;
  $('#dTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const l = links.find(x => x.id === detailId) || {};
  const body = $('#dBody');
  if (tab === 'copy' && l.video) {
    const v = l.video;
    body.innerHTML = `<div class="video-box"><a href="#" class="video-thumb" data-url="${esc(l.url)}"><img src="${esc(ytThumb(l))}" alt="Video thumbnail"><span class="play">▶</span>${v.seconds ? `<span class="dur">${clockOf(v.seconds)}</span>` : ''}</a>
      <div class="video-info"><div><b>${esc(v.channel || '')}</b></div>
        <div class="muted small">${v.transcript ? 'Shelf saved the full transcript' : 'No captions on this video, so Shelf saved its title, description and chapters'}${v.chapters ? ` · ${v.chapters} chapters` : ''}. The AI notes are based on it, and Ask can answer from it.</div>
        <div class="row-btns"><button class="primary" data-url="${esc(l.url)}">Watch on YouTube</button>${v.transcript ? `<button class="ghost" data-showtab="content">Read transcript</button>` : ''}</div></div></div>`;
  }
  else if (tab === 'copy') {
    const kind = !l.copy ? '' : l.copy === 'page.mhtml' ? 'a complete snapshot of the page: layout, images and text exactly as they looked' : l.copy.endsWith('.pdf') ? 'the original document as a PDF, exactly as it looked' : 'the original file';
    const pageBox = l.page ? `<div class="copybox"><div><b>Shelf Page${l.pages > 1 ? ` · ${l.pages} pages` : ''}${l.edited ? ' · your version' : ''}</b><div class="muted small">Shelf’s own editable copy, rebuilt from the ${/notion\./.test(l.url) ? 'page’s' : 'document’s'} real content${l.pages > 1 ? ' including its sub-pages and databases' : ''}. Opens offline. Press Edit inside it to make it your own; the original is always kept.</div></div><button class="primary" data-opencopy="page">Open Shelf Page</button></div>${shareBox(l)}` : '';
    body.innerHTML = pageBox + (l.copy
      ? `<div class="copybox"><div><b>Shelf saved ${kind}${l.archivedAt ? ' on ' + new Date(l.archivedAt).toLocaleString() : ''}.</b><div class="muted small">It opens offline, so you can still see it if the original is deleted, made private or moved.</div></div><button class="${l.page ? 'ghost' : 'primary'}" data-opencopy="snapshot">${l.page ? 'Open snapshot' : 'Open saved copy'}</button></div>` +
        (l.shot ? `<img class="dshot clickable" data-opencopy src="${esc(shotUrl(l))}" alt="Preview of the saved copy">` : '')
      : (l.page ? '' : '<p class="muted">No exact copy was saved for this link. Click Re-read to try again.</p>'));
  }
  else if (tab === 'notes') body.innerHTML = md(detailData.notes || l.notes) || '<p class="muted">No notes yet. Turn on AI in Settings, then click Re-read.</p>';
  else if (tab === 'content') body.innerHTML = detailData.content ? `<p class="muted small">The text Shelf pulled out of this link, used for search. ${detailData.content.length.toLocaleString()} characters.</p>` + md(detailData.content) : '<p class="muted">No saved copy yet.</p>';
  else {
    const files = detailData.files || [];
    body.innerHTML = (l.shot ? `<img class="dshot" src="${esc(shotUrl(l))}" alt="Screenshot">` : '') +
      (files.length ? `<div class="files">${files.map(f => `<div class="file"><div><div>${esc(FILE_LABELS[f.name] || f.name)}</div><div class="muted small">${esc(f.name)} · ${fmtSize(f.size)}</div></div><button class="ghost" data-file="${esc(f.name)}">Open</button></div>`).join('')}</div>` : '<p class="muted">No files saved for this link.</p>');
  }
}

$('#dTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
$('#dBody').addEventListener('click', (e) => {
  const a = e.target.closest('[data-url]'); if (a) { e.preventDefault(); window.shelf.open(a.dataset.url); return; }
  const st = e.target.closest('[data-showtab]'); if (st) { showTab(st.dataset.showtab); return; }
  const f = e.target.closest('[data-file]'); if (f) window.shelf.openFile(detailId, f.dataset.file);
  const oc = e.target.closest('[data-opencopy]'); if (oc) window.shelf.openCopy(detailId, oc.dataset.opencopy || '');
  const sh = e.target.closest('[data-share]'); if (sh) shareAction(sh.dataset.share);
});
$('#dClose').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('click', (e) => { if (e.target === $('#detail')) $('#detail').close(); });
$('#dOpen').addEventListener('click', () => { const l = links.find(x => x.id === detailId); if (l) window.shelf.open(l.url); });
$('#dEdit').addEventListener('click', () => { $('#detail').close(); openEdit(detailId); });
$('#dRedo').addEventListener('click', async () => { await window.shelf.reprocess(detailId); $('#detail').close(); toast('Reading it again…'); });
$('#dCopy').addEventListener('click', () => window.shelf.openCopy(detailId));
$('#dFolder').addEventListener('click', () => window.shelf.showFolder(detailId));

// Settings: sign in for private pages, re-read everything
document.querySelectorAll('[data-signin]').forEach(b => b.addEventListener('click', () => window.shelf.signin(b.dataset.signin)));
$('#sRedoAll').addEventListener('click', async () => { const n = await window.shelf.reprocessAll(); toast(`Re-reading ${n} links in the background`); });

// Keep an open detail view current while a link is being re-read.
window.shelf.onState(async () => { if ($('#detail').open && detailId && links.find(x => x.id === detailId)) { detailData = await window.shelf.detail(detailId); renderRelated(); if (detailTab === 'copy') showTab('copy'); } });
