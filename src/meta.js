// Fetch a page and pull out what it is about: title, description, image, and a slice of visible text.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/\s+/g, ' ').trim();
}

function metaTag(html, keys) {
  for (const key of keys) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) return decode(m[1]);
  }
  return '';
}

function absolute(href, base) {
  try { return href ? new URL(href, base).href : ''; } catch { return ''; }
}

async function fetchMeta(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let html = '', finalUrl = url;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, redirect: 'follow', signal: ctrl.signal });
    finalUrl = res.url || url;
    const type = res.headers.get('content-type') || '';
    if (type.includes('html') || type.includes('xml') || !type) html = (await res.text()).slice(0, 600000);
  } finally { clearTimeout(timer); }

  const host = new URL(finalUrl).hostname.replace(/^www\./, '');
  const title = metaTag(html, ['og:title', 'twitter:title']) || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) || host;
  const description = metaTag(html, ['og:description', 'description', 'twitter:description']);
  const image = absolute(metaTag(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']), finalUrl);
  const iconHref = (html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i) || html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["']/i) || [])[1];
  const favicon = absolute(iconHref, finalUrl) || `https://www.google.com/s2/favicons?domain=${host}&sz=64`;

  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map(m => decode(m[1].replace(/<[^>]+>/g, ' '))).filter(Boolean).slice(0, 12);
  const text = decode(html
    .replace(/<(script|style|noscript|svg|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).slice(0, 2500);

  return { url: finalUrl, host, title, description, image, favicon, headings, text };
}

module.exports = { fetchMeta };
