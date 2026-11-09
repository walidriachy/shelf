// Backup to Cloudflare R2 (S3-compatible storage, 10 GB free).
// Mirrors the library folder to <bucket>/shelf/... and can restore it on another computer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'shelf/';
const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');

// AWS Signature Version 4.
function sign({ method, host, pathname, query = {}, headers = {}, body = '', accessKeyId, secretAccessKey, region = 'auto', service = 's3', date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = headers['x-amz-content-sha256'] || sha256(body);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(h).sort();
  const canonicalQuery = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = [method, encPath(pathname), canonicalQuery, names.map(n => `${n}:${h[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  h.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  delete h.host;
  return { headers: h, signature, canonicalQuery };
}

// A link anyone can open for a limited time (at most 7 days), without making the bucket public.
function presign({ host, pathname, accessKeyId, secretAccessKey, expires = 604800, region = 'auto', service = 's3', date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const query = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${scope}`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(Math.min(604800, expires)), 'X-Amz-SignedHeaders': 'host' };
  const canonicalQuery = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = ['GET', encPath(pathname), canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { url: `https://${host}${encPath(pathname)}?${canonicalQuery}&X-Amz-Signature=${signature}`, signature };
}

function client(cfg) {
  const accountId = String(cfg.r2AccountId || '').trim(), bucket = String(cfg.r2Bucket || '').trim();
  const accessKeyId = String(cfg.r2AccessKeyId || '').trim(), secretAccessKey = String(cfg.r2Secret || '').trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  const host = `${accountId}.r2.cloudflarestorage.com`;

  async function req(method, key, { query = {}, body, contentType } = {}) {
    const pathname = `/${bucket}${key ? '/' + key : ''}`;
    const data = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const headers = contentType ? { 'content-type': contentType } : {};
    const s = sign({ method, host, pathname, query, headers, body: data, accessKeyId, secretAccessKey });
    const url = `https://${host}${encPath(pathname)}${s.canonicalQuery ? '?' + s.canonicalQuery : ''}`;
    const res = await fetch(url, { method, headers: s.headers, body: method === 'PUT' ? data : undefined });
    if (!res.ok && !(method === 'GET' && res.status === 404)) {
      const text = await res.text().catch(() => '');
      const code = (text.match(/<Code>([^<]+)/) || [])[1];
      const msg = { InvalidAccessKeyId: 'R2 access key is wrong', SignatureDoesNotMatch: 'R2 secret key is wrong', NoSuchBucket: `R2 bucket "${bucket}" does not exist`, AccessDenied: 'R2 key has no access to this bucket' }[code];
      throw new Error(msg || `R2 error ${res.status}${code ? ' ' + code : ''}`);
    }
    return res;
  }

  return {
    async list(prefix = PREFIX) {
      const out = new Map();
      let token = '';
      do {
        const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
        const xml = await (await req('GET', '', { query })).text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = decodeXml((m[1].match(/<Key>([^<]*)/) || [])[1] || '');
          const etag = ((m[1].match(/<ETag>([^<]*)/) || [])[1] || '').replace(/&quot;|"/g, '');
          const size = +((m[1].match(/<Size>(\d+)/) || [])[1] || 0);
          out.set(key, { etag, size });
        }
        token = /<IsTruncated>true/.test(xml) ? decodeXml((xml.match(/<NextContinuationToken>([^<]*)/) || [])[1] || '') : '';
      } while (token);
      return out;
    },
    async get(key) { const r = await req('GET', key); return r.status === 404 ? null : Buffer.from(await r.arrayBuffer()); },
    put: (key, body, contentType) => req('PUT', key, { body, contentType }),
    del: (key) => req('DELETE', key),
    link: (key, expires) => presign({ host, pathname: `/${bucket}/${key}`, accessKeyId, secretAccessKey, expires }).url,
  };
}

const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

function walk(dir, base = dir, out = []) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (n.startsWith('.') || n.endsWith('.incoming')) continue;
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// Two-way backup: uploads what's new or changed here, downloads what's missing here, and for link
// records keeps whichever side was edited last. Deleted links have their saved copies removed from R2.
async function backup(store, onProgress = () => {}) {
  const c = client(store.settings());
  if (!c) return { ok: false, message: 'R2 backup is off' };
  const lib = store.libraryDir;
  const remote = await c.list();
  let up = 0, down = 0, removed = 0;

  // 1. Link records: newest wins.
  for (const [key, info] of remote) {
    const m = key.match(/^shelf\/links\/([\w-]+)\.json$/);
    if (!m) continue;
    const local = store.find(m[1]);
    // Same file on both sides: nothing to download (keeps requests well inside R2's free allowance).
    if (local) { try { if (md5(fs.readFileSync(store.linkFile(m[1]))) === info.etag) continue; } catch {} }
    const buf = await c.get(key);
    if (!buf) continue;
    let r; try { r = JSON.parse(buf.toString('utf8')); } catch { continue; }
    if (!local || (r.updatedAt || 0) > (local.updatedAt || 0)) {
      if (local) Object.keys(local).forEach(k => delete local[k]);
      if (local) Object.assign(local, r); else store.data.links.push(r);
      store.writeLink(local || r);
      if (r.deleted) fs.rmSync(path.join(lib, 'archive', r.id.replace(/[^\w-]/g, '')), { recursive: true, force: true });
      down++;
    }
  }
  let remoteCats = null;
  const catInfo = remote.get(PREFIX + 'categories.json');
  try { if (catInfo && md5(fs.readFileSync(path.join(lib, 'categories.json'))) !== catInfo.etag) remoteCats = await c.get(PREFIX + 'categories.json'); } catch {}
  if (remoteCats) { try { for (const cat of JSON.parse(remoteCats.toString('utf8'))) store.addCategory(cat); } catch {} }

  // 2. Saved copies: download missing ones for live links, remove ones for deleted links.
  const deleted = new Set(store.data.links.filter(l => l.deleted).map(l => l.id));
  const live = new Set(store.data.links.filter(l => !l.deleted).map(l => l.id));
  for (const [key] of remote) {
    const m = key.match(/^shelf\/archive\/([\w-]+)\/(.+)$/);
    if (!m) continue;
    if (deleted.has(m[1])) { await c.del(key); remote.delete(key); removed++; continue; }
    const file = path.join(lib, 'archive', m[1], ...m[2].split('/'));
    if (live.has(m[1]) && !fs.existsSync(file)) {
      const buf = await c.get(key);
      if (buf) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); down++; onProgress(`Restoring ${down}`); }
    }
  }

  // 3. Upload everything that's new or changed here.
  const files = walk(lib).filter(f => {
    const m = f.match(/^archive\/([\w-]+)\//);
    return f === 'categories.json' || f.startsWith('links/') || (m && !deleted.has(m[1]));
  });
  for (const rel of files) {
    const key = PREFIX + rel;
    const buf = fs.readFileSync(path.join(lib, ...rel.split('/')));
    const r = remote.get(key);
    if (r && r.size === buf.length && r.etag === md5(buf)) continue;
    await c.put(key, buf, contentType(rel));
    up++;
    onProgress(`Backing up ${up}`);
  }

  store.setSettings({ r2LastBackup: Date.now() });
  const parts = [];
  if (up) parts.push(`${up} uploaded`);
  if (down) parts.push(`${down} restored`);
  if (removed) parts.push(`${removed} removed`);
  return { ok: true, changed: down > 0, message: `Backed up to R2${parts.length ? ' (' + parts.join(', ') + ')' : ', all up to date'}` };
}

function contentType(f) {
  const ext = path.extname(f).toLowerCase();
  return { '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.png': 'image/png', '.mhtml': 'multipart/related', '.csv': 'text/csv' }[ext] || 'application/octet-stream';
}

// ---- One-token setup ----------------------------------------------------------------------------
// Cloudflare lets S3 keys be derived from an API token: Access Key ID = the token's id,
// Secret Access Key = SHA-256 of the token value. So the user pastes one token and Shelf does the rest.
const CF = 'https://api.cloudflare.com/client/v4';
const BUCKET = 'shelf-backup';

async function cf(token, method, p, body) {
  const res = await fetch(CF + p, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.success !== false, status: res.status, json, error: (json.errors && json.errors[0]) || {} };
}

// The link that opens Cloudflare's "Create API token" page with R2 access and the name filled in.
const TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens?' + new URLSearchParams({
  permissionGroupKeys: JSON.stringify([{ key: 'workers_r2', type: 'edit' }]),
  accountId: '*', zoneId: 'all', name: 'Shelf backup',
}).toString().replace(/\+/g, '%20');

async function connect(rawToken, accountIdHint = '', onStep = () => {}) {
  const token = String(rawToken || '').trim();
  if (!token) throw new Error('Paste the token from Cloudflare first');

  onStep('Checking token…');
  // Find the account(s) this token can see, then which kind of token it is (personal or account-owned).
  let accounts = [];
  const a = await cf(token, 'GET', '/accounts?per_page=50');
  if (a.ok) accounts = (a.json.result || []).map(x => x.id);
  if (accountIdHint) accounts = [String(accountIdHint).trim(), ...accounts.filter(x => x !== accountIdHint)];

  let tokenId = '';
  const u = await cf(token, 'GET', '/user/tokens/verify');
  if (u.ok) tokenId = u.json.result.id;
  else for (const acc of accounts) {
    const v = await cf(token, 'GET', `/accounts/${acc}/tokens/verify`);
    if (v.ok) { tokenId = v.json.result.id; accounts = [acc]; break; }
  }
  if (!tokenId) throw new Error('Cloudflare did not accept this token. Copy it again (it is shown only once after you press Create).');
  if (u.ok && u.json.result.status && u.json.result.status !== 'active') throw new Error(`This token is ${u.json.result.status}`);
  if (!accounts.length) { const e = new Error('Shelf could not see your Cloudflare account. Paste your Account ID (R2 overview page, right side).'); e.needAccount = true; throw e; }

  onStep('Creating bucket…');
  let accountId = '', lastErr = '';
  for (const acc of accounts) {
    const b = await cf(token, 'POST', `/accounts/${acc}/r2/buckets`, { name: BUCKET });
    const exists = b.status === 409 || /exist/i.test(b.error.message || '');
    if (b.ok || exists) { accountId = acc; break; }
    lastErr = b.error.code === 10042 || /enable r2|not enabled|purchase/i.test(b.error.message || '')
      ? 'R2 is not turned on for this Cloudflare account yet. Open R2 in the Cloudflare dashboard once and turn it on (it asks for a card; under 10 GB is free).'
      : (b.status === 403 || b.error.code === 10000) ? 'This token has no R2 permission. Create it again with "Workers R2 Storage: Edit".'
      : (b.error.message || `Cloudflare error ${b.status}`);
  }
  if (!accountId) throw new Error(lastErr || 'Could not create the bucket');

  const cfg = { r2On: true, r2AccountId: accountId, r2Bucket: BUCKET, r2AccessKeyId: tokenId, r2Secret: sha256(token) };

  // New keys can take a few seconds to work everywhere.
  onStep('Connecting…');
  const c = client(cfg);
  for (let i = 0; i < 6; i++) {
    try { await c.list(); return cfg; }
    catch (e) { if (i === 5) throw e; await new Promise(r => setTimeout(r, 2500)); }
  }
  return cfg;
}

module.exports = { presign, sign, client, backup, connect, TOKEN_URL, BUCKET };
