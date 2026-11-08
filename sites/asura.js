// Asura Scans (site Astro). Formes des liens :
//   série   : /comics/<slug>-<id>
//   chapitre: /comics/<slug>-<id>/chapter/<n>
// Le catalogue est sur /browse?page=N (affiche aussi le nombre de chapitres).
import { cheerio, getHtml, sleep, textOf, cleanText, cleanGenres, normType, normStatus, afterLabel, labelHits, neighbor, suffixOf } from '../lib.js';

export const site = { id: 'asura', name: 'Asura Scans', base: 'https://asurascans.com' };

const slugOf = (href) => (href || '').split('/comics/')[1]?.split(/[/?#]/)[0];
const titleFromSlug = (s) => s.replace(/-[0-9a-f]{8}$/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const HEADINGS = 'h1,h2,h3,h4,h5,h6';

export function parseBrowse(html, found) {
  const $ = cheerio.load(html);
  $('a[href]').each((_, el) => {
    let u;
    try { u = new URL($(el).attr('href'), site.base); } catch { return; }
    if (u.hostname !== 'asurascans.com') return;
    const m = u.pathname.match(/^\/comics\/([^/]+)\/?$/);
    if (!m) return;

    const slug = m[1];
    const e = found.get(slug) ?? { slug, url: `${site.base}/comics/${slug}`, title: '', prio: 0, cover: null, count: null, sample: null };
    found.set(slug, e);
    const a = $(el);

    // Titre : le plus fiable est un titre de niveau h1-h6 (dans le lien OU autour du lien)
    const inner = a.find(HEADINGS).first();
    let text; let prio;
    if (inner.length) { text = inner.text(); prio = 3; }
    else if (a.closest(HEADINGS).length) { text = a.text(); prio = 3; }
    else { text = textOf(a).split(/\s+\d{1,2}\.\d\b/)[0]; prio = 2; } // lien "titre + note" : on coupe avant la note
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 1 && prio > e.prio) { e.title = text; e.prio = prio; }
    if (!e.title) {
      const alt = a.find('img').first().attr('alt');
      if (alt && alt.trim().length > 1) { e.title = alt.trim(); e.prio = 1; }
    }

    // La "carte" de la série = le plus grand bloc autour du lien qui ne contient que cette série
    if (e.count == null || !e.cover) {
      let card = a;
      for (let i = 0; i < 6; i++) {
        const up = card.parent();
        if (!up.length || up.is('body,html,main')) break;
        const slugs = new Set(up.find('a[href*="/comics/"]').map((__, x) => slugOf($(x).attr('href'))).get().filter(Boolean));
        if (slugs.size > 1) break;
        card = up;
      }
      if (e.count == null) {
        const c = textOf(card).match(/(\d+)\s*(?:Chs?\.|Chapters)/i);
        if (c) e.count = parseInt(c[1], 10);
      }
      if (!e.cover) {
        const img = card.find('img').first();
        const src = img.attr('data-src') || img.attr('src') || (img.attr('srcset') || '').split(' ')[0];
        if (src && !src.startsWith('data:')) { try { e.cover = new URL(src, site.base).href; } catch { /* ignore */ } }
      }
      if (!e.sample) e.sample = $.html(card).slice(0, 1200);
    }
  });
}

// Plus grand numéro de chapitre trouvé sur la page de la série
export function latestFromSeriesHtml(html) {
  const $ = cheerio.load(html);
  let best = null;
  $('a[href*="/chapter/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/chapter\/(\d+(?:\.\d+)?)\/?$/);
    if (!m) return;
    const n = parseFloat(m[1]);
    if (!best || n > best.n) best = { n, url: new URL(href, site.base).href };
  });
  return best;
}

export async function crawl({ full, known }) {
  const found = new Map();
  const maxPages = full ? 60 : 2; // l'ordre par défaut = dernières mises à jour
  let warned = false;

  for (let p = 1; p <= maxPages; p++) {
    const html = await getHtml(p === 1 ? `${site.base}/browse` : `${site.base}/browse?page=${p}`);
    if (!html) break;
    const before = found.size;
    parseBrowse(html, found);
    console.log(`  page ${p} : ${found.size - before} nouvelles séries (total ${found.size})`);

    const bad = [...found.values()].filter((e) => !e.title || e.count == null || !e.cover);
    if (bad.length && !warned) {
      warned = true;
      console.log(`  ATTENTION : ${bad.length} séries sans titre, couverture ou nombre de chapitres. Exemple de HTML à me copier :\n${bad[0].sample}\n`);
    }
    if (found.size === before) break;
    await sleep(1500);
  }

  const out = [];
  for (const e of found.values()) {
    const prev = known.get(e.url);
    let latest = null;
    if (prev && prev.latest_chapter != null && e.count != null && prev.chapter_count === e.count) {
      // rien n'a changé depuis la dernière fois : pas besoin de rouvrir la page
      latest = { n: Number(prev.latest_chapter), url: prev.latest_chapter_url };
    } else {
      const html = await getHtml(e.url);
      if (html) latest = latestFromSeriesHtml(html);
      await sleep(1000);
    }
    out.push({
      url: e.url,
      title: e.title || titleFromSlug(e.slug),
      cover: e.cover,
      latestChapter: latest?.n ?? null,
      latestChapterUrl: latest?.url ?? null,
      chapterCount: e.count,
    });
  }
  return out;
}

// ---------- Page d'une série : genres, type, statut, note, résumé, chapitres ----------
function descriptionOf($) {
  let best = '';
  $('p, div, span').each((_, el) => {
    const $el = $(el);
    if (el.name !== 'p' && $el.children().length) return;     // on ne garde que les blocs de texte "simples"
    const t = cleanText($el.text());
    if (t.length > 60 && (t.match(/ • /g) || []).length < 2 && t.length > best.length) best = t;
  });
  if (!best) best = cleanText($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'));
  return best.replace(/\s*Show more\s*$/i, '').replace(/\s*Show less\s*$/i, '');
}

function ratingOf($) {
  for (const hit of labelHits($, /^rating$/i)) {
    for (const dir of ['next', 'prev']) {
      const t = cleanText(neighbor(hit, dir)?.text());
      if (/^\d+(\.\d+)?$/.test(t) && parseFloat(t) <= 10) return parseFloat(t);
    }
  }
  return null;
}

export function parseDetails(html, seriesUrl) {
  const $ = cheerio.load(html);
  const genres = cleanGenres($('a[href*="browse?genres="]').map((_, a) => cleanText($(a).text())).get());
  const type = normType(cleanText(afterLabel($, /^type$/i)?.text()), genres);
  const status = normStatus(cleanText(afterLabel($, /^status$/i)?.text()), genres);

  const base = (new URL(seriesUrl).pathname.match(/^\/comics\/([^/]+)/) || [])[1]?.replace(/-[0-9a-f]{8}$/, '');
  const map = new Map();
  $('a[href*="/chapter/"]').each((_, el) => {
    let u;
    try { u = new URL($(el).attr('href'), seriesUrl); } catch { return; }
    const m = u.pathname.match(/^\/comics\/([^/]+)\/chapter\/(\d+(?:\.\d+)?)\/?$/);
    if (!m || m[1].replace(/-[0-9a-f]{8}$/, '') !== base) return;
    const n = parseFloat(m[2]);
    if (!map.has(n)) map.set(n, suffixOf(u.href, seriesUrl));
  });
  const chapters = [...map.entries()].sort((a, b) => b[0] - a[0]);

  return { type, status, rating: ratingOf($), genres, description: descriptionOf($), chapters };
}

export async function fetchDetails(url) {
  const html = await getHtml(url);
  return html ? parseDetails(html, url) : null;
}
