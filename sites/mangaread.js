// MangaRead = site WordPress (thème Madara). On se base sur la forme des liens :
//   série   : /manga/<slug>/
//   chapitre: /manga/<slug>/chapter-<n>/
// plutôt que sur des classes CSS, qui changent souvent.
import { cheerio, getHtml, postForm, sleep, chapterNum, cleanText, cleanGenres, normType, normStatus, afterLabel, suffixOf, cleanPerson } from '../lib.js';

export const site = { id: 'mangaread', name: 'MangaRead', base: 'https://www.mangaread.org' };

const titleFromSlug = (s) => s.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function parse(html, found) {
  const $ = cheerio.load(html);
  const seen = new Set();
  $('a[href]').each((_, el) => {
    let u;
    try { u = new URL($(el).attr('href'), site.base); } catch { return; }
    if (!u.hostname.endsWith('mangaread.org')) return;
    const m = u.pathname.match(/^\/manga\/([^/]+)\/(?:(chapter-[^/]+)\/)?$/);
    if (!m) return;

    const slug = m[1];
    seen.add(slug);
    const e = found.get(slug) ?? { slug, url: `${site.base}/manga/${slug}/`, title: '', prio: 0, cover: '', chapters: [] };
    found.set(slug, e);

    if (m[2]) { // lien de chapitre
      const n = chapterNum(m[2].replace('chapter-', ''));
      if (n != null) e.chapters.push({ n, url: u.href });
      return;
    }
    // lien de série : on cherche un titre et une couverture
    const a = $(el);
    const text = a.text().replace(/\s+/g, ' ').trim();
    if (text && !/^chapter\b/i.test(text)) {
      const prio = a.parent().is('h1,h2,h3,h4,h5,h6') ? 2 : /^[a-z0-9-]+$/.test(text) ? 0 : 1;
      if (prio > e.prio) { e.title = text; e.prio = prio; }
    }
    const img = a.find('img').first();
    if (img.length && !e.cover) {
      const src = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src');
      if (src && !src.startsWith('data:')) e.cover = new URL(src, site.base).href;
    }
  });
  return seen;
}

// Le catalogue complet (3000+ séries) ne s'affiche que par lots, via le bouton "Load more".
// On envoie la même demande que ce bouton, avec 20 séries par lot (testé avec ton diagnostic).
function loadMore(page) {
  return postForm(`${site.base}/wp-admin/admin-ajax.php`, {
    action: 'madara_load_more',
    page: String(page),
    template: 'madara-core/content/content-archive',
    'vars[paged]': '1',
    'vars[posts_per_page]': '20',
    'vars[orderby]': 'meta_value_num',
    'vars[template]': 'archive',
    'vars[sidebar]': 'right',
    'vars[post_type]': 'wp-manga',
    'vars[post_status]': 'publish',
    'vars[meta_key]': '_latest_update',
    'vars[order]': 'desc',
    'vars[manga_archives_item_layout]': 'big_thumbnail',
  }, `${site.base}/manga/?m_orderby=latest`);
}

export async function crawl({ full }) {
  const found = new Map();

  // 1) accueil + début de la liste : fonctionne toujours
  for (const u of [`${site.base}/`, `${site.base}/manga/?m_orderby=latest`]) {
    const html = await getHtml(u);
    if (html) parse(html, found);
    await sleep(1000);
  }
  console.log(`  accueil + liste : ${found.size} séries`);

  // 2) lots suivants ("Load more"). Les premiers lots recoupent l'accueil : c'est normal.
  const maxLots = full ? 300 : 3;
  let noNew = 0;
  for (let p = 1; p <= maxLots; p++) {
    let html;
    try {
      html = await loadMore(p);
    } catch (e) {
      console.log(`  chargement par lots indisponible (${e.message}) : on s'en tient à ce qu'on a déjà`);
      break;
    }
    const before = found.size;
    const seen = html && html.trim().length > 10 ? parse(html, found) : new Set();
    const added = found.size - before;
    console.log(`  lot ${p} : ${seen.size} séries lues, ${added} nouvelles (total ${found.size})`);
    if (seen.size === 0) break;                       // plus rien à charger = fin du catalogue
    noNew = added > 0 ? 0 : noNew + 1;
    if (noNew >= 8) { console.log('  8 lots sans rien de nouveau : on arrête.'); break; } // sécurité
    await sleep(1500); // on reste poli
  }

  return [...found.values()].map((e) => {
    const last = [...e.chapters].sort((a, b) => b.n - a.n)[0];
    return {
      url: e.url,
      title: e.title || titleFromSlug(e.slug),
      cover: e.cover || null,
      latestChapter: last?.n ?? null,
      latestChapterUrl: last?.url ?? null,
      chapterCount: null,
    };
  });
}

// ---------- Page d'une série : genres, type, statut, note, résumé, chapitres ----------
export function parseDetails(html, seriesUrl) {
  const $ = cheerio.load(html);
  const slug = (new URL(seriesUrl).pathname.match(/^\/manga\/([^/]+)/) || [])[1];

  const genreBox = afterLabel($, /^Genre\(s\)$/i);
  const genreLinks = genreBox ? genreBox.find('a').addBack('a') : $('.genres-content a');
  const genres = cleanGenres(genreLinks.map((_, a) => cleanText($(a).text())).get());
  const type = normType(cleanText(afterLabel($, /^Type$/i)?.text()), genres);
  const status = normStatus(cleanText(afterLabel($, /^Status$/i)?.text()), genres);

  // Note : "Average 4.7 / 5" -> 9.4 sur 10
  const r = $('body').text().match(/Average\s+(\d+(?:\.\d+)?)\s*\/\s*5/i);
  const rating = r ? Math.round(parseFloat(r[1]) * 20) / 10 : null;

  let description = cleanText($('.summary__content').first().text() || afterLabel($, /^Summary$/i)?.text());
  description = description
    .replace(/^A brief description of (?:the )?[^:]{1,160}:\s*/i, '')
    .replace(/\s*Show (?:more|less)\s*$/i, '');

  const map = new Map();
  $('a[href*="/chapter-"]').each((_, el) => {
    let u;
    try { u = new URL($(el).attr('href'), seriesUrl); } catch { return; }
    const m = u.pathname.match(/^\/manga\/([^/]+)\/chapter-([^/]+)\/?$/);
    if (!m || m[1] !== slug) return;
    const n = chapterNum(m[2]);
    if (n != null && !map.has(n)) map.set(n, suffixOf(u.href, seriesUrl));
  });
  const chapters = [...map.entries()].sort((a, b) => b[0] - a[0]);

  const author = cleanPerson(afterLabel($, /^Authors?(\(s\))?$/i)?.text());
  const artist = cleanPerson(afterLabel($, /^Artists?(\(s\))?$/i)?.text());

  return { type, status, rating, genres, description, chapters, author, artist };
}

export async function fetchDetails(url) {
  const html = await getHtml(url);
  return html ? parseDetails(html, url) : null;
}
