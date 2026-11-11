// Comizy : site rendu côté serveur. Formes des liens :
//   série   : /<slug>
//   chapitre: /<slug>/chapter-<n>      (les bonus ont d'autres formes : side-1, special-...)
// Catalogue : /latest?page=N (classé par dernière mise à jour, environ 25 séries par page).
import { cheerio, getHtml, sleep, chapterNum, cleanText, cleanGenres, normType, normStatus, labelHits, suffixOf } from '../lib.js';

export const site = { id: 'comizy', name: 'Comizy', base: 'https://comizy.io' };

// Pages du site qui ne sont pas des séries (même forme de lien : un seul segment)
const NOT_SERIES = new Set([
  'home', 'latest', 'genres', 'lists', 'ranking', 'search', 'filters', 'trending', 'auth', 'tags', 'authors',
  'terms-of-service', 'privacy-policy', 'dmca', 'contact', 'static', 'api', 'new', 'popular', 'blog',
]);
const titleFromSlug = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// Lit une page de liste : renvoie l'ensemble des séries vues sur la page
export function parseListing(html, found) {
  const $ = cheerio.load(html);
  const seen = new Set();
  $('a[href]').each((_, el) => {
    let u;
    try { u = new URL($(el).attr('href'), site.base); } catch { return; }
    if (u.hostname !== 'comizy.io') return;
    const m = u.pathname.match(/^\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (!m || NOT_SERIES.has(m[1])) return;
    const slug = m[1], sub = m[2];

    const e = found.get(slug) ?? { slug, url: `${site.base}/${slug}`, title: '', prio: 0, cover: null, chapters: [] };
    found.set(slug, e);
    seen.add(slug);
    const a = $(el);

    if (sub) { // lien de chapitre : on ne retient que les "chapter-N"
      const c = sub.match(/^chapter-(.+)$/i);
      const n = c ? chapterNum(c[1]) : null;
      if (n != null) e.chapters.push({ n, url: u.href });
      return;
    }
    // lien de série : titre et couverture
    const img = a.find('img').first();
    const src = img.attr('src') || img.attr('data-src') || '';
    if (src && !e.cover && /\/covers\//.test(src)) e.cover = new URL(src, site.base).href;
    const cand = [[a.attr('title'), 3], [img.attr('alt'), 2], [a.find('h1,h2,h3,h4').first().text(), 2]];
    for (const [t, prio] of cand) {
      const text = cleanText(t);
      if (text.length > 1 && prio > e.prio) { e.title = text; e.prio = prio; }
    }
  });
  return seen;
}

// Dernière page du catalogue d'après les liens "?page=N"
export function lastPage(html) {
  const $ = cheerio.load(html);
  let max = 1;
  $('a[href*="page="]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/[?&]page=(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return max;
}

export async function crawl({ full }) {
  const found = new Map();
  const maxPages = full ? 500 : 3;
  let last = Infinity;
  for (let p = 1; p <= maxPages; p++) {
    const html = await getHtml(p === 1 ? `${site.base}/latest` : `${site.base}/latest?page=${p}`);
    if (!html) break;
    if (p === 1) last = lastPage(html);
    const before = found.size;
    const seen = parseListing(html, found);
    console.log(`  page ${p}${full && last !== Infinity ? ` / ${last}` : ''} : ${seen.size} séries lues, ${found.size - before} nouvelles (total ${found.size})`);
    if (seen.size === 0 || p >= last) break;
    await sleep(1500);
  }
  return [...found.values()].map((e) => {
    const best = [...e.chapters].sort((a, b) => b.n - a.n)[0];
    return {
      url: e.url,
      title: e.title || titleFromSlug(e.slug),
      cover: e.cover,
      latestChapter: best?.n ?? null,
      latestChapterUrl: best?.url ?? null,
      chapterCount: null,
    };
  });
}

// ---------- Page d'une série ----------
const cleanDesc = (raw) => {
  let t = String(raw || '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'")
    .split(/\s-{3,}\s/)[0]                                   // après "---" : notes et liens officiels
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '');
  return cleanText(t).replace(/\s*(?:…|\.\.\.)?\s*Read more$/i, '');
};

export function parseDetails(html, seriesUrl) {
  const $ = cheerio.load(html);
  const slug = new URL(seriesUrl).pathname.replace(/^\/|\/$/g, '');

  // Genres et auteurs : liens situés entre le titre (h1) et le bloc "Tags"
  let started = false, stop = false;
  const genreNames = [], authorNames = [];
  $('h1, h2, h3, a[href*="/genres/"], a[href*="/authors/"]').each((_, el) => {
    if (stop) return;
    if (el.name === 'h1') { started = true; return; }
    if (!started) return;
    if (/^h[23]$/.test(el.name)) { if (/^(tags|chapters?|you may also like)/i.test(cleanText($(el).text()))) stop = true; return; }
    const href = $(el).attr('href') || '', text = cleanText($(el).text());
    if (href.includes('/genres/')) genreNames.push(text);
    else if (href.includes('/authors/') && !/^updating$/i.test(text)) authorNames.push(text);
  });
  const genres = cleanGenres(genreNames);

  // En-tête du type "manhwaRELEASING2020…" : type + statut collés
  const body = $('body').text();
  const ts = body.match(/(?<![a-z])(manga|manhwa|manhua|webtoons?|comic|doujinshi|novel)\s*(releasing|ongoing|completed|finished|hiatus|cancell?ed|dropped|upcoming|paused)(?![a-z])/i);
  const type = normType(ts?.[1], genres);
  const status = normStatus(ts?.[2], genres);

  // Résumé : la description complète est dans les balises meta
  const meta = cleanDesc($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content'));
  let visible = '';
  $('p').each((_, p) => { const t = cleanText($(p).text()); if (t.length > 60 && t.length > visible.length) visible = t; });
  const description = meta.length >= 40 ? meta : cleanDesc(visible);

  // Chapitres : seuls les 20 derniers sont dans la page ; on complète avec la suite de numéros
  // depuis le premier chapitre ("Start Reading") jusqu'au plus ancien chapitre visible.
  const map = new Map();
  $('a[href]').each((_, el) => {
    let u;
    try { u = new URL($(el).attr('href'), seriesUrl); } catch { return; }
    const m = u.pathname.match(new RegExp(`^/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/chapter-(.+?)/?$`, 'i'));
    if (!m) return;
    const n = chapterNum(m[1]);
    if (n != null && !map.has(n)) map.set(n, suffixOf(u.href.replace(/\/$/, ''), seriesUrl));
  });
  let firstN = null;
  $('a').each((_, el) => {
    if (firstN != null || !/start reading/i.test($(el).text())) return;
    const m = ($(el).attr('href') || '').match(/\/chapter-(.+?)\/?$/i);
    if (m) firstN = chapterNum(m[1]);
  });
  if (map.size) {
    const start = firstN ?? 1;
    const visible = [...map.keys()].filter((n) => n !== firstN || map.size === 1);
    const lowest = Math.min(...(visible.length ? visible : [...map.keys()]));
    for (let i = Math.ceil(start); i < lowest && i - start < 3000; i++) if (!map.has(i)) map.set(i, `/chapter-${i}`);
    if (firstN != null && !map.has(firstN)) map.set(firstN, `/chapter-${String(firstN).replace('.', '-')}`);
  }
  const chapters = [...map.entries()].sort((a, b) => b[0] - a[0]);

  return {
    type, status, rating: null, genres, description, chapters,
    author: authorNames.slice(0, 3).join(', ') || null, artist: null,
  };
}

export async function fetchDetails(url) {
  const html = await getHtml(url);
  return html ? parseDetails(html, url) : null;
}
