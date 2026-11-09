// Shelf Pages: Shelf's own, Notion-style copy of a Notion page.
// While the page is open in the reader, Shelf asks Notion for the page's real structure (every block,
// sub-page and database row), downloads every image, and builds a small offline website from it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PAGES = 40;      // sub-pages followed per link (templates are often a page with a few sub-pages)
const MAX_ROWS = 300;      // database rows kept per database

// Runs inside the Notion page (same origin, same sign-in) and returns the raw record map.
function captureScript(rootId) {
  return `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const post = async (ep, body) => {
    for (let i = 0; ; i++) {
      const r = await fetch('/api/v3/' + ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) return r.json();
      if ((r.status === 429 || r.status >= 500) && i < 6) { await sleep(Number(r.headers.get('retry-after')) * 1000 || 1500 * (i + 1)); continue; }
      throw new Error(ep + ' ' + r.status);
    }
  };
  const unwrap = (x) => (x && x.value && x.value.value && x.value.value.id) ? x.value.value : (x && x.value && x.value.id ? x.value : null);
  const out = { block: {}, collection: {}, collection_view: {}, rows: {}, spaceId: '' };
  const add = (rm) => { if (!rm) return; for (const t of ['block', 'collection', 'collection_view']) for (const [id, rec] of Object.entries(rm[t] || {})) { const v = unwrap(rec); if (v) out[t][id] = v; } };
  const loadPage = async (id) => {
    let cursor = { stack: [] }, n = 0;
    do {
      const r = await post('loadPageChunk', { pageId: id, limit: 100, cursor, chunkNumber: n++, verticalColumns: false });
      add(r.recordMap); cursor = r.cursor;
    } while (cursor && cursor.stack && cursor.stack.length && n < 30);
  };
  const space = () => out.spaceId || (Object.values(out.block)[0] || {}).space_id;
  const missing = () => { const need = new Set(); for (const b of Object.values(out.block)) for (const c of (b.content || [])) if (!out.block[c]) need.add(c); return [...need]; };
  const fill = async () => {
    for (let round = 0; round < 6; round++) {
      const need = missing(); if (!need.length) break;
      let got = 0;
      for (let i = 0; i < need.length; i += 100) {
        try {
          const r = await post('syncRecordValues', { requests: need.slice(i, i + 100).map(id => ({ pointer: { table: 'block', id, spaceId: space() }, version: -1 })) });
          add(r.recordMap); got++;
        } catch (e) {}
      }
      if (!got) break;
    }
  };
  const root = '${rootId}';
  const queue = [root], seen = new Set();
  let pages = 0;
  while (queue.length && pages < ${MAX_PAGES}) {
    const id = queue.shift(); if (seen.has(id)) continue; seen.add(id); pages++;
    try { await loadPage(id); } catch (e) { if (id === root) throw e; continue; }
    await fill();
    // Databases on this page: load their rows.
    for (const b of Object.values(out.block)) {
      if (!/^collection_view/.test(b.type) || b.__rows) continue;
      b.__rows = true;
      const cid = b.collection_id || (b.format && b.format.collection_pointer && b.format.collection_pointer.id);
      const vid = (b.view_ids || [])[0];
      if (!cid || !vid) continue;
      out.spaceId = out.spaceId || b.space_id;
      try {
        const r = await post('queryCollection', { collection: { id: cid, spaceId: b.space_id }, collectionView: { id: vid, spaceId: b.space_id },
          loader: { type: 'reducer', reducers: { collection_group_results: { type: 'results', limit: ${MAX_ROWS} } }, searchQuery: '', userTimeZone: 'UTC' } });
        add(r.recordMap);
        out.rows[cid] = ((r.result && r.result.reducerResults && r.result.reducerResults.collection_group_results) || {}).blockIds || [];
      } catch (e) {}
      if (!out.collection[cid] || !out.collection_view[vid]) {
        try { const r = await post('syncRecordValues', { requests: [{ pointer: { table: 'collection', id: cid, spaceId: b.space_id }, version: -1 }, ...(b.view_ids || []).map(v => ({ pointer: { table: 'collection_view', id: v, spaceId: b.space_id }, version: -1 }))] }); add(r.recordMap); } catch (e) {}
      }
    }
    // Follow sub-pages that live inside this page (not links to other pages elsewhere).
    for (const b of Object.values(out.block)) if (b.type === 'page' && !seen.has(b.id) && (b.parent_id === id || out.block[b.parent_id]) && b.alive !== false) queue.push(b.id);
  }
  for (const b of Object.values(out.block)) { delete b.__rows; delete b.crdt_data; out.spaceId = out.spaceId || b.space_id; }
  return { root, pages, spaceId: out.spaceId, block: out.block, collection: out.collection, collection_view: out.collection_view, rows: out.rows, origin: location.origin };
})()`;
}

function pageIdFrom(url) {
  const m = String(url).replace(/-/g, '').match(/([0-9a-f]{32})(?![0-9a-f])/i);
  if (!m) return '';
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- Images -----------------------------------------------------------------------------------------

function imageSources(rm) {
  const list = [];
  for (const b of Object.values(rm.block)) {
    const f = b.format || {}, p = b.properties || {};
    if (['image', 'video', 'file', 'pdf', 'audio'].includes(b.type) || b.type === 'image') {
      const src = f.display_source || (p.source && p.source[0] && p.source[0][0]);
      if (src && b.type === 'image') list.push({ id: b.id, src, kind: 'block' });
    }
    if (f.page_cover) list.push({ id: b.id, src: f.page_cover, kind: 'cover' });
    if (f.page_icon && !isEmoji(f.page_icon)) list.push({ id: b.id, src: f.page_icon, kind: 'icon' });
    if (b.type === 'bookmark' && f.bookmark_cover) list.push({ id: b.id, src: f.bookmark_cover, kind: 'bookmark' });
  }
  return list;
}
const isEmoji = (s) => !/^(https?:|\/|attachment:)/.test(String(s || ''));

// Where to download an image from, best first.
function imageUrls(src, blockId, rm) {
  if (/^\/images\//.test(src)) return [rm.origin + src, 'https://www.notion.so' + src];   // Notion's built-in covers and icons
  const b = rm.block[blockId] || {};
  const table = b.parent_table === 'collection' && b.type !== 'page' ? 'block' : 'block';
  const proxy = (host, space) => `${host}/image/${encodeURIComponent(src)}?table=${table}&id=${blockId}${space ? `&spaceId=${space}` : ''}&width=2000&cache=v2`;
  const viaNotion = [proxy(rm.origin, b.space_id), proxy(rm.origin), proxy('https://www.notion.so', b.space_id), proxy('https://www.notion.so')];
  if (/^https?:\/\//.test(src) && !/amazonaws\.com|notion-static|notion\.so\/image|notion\.site\/image/.test(src)) return [src, ...viaNotion];
  return viaNotion;
}

// Downloads every image into notion/img/ and returns a map of source → local file name.
async function downloadImages(rm, dir, fetcher) {
  const imgDir = path.join(dir, 'img');
  fs.mkdirSync(imgDir, { recursive: true });
  const map = {};
  const jobs = imageSources(rm);
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      const key = j.src;
      if (map[key] !== undefined) continue;
      map[key] = '';
      try {
        let r = null;
        for (const u of imageUrls(j.src, j.id, rm)) {
          try { r = await fetcher(u); } catch { r = null; }
          if (r && r.ok && r.buf.length && /image|octet/.test(r.type)) break;
          r = null;
        }
        if (!r) continue;
        const ext = (r.type.match(/image\/(png|jpe?g|gif|webp|svg)/) || [])[1] || (path.extname(String(j.src).split('?')[0]).slice(1) || 'img');
        const name = crypto.createHash('md5').update(key).digest('hex').slice(0, 16) + '.' + ext.replace('jpeg', 'jpg').replace('svg', 'svg');
        fs.writeFileSync(path.join(imgDir, name), r.buf);
        map[key] = 'img/' + name;
      } catch {}
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return map;
}

// ---- HTML -------------------------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Only real web links: anything else (javascript:, data:, …) becomes a dead link.
const safe = (u) => { u = String(u || '').trim(); return /^(https?:|mailto:)/i.test(u) ? esc(u) : '#'; };
const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
const colorClass = (c) => { if (!c || c === 'default') return ''; const [name, bg] = String(c).split('_'); return COLORS.includes(name) ? (bg ? ` bg-${name}` : ` c-${name}`) : ''; };

class Site {
  constructor(rm, images) {
    this.rm = rm; this.images = images;
    this.pageIds = new Set(Object.values(rm.block).filter(b => b.type === 'page' || b.type === 'collection_view_page').map(b => b.id));
  }
  b(id) { return this.rm.block[id]; }
  img(src) { return this.images[src] || ''; }
  file(id) { return id === this.rm.root ? 'index.html' : `p-${id.replace(/-/g, '').slice(0, 12)}.html`; }
  hasPage(id) { return !!(this.rm.block[id] && this.rm.block[id].content) || id === this.rm.root; }
  title(b) { return plain(b && b.properties && b.properties.title) || 'Untitled'; }

  rich(runs) {
    if (!runs) return '';
    return runs.map(([text, decos]) => {
      let h = esc(text);
      for (const d of decos || []) {
        const [t, v] = d;
        if (t === 'b') h = `<b>${h}</b>`;
        else if (t === 'i') h = `<i>${h}</i>`;
        else if (t === 's') h = `<s>${h}</s>`;
        else if (t === '_') h = `<u>${h}</u>`;
        else if (t === 'c') h = `<code>${h}</code>`;
        else if (t === 'h') h = `<span class="${colorClass(v).trim()}">${h}</span>`;
        else if (t === 'a') h = `<a href="${v && v.startsWith('/') ? safe(this.rm.origin + v) : safe(v)}" class="link">${h}</a>`;
        else if (t === 'e') h = `<span class="eq">${esc(v)}</span>`;
        else if (t === 'p') { const pb = this.b(v); h = pb ? `<a class="mention" href="${this.hasPage(v) ? this.file(v) : '#'}">${this.icon(pb, 'mi')}${esc(this.title(pb))}</a>` : '<span class="mention">Page</span>'; }
        else if (t === 'd') h = `<span class="date">@${esc(fmtDate(v))}</span>`;
        else if (t === 'u') h = '<span class="mention">@person</span>';
      }
      return h;
    }).join('');
  }

  icon(b, cls = 'icon') {
    const ic = b && b.format && b.format.page_icon;
    if (!ic) return '';
    if (isEmoji(ic)) return `<span class="${cls}">${esc(ic)}</span>`;
    const f = this.img(ic);
    return f ? `<img class="${cls} img" src="${f}" alt="">` : '';
  }

  children(ids, depth = 0) {
    let html = '', list = null, num = 0;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    for (const id of ids || []) {
      const b = this.b(id);
      if (!b || b.alive === false) continue;
      const kind = b.type === 'bulleted_list' ? 'ul' : b.type === 'numbered_list' ? 'ol' : null;
      if (kind !== list) { close(); if (kind) { html += kind === 'ol' ? `<ol start="1">` : '<ul>'; list = kind; num = 0; } }
      html += this.block(b, depth);
    }
    close();
    return html;
  }

  block(b, depth) {
    const p = b.properties || {}, f = b.format || {};
    const col = colorClass(f.block_color);
    const kids = () => (b.content && b.content.length ? this.children(b.content, depth + 1) : '');
    const T = this.rich(p.title);
    switch (b.type) {
      case 'text': return `<div class="text${col}">${T || '&nbsp;'}</div>${kids() ? `<div class="indent">${kids()}</div>` : ''}`;
      case 'header': return `<h1 class="h${col}" id="b${b.id}">${T}</h1>`;
      case 'sub_header': return `<h2 class="h${col}" id="b${b.id}">${T}</h2>`;
      case 'sub_sub_header': return `<h3 class="h${col}" id="b${b.id}">${T}</h3>`;
      case 'header_4': return `<h4 class="h${col}" id="b${b.id}">${T}</h4>`;
      case 'external_object_instance': {
        const uri = f.uri || '', name = ((f.attributes || []).find(a => a.id === 'title') || {}).values?.[0] || uri;
        return `<a class="embed" href="${safe(uri)}"><span class="eicon">🔗</span><span>${esc(name)}</span><span class="etype">${esc(f.domain || '')}</span></a>`;
      }
      case 'bulleted_list': case 'numbered_list': return `<li class="${col.trim()}">${T}${kids()}</li>`;
      case 'to_do': { const done = plain(p.checked) === 'Yes'; return `<div class="todo${done ? ' done' : ''}${col}"><span class="box">${done ? '✓' : ''}</span><span class="tt">${T}</span></div>${kids() ? `<div class="indent">${kids()}</div>` : ''}`; }
      case 'toggle': return `<details class="toggle${col}"><summary>${T}</summary><div class="indent">${kids()}</div></details>`;
      case 'quote': return `<blockquote class="${col.trim()}">${T}${kids()}</blockquote>`;
      case 'callout': return `<div class="callout${col || ' bg-gray'}">${this.icon(b, 'cicon') || '<span class="cicon">💡</span>'}<div class="cbody">${T ? `<div>${T}</div>` : ''}${kids()}</div></div>`;
      case 'divider': return '<hr>';
      case 'code': return `<div class="code"><div class="lang">${esc(plain(p.language) || '')}</div><pre><code>${esc(plain(p.title))}</code></pre>${p.caption ? `<div class="caption">${this.rich(p.caption)}</div>` : ''}</div>`;
      case 'equation': return `<div class="equation">${esc(plain(p.title))}</div>`;
      case 'image': {
        const src = f.display_source || plain(p.source);
        const file = this.img(src);
        const w = f.block_full_width ? '100%' : (f.block_width ? Math.min(f.block_width, 900) + 'px' : '100%');
        return `<figure class="image" style="max-width:${w}">${file ? `<img src="${file}" alt="">` : `<div class="missing">Image not available</div>`}${p.caption ? `<figcaption>${this.rich(p.caption)}</figcaption>` : ''}</figure>`;
      }
      case 'bookmark': {
        const link = plain(p.link), cover = this.img(f.bookmark_cover);
        return `<a class="bookmark" href="${safe(link)}"><div class="bm-text"><div class="bm-title">${esc(plain(p.title) || link)}</div><div class="bm-desc">${esc(plain(p.description))}</div><div class="bm-url">${esc(link)}</div></div>${cover ? `<img src="${cover}" alt="">` : ''}</a>`;
      }
      case 'video': case 'embed': case 'figma': case 'tweet': case 'maps': case 'gist': case 'codepen': case 'drive': case 'audio': case 'pdf': case 'file': case 'typeform': case 'excalidraw': case 'loom': {
        const src = f.display_source || plain(p.source);
        const name = plain(p.title) || src;
        return `<a class="embed" href="${safe(src)}"><span class="eicon">${b.type === 'video' ? '▶' : b.type === 'file' || b.type === 'pdf' ? '📄' : '🔗'}</span><span>${esc(name)}</span><span class="etype">${esc(b.type)}</span></a>`;
      }
      case 'column_list': return `<div class="columns">${(b.content || []).map(cid => { const c = this.b(cid); if (!c) return ''; const r = (c.format && c.format.column_ratio) || 1 / (b.content.length || 1); return `<div class="column" style="flex:${r}">${this.children(c.content, depth + 1)}</div>`; }).join('')}</div>`;
      case 'column': return this.children(b.content, depth + 1);
      case 'table': return this.simpleTable(b);
      case 'table_of_contents': return this.toc(b);
      case 'page': return `<a class="pagelink" href="${this.hasPage(b.id) ? this.file(b.id) : '#'}">${this.icon(b, 'picon') || '<span class="picon">📄</span>'}<span>${this.rich(p.title) || 'Untitled'}</span></a>`;
      case 'link_to_page': case 'alias': { const id = (f.alias_pointer && f.alias_pointer.id) || (p.title && (p.title[0][1] || []).find(d => d[0] === 'p')?.[1]); const t = this.b(id); return t ? `<a class="pagelink" href="${this.hasPage(id) ? this.file(id) : '#'}">${this.icon(t, 'picon') || '<span class="picon">↗</span>'}<span>${esc(this.title(t))}</span></a>` : ''; }
      case 'transclusion_container': return kids();
      case 'transclusion_reference': { const id = f.transclusion_reference_pointer && f.transclusion_reference_pointer.id; const t = this.b(id); return t ? this.children(t.content, depth) : ''; }
      case 'collection_view': case 'collection_view_page': return this.collection(b);
      case 'breadcrumb': return '';
      case 'button': return `<div class="text"><span class="btn">${T || 'Button'}</span></div>`;
      default: return T ? `<div class="text">${T}</div>${kids()}` : kids();
    }
  }

  simpleTable(b) {
    const f = b.format || {};
    const order = f.table_block_column_order || [];
    const rows = (b.content || []).map(id => this.b(id)).filter(Boolean);
    const head = f.table_block_column_header, side = f.table_block_row_header;
    return `<div class="tablewrap"><table class="simple">${rows.map((r, i) => `<tr>${order.map((c, j) => { const tag = (head && i === 0) || (side && j === 0) ? 'th' : 'td'; return `<${tag}>${this.rich((r.properties || {})[c])}</${tag}>`; }).join('')}</tr>`).join('')}</table></div>`;
  }

  toc(b) {
    const page = this.pageOf(b);
    if (!page) return '';
    const heads = [];
    const walk = (ids) => { for (const id of ids || []) { const x = this.b(id); if (!x) continue; if (/^(header|sub_header|sub_sub_header)$/.test(x.type)) heads.push(x); if (x.type === 'column_list' || x.type === 'column') walk(x.content); } };
    walk(page.content);
    return `<div class="toc">${heads.map(h => `<a class="lvl${h.type === 'header' ? 1 : h.type === 'sub_header' ? 2 : 3}" href="#b${h.id}">${esc(plain(h.properties && h.properties.title))}</a>`).join('')}</div>`;
  }
  pageOf(b) { let x = b, n = 0; while (x && x.type !== 'page' && n++ < 50) x = this.b(x.parent_id); return x; }

  // Databases: table, board, gallery and list views. Calendars and timelines show as a table.
  collection(b) {
    const cid = b.collection_id || (b.format && b.format.collection_pointer && b.format.collection_pointer.id);
    const coll = this.rm.collection[cid];
    const view = this.rm.collection_view[(b.view_ids || [])[0]] || {};
    const rows = (this.rm.rows[cid] || []).map(id => this.b(id)).filter(r => r && r.alive !== false);
    const name = coll ? plain(coll.name) : '';
    if (!coll) return `<div class="db"><div class="dbtitle">${esc(name || 'Database')}</div><div class="missing">This database could not be read.</div></div>`;
    const schema = coll.schema || {};
    const vf = view.format || {};
    const propsList = (vf.table_properties || vf.board_properties || vf.gallery_properties || vf.list_properties || []).filter(x => x.visible !== false).map(x => x.property);
    const cols = ['title', ...(propsList.length ? propsList : Object.keys(schema)).filter(k => k !== 'title' && schema[k])];
    const vname = view.name || (view.type || 'table');
    let body;
    if (view.type === 'board') body = this.board(rows, schema, cols, view);
    else if (view.type === 'gallery') body = `<div class="gallery">${rows.map(r => this.card(r, schema, cols, view)).join('')}</div>`;
    else if (view.type === 'list') body = `<div class="dblist">${rows.map(r => `<a class="dbrow" href="${this.hasPage(r.id) ? this.file(r.id) : '#'}">${this.icon(r, 'picon') || '<span class="picon">📄</span>'}<span class="rt">${esc(this.title(r))}</span><span class="rp">${cols.slice(1).map(c => this.cell(r, c, schema[c])).filter(Boolean).join(' ')}</span></a>`).join('')}</div>`;
    else body = `<div class="tablewrap"><table class="db-table"><colgroup>${cols.map(c => { const w = ((vf.table_properties || []).find(x => x.property === c) || {}).width || (c === 'title' ? 260 : 160); return `<col style="width:${w}px">`; }).join('')}</colgroup><thead><tr>${cols.map(c => `<th>${esc(schema[c] ? schema[c].name : c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => c === 'title' ? `<td class="tcell"><a href="${this.hasPage(r.id) ? this.file(r.id) : '#'}">${this.icon(r, 'mi')}${esc(this.title(r))}</a></td>` : `<td>${this.cell(r, c, schema[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    return `<div class="db">${name ? `<div class="dbtitle">${this.icon(coll, 'mi')}${esc(name)}</div>` : ''}<div class="dbview">${esc(vname)}</div>${body}</div>`;
  }
  board(rows, schema, cols, view) {
    const by = (view.format && (view.format.board_columns_by && view.format.board_columns_by.property)) || (view.query2 && view.query2.group_by) || Object.keys(schema).find(k => schema[k].type === 'select' || schema[k].type === 'status');
    const groups = new Map();
    for (const r of rows) { const v = plain((r.properties || {})[by]) || 'No ' + ((schema[by] && schema[by].name) || 'group'); if (!groups.has(v)) groups.set(v, []); groups.get(v).push(r); }
    return `<div class="board">${[...groups].map(([g, rs]) => `<div class="bcol"><div class="bhead">${this.chip(g, schema[by])} <span class="count">${rs.length}</span></div>${rs.map(r => this.card(r, schema, cols.filter(c => c !== by), view)).join('')}</div>`).join('')}</div>`;
  }
  card(r, schema, cols, view) {
    const cover = r.format && r.format.page_cover ? this.img(r.format.page_cover) : '';
    let img = cover;
    if (!img && view.type === 'gallery') { const first = (r.content || []).map(id => this.b(id)).find(x => x && x.type === 'image'); if (first) img = this.img((first.format || {}).display_source || plain((first.properties || {}).source)); }
    return `<a class="card" href="${this.hasPage(r.id) ? this.file(r.id) : '#'}">${img ? `<img src="${img}" alt="">` : ''}<div class="ct">${this.icon(r, 'mi')}${esc(this.title(r))}</div>${cols.slice(1).map(c => this.cell(r, c, schema[c])).filter(Boolean).map(x => `<div class="cp">${x}</div>`).join('')}</a>`;
  }
  chip(value, prop) {
    const opt = prop && (prop.options || []).find(o => o.value === value);
    return `<span class="chip${opt ? ' chip-' + (opt.color || 'default') : ''}">${esc(value)}</span>`;
  }
  cell(r, key, prop) {
    const v = (r.properties || {})[key];
    if (!prop || !v) return '';
    switch (prop.type) {
      case 'select': case 'status': return this.chip(plain(v), prop);
      case 'multi_select': return plain(v).split(',').filter(Boolean).map(x => this.chip(x.trim(), prop)).join(' ');
      case 'checkbox': return plain(v) === 'Yes' ? '☑' : '☐';
      case 'url': return `<a href="${safe(plain(v))}" class="link">${esc(plain(v))}</a>`;
      case 'date': return this.rich(v);
      case 'relation': return v.filter(x => x[1]).map(x => { const id = (x[1].find(d => d[0] === 'p') || [])[1]; const t = this.b(id); return t ? `<a class="mention" href="${this.hasPage(id) ? this.file(id) : '#'}">${esc(this.title(t))}</a>` : ''; }).join(' ');
      case 'file': return v.filter(x => x[0] && x[0] !== ',').map(x => `<span class="chip">${esc(x[0])}</span>`).join(' ');
      default: return this.rich(v);
    }
  }

  page(b, crumbs) {
    const f = b.format || {};
    const cover = f.page_cover ? this.img(f.page_cover) : '';
    const pos = f.page_cover_position != null ? (1 - f.page_cover_position) * 100 : 50;
    const isDbRow = b.parent_table === 'collection';
    let props = '';
    if (isDbRow) {
      const coll = this.rm.collection[b.parent_id];
      const schema = (coll && coll.schema) || {};
      props = `<div class="props">${Object.keys(schema).filter(k => k !== 'title' && (b.properties || {})[k]).map(k => `<div class="prop"><span class="pn">${esc(schema[k].name)}</span><span class="pv">${this.cell(b, k, schema[k])}</span></div>`).join('')}</div>`;
    }
    const body = b.type === 'collection_view_page' ? this.collection(b) : this.children(b.content);
    const iconHtml = this.icon(b, 'pageicon');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(this.title(b))}</title><link rel="stylesheet" href="shelf-page.css"></head>
<body class="${f.page_full_width ? 'full' : ''} ${f.page_font ? 'font-' + esc(f.page_font) : ''} ${f.page_small_text ? 'small' : ''}">
<nav class="crumbs">${crumbs.map(c => `<a href="${this.file(c.id)}">${this.icon(c, 'mi')}${esc(this.title(c))}</a>`).join('<span>/</span>')}</nav>
${cover ? `<div class="cover" style="background-image:url('${cover}');background-position:center ${pos}%"></div>` : ''}
<main class="page${cover ? ' has-cover' : ''}${iconHtml ? ' has-icon' : ''}">
${iconHtml}
<h1 class="title">${this.rich((b.properties || {}).title) || 'Untitled'}</h1>
${props}
<div class="content">${body}</div>
</main>
<footer class="shelf-foot">Saved by Shelf · a copy of a Notion page</footer>
</body></html>`;
  }

  crumbs(b) {
    const out = [];
    let x = this.b(b.parent_id), n = 0;
    while (x && n++ < 20) {
      if ((x.type === 'page' || x.type === 'collection_view_page') && this.hasPage(x.id)) out.unshift(x);
      x = x.parent_table === 'collection' ? this.parentOfCollection(x.parent_id) : this.b(x.parent_id);
    }
    return out;
  }
  parentOfCollection(cid) { const c = this.rm.collection[cid]; return c ? this.b(c.parent_id) : null; }
}

function plain(runs) { return (runs || []).map(r => r[0]).join(''); }
function fmtDate(d) { if (!d) return ''; const s = d.start_date || ''; return d.end_date ? `${s} → ${d.end_date}` : s; }

// Builds the site into `dir` (index.html + one file per sub-page). Returns the number of pages written.
function build(rm, images, dir) {
  const site = new Site(rm, images);
  let n = 0;
  for (const b of Object.values(rm.block)) {
    if (!(b.type === 'page' || b.type === 'collection_view_page')) continue;
    if (b.id !== rm.root && !b.content && b.type === 'page') continue;  // rows/pages we only know the title of
    fs.writeFileSync(path.join(dir, site.file(b.id)), site.page(b, b.id === rm.root ? [] : site.crumbs(b)));
    n++;
  }
  fs.copyFileSync(path.join(__dirname, 'shelf-page.css'), path.join(dir, 'shelf-page.css'));
  fs.writeFileSync(path.join(dir, '.built'), String(BUILD));
  return n;
}

// Bring an older Shelf Page up to date with the current look, from the data saved with it.
// Pages you edited (*.mine.html) are never touched.
const BUILD = 2;
function refresh(dir) {
  try {
    fs.copyFileSync(path.join(__dirname, 'shelf-page.css'), path.join(dir, 'shelf-page.css'));
    if (+(fs.readFileSync(path.join(dir, '.built'), 'utf8') || 0) >= BUILD) return;
  } catch {}
  try {
    const rm = JSON.parse(fs.readFileSync(path.join(dir, 'page.json'), 'utf8'));
    const files = fs.existsSync(path.join(dir, 'img')) ? fs.readdirSync(path.join(dir, 'img')) : [];
    const images = {};
    for (const j of imageSources(rm)) {
      const h = crypto.createHash('md5').update(j.src).digest('hex').slice(0, 16);
      const f = files.find(x => x.startsWith(h + '.'));
      if (f) images[j.src] = 'img/' + f;
    }
    build(rm, images, dir);
  } catch {}
}

// The whole capture as Markdown-ish text (used when the rendered page text came out short).
function allText(rm) {
  const lines = [];
  const walk = (ids, depth) => {
    for (const id of ids || []) {
      const b = rm.block[id]; if (!b) continue;
      const t = plain(b.properties && b.properties.title);
      const pre = { header: '# ', sub_header: '## ', sub_sub_header: '### ', bulleted_list: '- ', numbered_list: '1. ', to_do: '- [ ] ', quote: '> ' }[b.type] || '';
      if (b.type === 'page' && depth > 0) { lines.push(`\n## ${t}`); continue; }
      if (t) lines.push(b.type === 'code' ? '```\n' + t + '\n```' : pre + t);
      if (b.type !== 'page') walk(b.content, depth + 1);
    }
  };
  const root = rm.block[rm.root];
  if (root) { lines.push('# ' + plain(root.properties && root.properties.title)); walk(root.content, 1); }
  return lines.join('\n');
}

// Text of the sub-pages and database rows (the main page's text is already in content.md), for search.
function extraText(rm) {
  const pageOf = (b) => { let x = b, n = 0; while (x && n++ < 60) { if (x.type === 'page' || x.type === 'collection_view_page') return x.id; x = rm.block[x.parent_id]; } return rm.root; };
  const lines = [];
  for (const b of Object.values(rm.block)) {
    if (pageOf(b) === rm.root && b.type !== 'page') continue;
    const t = plain(b.properties && b.properties.title);
    if (t) lines.push(b.type === 'page' ? `\n## ${t}` : t);
  }
  for (const c of Object.values(rm.collection)) lines.push(`\n## ${plain(c.name)} (database)`);
  return lines.join('\n');
}

// The page's own title (the browser tab title is sometimes just "Notion").
function pageTitle(rm) { const b = rm && rm.block && rm.block[rm.root]; return plain(b && b.properties && b.properties.title).trim(); }

module.exports = { captureScript, pageIdFrom, downloadImages, build, refresh, extraText, allText, pageTitle };
