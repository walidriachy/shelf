const { findClaude, runClaude } = require('./claude');

// Sorting and searching. Uses a Replicate-hosted model when a token is set,
// and falls back to simple keyword rules so the app still works without one.

const KEYWORDS = {
  'AI': ['ai', 'artificial intelligence', 'llm', 'gpt', 'claude', 'model', 'machine learning', 'neural', 'agent', 'prompt', 'chatbot', 'generative', 'diffusion', 'openai', 'anthropic', 'replicate', 'hugging face'],
  'Design': ['design', 'ui', 'ux', 'figma', 'typography', 'font', 'color', 'palette', 'icon', 'illustration', 'landing page', 'portfolio', 'branding', 'logo', 'mockup', 'interface', 'layout', 'website design', 'web design', 'gradient', 'animation'],
  'Development': ['code', 'developer', 'github', 'api', 'sdk', 'framework', 'javascript', 'typescript', 'python', 'react', 'library', 'open source', 'database', 'deploy', 'devops', 'npm', 'cli'],
  'Skills & Learning': ['learn', 'course', 'tutorial', 'guide', 'lesson', 'skill', 'academy', 'bootcamp', 'class', 'teach', 'roadmap', 'certificate', 'how to'],
  'Tools': ['tool', 'app', 'productivity', 'generator', 'converter', 'extension', 'plugin', 'saas', 'free', 'online', 'workflow', 'automation'],
  'Inspiration': ['inspiration', 'gallery', 'showcase', 'awards', 'curated', 'collection', 'best', 'examples', 'awwwards', 'dribbble', 'behance'],
};

// Words people type that map to words pages use.
const SYNONYMS = {
  design: ['ui', 'ux', 'figma', 'layout', 'interface', 'web design', 'landing'],
  website: ['site', 'web', 'landing', 'page'],
  ai: ['llm', 'gpt', 'model', 'machine learning', 'agent'],
  font: ['typography', 'typeface'],
  learn: ['course', 'tutorial', 'guide', 'lesson'],
  image: ['photo', 'picture', 'illustration', 'generator'],
  video: ['film', 'motion', 'animation'],
  code: ['developer', 'programming', 'github'],
};

const STOP = new Set('i im i\'m a an the for to of and or in on with me my looking want need some any find show give hey hi please something like that this is are website websites site sites'.split(' '));

// Short words like "ui" or "ai" must match whole words, not pieces of "build" or "said".
function count(hay, k) {
  if (k.length > 3) return hay.split(k).length - 1;
  return (hay.match(new RegExp(`(^|[^a-z0-9])${k.replace(/[.+#]/g, '\\$&')}([^a-z0-9]|$)`, 'g')) || []).length;
}

function words(s) { return String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) || []; }

function heuristicCategorize(meta, categories) {
  const hay = `${meta.title} ${meta.description} ${meta.host} ${(meta.headings || []).join(' ')} ${meta.text}`.toLowerCase();
  let best = 'Other', bestScore = 0;
  const tagScores = {};
  for (const [cat, kws] of Object.entries(KEYWORDS)) {
    let score = 0;
    for (const k of kws) {
      const n = count(hay, k);
      if (n) { score += Math.min(n, 5); tagScores[k] = (tagScores[k] || 0) + n; }
    }
    if (score > bestScore && categories.includes(cat)) { best = cat; bestScore = score; }
  }
  const tags = Object.entries(tagScores).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  const summary = (meta.description || meta.text || '').slice(0, 180);
  return { category: best, tags, summary, offers: '' };
}

async function replicate(settings, system, prompt, maxTokens = 600) {
  const token = settings.replicateToken;
  if (!token) throw new Error('No Replicate token');
  const model = (settings.model || 'meta/meta-llama-3-70b-instruct').trim();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=60' };
  const input = { prompt, system_prompt: system, max_tokens: maxTokens, max_new_tokens: maxTokens, temperature: 0.2 };
  let endpoint, body;
  if (model.includes(':')) { endpoint = 'https://api.replicate.com/v1/predictions'; body = { version: model.split(':')[1], input }; }
  else { endpoint = `https://api.replicate.com/v1/models/${model}/predictions`; body = { input }; }

  let res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  let pred = await res.json();
  if (!res.ok) throw new Error(pred.detail || pred.title || `Replicate error ${res.status}`);
  const started = Date.now();
  while (['starting', 'processing'].includes(pred.status) && Date.now() - started < 120000) {
    await new Promise(r => setTimeout(r, 1200));
    res = await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${token}` } });
    pred = await res.json();
  }
  if (pred.status !== 'succeeded') throw new Error(pred.error || `Prediction ${pred.status}`);
  return Array.isArray(pred.output) ? pred.output.join('') : String(pred.output);
}

// Which AI to use: 'claude' (Claude Code on this computer = your subscription), 'replicate', or 'none'.
function provider(settings) {
  const p = settings.provider || 'auto';
  if (p !== 'auto') return p;
  if (findClaude()) return 'claude';
  if (settings.replicateToken) return 'replicate';
  return 'none';
}

function complete(settings, system, prompt, maxTokens) {
  const p = provider(settings);
  if (p === 'claude') return runClaude(settings, system, prompt);
  if (p === 'replicate') return replicate(settings, system, prompt, maxTokens);
  return Promise.reject(new Error('AI is off'));
}

function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI did not return JSON');
  return JSON.parse(m[0]);
}

// Fit a long document into what we send the AI: the start, plus slices from the middle and end.
function excerpt(text, max = 14000) {
  text = String(text || '');
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const mid = text.slice(Math.floor(text.length / 2) - Math.floor(max * 0.15), Math.floor(text.length / 2) + Math.floor(max * 0.15));
  const tail = text.slice(-Math.floor(max * 0.1));
  return `${head}\n\n[…]\n\n${mid}\n\n[…]\n\n${tail}`;
}

function list(x, n, lower) {
  return (Array.isArray(x) ? x : []).map(t => String(t).trim()).map(t => lower ? t.toLowerCase() : t).filter(Boolean).slice(0, n);
}

// Reads the saved content and returns detailed, searchable information about the link.
async function analyze(info, categories, settings) {
  const base = { title: info.title, description: info.description, host: info.host, headings: [], text: info.content || info.description || '' };
  if (provider(settings) === 'none') return { ...heuristicCategorize(base, categories), notes: '' };
  const system = 'You are the librarian for a personal collection of saved links. You read what was saved and describe it precisely so it can be found again later, even if the original link disappears. Follow the output format exactly.';
  const prompt = `Existing categories: ${categories.join(', ')}

Saved link: ${info.url}
Kind: ${info.source || 'Web page'}
Page title: ${info.title || ''}
Page description: ${info.description || ''}
${info.note ? `The person's own note: ${info.note}\n` : ''}${info.related ? `Connected to (the person linked these to this item, e.g. a written guide for a video): ${info.related}\n` : ''}
Saved content:
"""
${excerpt(info.content) || '(nothing could be read)'}
"""
${info.content ? '' : `IMPORTANT: Shelf could not read this link${info.problem ? ` (${info.problem})` : ''}. Do not guess or invent anything about its contents. Base the title, category and tags only on the address, page title and description above, start the summary with "Could not be read:" and say what little is known, leave keyPoints and useFor empty, and write one short line of notes saying the content was not available when saved.
`}
Write two parts.

PART 1 is one JSON object:
{
  "title": "a clear, specific title for this item (fix vague or cut-off page titles)",
  "category": "one category. Use an existing category when it genuinely fits. If none fits well, create a new one: 1 to 3 words, broad enough to hold similar links later (e.g. 'Fonts', '3D & Motion', 'Marketing'), never a near-duplicate of an existing one",
  "type": "one of: tool, website, article, guide, course, template, gallery, library, document, spreadsheet, slides, pdf, video, repository, community, newsletter, other",
  "tags": ["8 to 14 specific lowercase tags: topics, techniques, named tools or brands, formats, audience, pricing. Prefer concrete terms like 'landing pages', 'figma plugin', 'text-to-speech' over vague ones like 'tech'"],
  "summary": "2 or 3 sentences: what this is and what is inside it",
  "offers": "what it gives the person, concretely (e.g. '600k app screenshots, free tier, paid pro plan')",
  "pricing": "free, freemium, paid, or unknown",
  "useFor": ["3 to 5 short phrases completing 'Use this when you need…'"],
  "keyPoints": ["5 to 10 concrete facts, names, numbers or takeaways from the content"]
}

Then a line containing only: ===NOTES===

PART 2 is Markdown notes that preserve this item in Shelf's own format, so the person keeps the value even if the link is deleted.
- For documents, Notion pages, PDFs, spreadsheets, slides and articles: a faithful, well-structured condensed copy of the important content, with ## section headings, bullet points, key data, names, links and numbers. Up to about 900 words. For spreadsheets, describe what the sheet tracks, its columns, and the key rows or totals.
- For videos: what the video teaches or shows, then the main steps or sections in order with their timestamps as links (e.g. [3:35](link) Introducing layers), the tools, apps, settings, prompts and resources it mentions, and the key takeaways. Use the transcript, chapters and description. Up to about 700 words.
- For tools, products and websites: what it is, main features, how to use it, pricing, and anything notable. Up to about 300 words.
Write only what is supported by the content. No preamble.`;
  try {
    const raw = await complete(settings, system, prompt, 2500);
    const [jsonPart, ...rest] = String(raw).split(/^\s*===NOTES===\s*$/m);
    const out = parseJson(jsonPart);
    const notes = rest.join('\n').replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim();
    return {
      title: String(out.title || '').trim(),
      category: String(out.category || 'Other').trim().slice(0, 40) || 'Other',
      type: String(out.type || '').trim().toLowerCase(),
      tags: [...new Set(list(out.tags, 14, true))],
      summary: String(out.summary || '').trim(),
      offers: String(out.offers || '').trim(),
      pricing: String(out.pricing || '').trim().toLowerCase(),
      useFor: list(out.useFor, 5),
      keyPoints: list(out.keyPoints, 10),
      notes,
    };
  } catch (e) {
    const h = heuristicCategorize(base, categories);
    h.aiError = e.message;
    h.notes = '';
    return h;
  }
}

// Keyword search over everything Shelf knows: title, tags, notes, key points and the full saved copy.
function scoreLinks(query, links, contentOf = () => '') {
  let q = words(query).filter(w => !STOP.has(w));
  const expanded = new Set(q);
  for (const w of q) for (const [k, syns] of Object.entries(SYNONYMS)) if (w.startsWith(k) || syns.includes(w)) { expanded.add(k); syns.forEach(s => expanded.add(s)); }
  const terms = [...expanded];
  if (!terms.length) return [];
  return links.map(l => {
    const fields = [
      [l.title, 3], [l.category, 4], [(l.tags || []).join(' | '), 4], [l.type, 2], [l.summary, 2], [l.offers, 2],
      [(l.useFor || []).join(' | '), 2.5], [(l.keyPoints || []).join(' | '), 1.5], [l.description, 1], [l.note, 3], [l.url, 1],
      [l.notes, 0.6], [contentOf(l.id), 0.3],
    ];
    let score = 0;
    const hit = new Set();
    for (const [text, weight] of fields) {
      const t = String(text || '').toLowerCase();
      if (!t) continue;
      for (const term of terms) { const n = count(t, term); if (n) { score += weight * Math.min(1 + Math.log(n), 3) * (q.includes(term) ? 1 : 0.5); if (q.includes(term)) hit.add(term); } }
    }
    // Links that match more of the words you typed rank higher.
    if (q.length > 1) score *= 1 + 2 * (hit.size / q.length);
    return { link: l, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score)
    .filter((x, _, all) => x.score >= all[0].score * 0.12);
}

// Lines from a saved copy that mention what was asked, so the AI can answer from the content itself.
function snippet(content, query) {
  if (!content) return '';
  const qs = words(query).filter(w => !STOP.has(w) && w.length > 1);
  if (!qs.length) return '';
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const scored = lines.map((l, i) => ({ i, n: qs.filter(w => count(l.toLowerCase(), w)).length })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 6).sort((a, b) => a.i - b.i);
  const text = scored.map(x => lines[x.i].slice(0, 220)).join(' / ');
  return text ? `matching lines in saved copy: ${text.slice(0, 900)}` : '';
}

async function ask(query, links, settings, contentOf = () => '') {
  const local = scoreLinks(query, links, contentOf);
  if (provider(settings) === 'none' || !links.length) {
    const hits = local.slice(0, 8).map(x => x.link.id);
    return {
      answer: hits.length ? `Found ${hits.length} saved link${hits.length > 1 ? 's' : ''} that match.` : 'Nothing saved matches that yet. Try other words, or turn on AI in Settings for smarter search.',
      ids: hits,
    };
  }
  // Give the AI the best keyword matches plus recent links, so it can catch things keywords miss.
  const pool = [...new Map([...local.slice(0, 25).map(x => x.link), ...links.slice(0, 35)].map(l => [l.id, l])).values()].slice(0, 50);
  const catalog = pool.map((l, i) => [
    `[${i}] ${l.title}`, `${l.category}${l.type ? ' / ' + l.type : ''}${l.pricing && l.pricing !== 'unknown' ? ' / ' + l.pricing : ''}`,
    `tags: ${(l.tags || []).join(', ')}`, l.summary || l.description || '',
    l.useFor && l.useFor.length ? `use for: ${l.useFor.join('; ')}` : '',
    l.keyPoints && l.keyPoints.length ? `facts: ${l.keyPoints.slice(0, 4).join('; ')}` : '',
    l.note ? `their note: ${l.note}` : '',
    l.relatedTitles ? `connected to: ${l.relatedTitles}` : '',
    snippet(contentOf(l.id), query),
  ].filter(Boolean).join(' | ')).join('\n');
  const system = 'You help someone find links they saved earlier. Only recommend items from the list. Reply with JSON only.';
  const prompt = `Saved links:
${catalog}

Request: "${query}"

Pick the items that best answer the request, best first (at most 8). Use the tags, facts and matching lines, not just titles. If the request is a question the saved content answers directly, answer it in the first sentence. If nothing fits, return an empty list and say so plainly.
In "answer", refer to items by name, never by their [number].
Return JSON exactly like: {"answer":"one to three friendly sentences: the direct answer if there is one, then what you picked and why","picks":[0,3]}`;
  try {
    const out = parseJson(await complete(settings, system, prompt, 600));
    const ids = (out.picks || []).map(i => pool[+i]).filter(Boolean).map(l => l.id);
    return { answer: String(out.answer || ''), ids };
  } catch (e) {
    return { answer: `AI search failed (${e.message}). Showing keyword matches instead.`, ids: local.slice(0, 8).map(x => x.link.id) };
  }
}

module.exports = { analyze, ask, replicate, scoreLinks, provider };
