import { createClient } from '@supabase/supabase-js';
import { normTitle, sleep } from './lib.js';
import * as asura from './sites/asura.js';
import * as mangaread from './sites/mangaread.js';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const full = args.includes('--full');            // parcourt tout le catalogue
const dry = args.includes('--dry');              // affiche seulement, n'écrit rien
const probe = args.includes('--probe');          // teste la lecture d'une page de série par site
const only = flag('site');
const modules = [asura, mangaread].filter((m) => !only || m.site.id === only);

// Combien de pages de séries on analyse (genres, résumé, chapitres) à chaque passage
const DETAIL_LIMIT = args.includes('--no-details') ? 0 : Number(flag('details') ?? (full ? 300 : 100));

// ---------- Test d'une page de série (aucune écriture) ----------
if (probe) {
  const SAMPLES = {
    asura: 'https://asurascans.com/comics/the-world-after-the-end-ab39de10',
    mangaread: 'https://www.mangaread.org/manga/swordmasters-youngest-son/',
  };
  for (const m of modules) {
    console.log(`\n== ${m.site.name} : ${SAMPLES[m.site.id]} ==`);
    try {
      const d = await m.fetchDetails(SAMPLES[m.site.id]);
      if (!d) { console.log('page introuvable'); continue; }
      console.log({
        type: d.type, statut: d.status, note: d.rating, genres: d.genres,
        resume: d.description.slice(0, 140), auteur: d.author, artiste: d.artist, nb_chapitres: d.chapters.length,
        plus_recent: d.chapters[0], plus_ancien: d.chapters.at(-1),
      });
    } catch (e) { console.log('ERREUR : ' + e.message); }
  }
  process.exit(0);
}

let sb = null;
if (!dry) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Il manque SUPABASE_URL et/ou SUPABASE_SERVICE_KEY (fichier .env).');
    process.exit(1);
  }
  sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function fetchAll(table, columns, filter) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(columns).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

// ---------- Détails : genres, type, résumé, liste des chapitres ----------
async function saveDetails(row, d) {
  const now = new Date().toISOString();
  if (!d) { // page disparue : on note qu'on a regardé pour ne pas insister
    const { error } = await sb.from('series_sources').update({ details_checked_at: now }).eq('id', row.id);
    if (error) throw error;
    return;
  }
  const { error } = await sb.from('series_sources')
    .update({ chapters: d.chapters.length ? d.chapters : null, details_checked_at: now }).eq('id', row.id);
  if (error) throw error;

  const { data: cur, error: e2 } = await sb.from('series')
    .select('type,status,genres,description,rating,author,artist').eq('id', row.series_id).single();
  if (e2) throw e2;

  const upd = {};
  if (d.type && !cur.type) upd.type = d.type;
  if (d.status) upd.status = d.status;
  const genres = [...new Map([...(cur.genres || []), ...d.genres].map((g) => [g.toLowerCase(), g])).values()];
  if (genres.length !== (cur.genres || []).length) upd.genres = genres;
  if (d.description && (!cur.description || d.description.length > cur.description.length)) upd.description = d.description;
  if (d.rating != null) upd.rating = d.rating;
  if (d.author && !cur.author) upd.author = d.author;
  if (d.artist && !cur.artist) upd.artist = d.artist;
  if (Object.keys(upd).length) {
    const { error: e3 } = await sb.from('series').update(upd).eq('id', row.series_id);
    if (e3) throw e3;
  }
}

async function enrich(mod, touchedUrls) {
  if (!DETAIL_LIMIT) return;
  const { site } = mod;
  const followed = new Set((await fetchAll('follows', 'series_id')).map((r) => r.series_id));
  const pending = await fetchAll('series_sources', 'id,series_id,url', (q) => q.eq('site_id', site.id).is('details_checked_at', null));

  // 1) séries qui viennent d'avoir un nouveau chapitre (liste à rafraîchir)
  const byId = new Map();
  for (const c of chunks([...touchedUrls], 30)) {
    const { data, error } = await sb.from('series_sources').select('id,series_id,url').eq('site_id', site.id).in('url', c);
    if (error) throw error;
    data.forEach((r) => byId.set(r.id, { ...r, prio: 0 }));
  }
  // 2) séries suivies jamais analysées, 3) toutes les autres
  for (const r of pending) if (!byId.has(r.id)) byId.set(r.id, { ...r, prio: followed.has(r.series_id) ? 1 : 2 });

  const queue = [...byId.values()].sort((a, b) => a.prio - b.prio).slice(0, DETAIL_LIMIT);
  console.log(`  détails : ${queue.length} série(s) analysée(s) ce passage, ${Math.max(0, pending.length - queue.length)} restante(s)`);

  let done = 0, errors = 0;
  for (const row of queue) {
    try {
      await saveDetails(row, await mod.fetchDetails(row.url));
      done++; errors = 0;
    } catch (e) {
      errors++;
      console.log(`  ! ${row.url} : ${e.message}`);
      if (errors >= 5) { console.log('  5 erreurs de suite : on arrête les détails pour ce site.'); break; }
    }
    await sleep(1000);
  }
  console.log(`  détails enregistrés : ${done}`);
}

// ---------- Boucle principale ----------
for (const mod of modules) {
  const { site, crawl } = mod;
  console.log(`\n== ${site.name} ${full ? '(catalogue complet)' : '(mise à jour rapide)'} ==`);
  const touched = new Set();
  try {
    const known = new Map();
    if (sb) {
      const rows = await fetchAll('series_sources', 'url,chapter_count,latest_chapter,latest_chapter_url', (q) => q.eq('site_id', site.id));
      rows.forEach((r) => known.set(r.url, r));
    }

    const items = await crawl({ full, known });
    console.log(`${items.length} séries trouvées`);

    if (dry) {
      console.table(items.slice(0, 12).map((i) => ({
        titre: i.title.slice(0, 38), dernier_chap: i.latestChapter, nb_chap: i.chapterCount, couverture: i.cover ? 'oui' : 'non',
      })));
      continue;
    }

    // 1) créer les séries qui n'existent pas encore (regroupées par titre simplifié)
    const seriesRows = [...new Map(items.map((i) => [normTitle(i.title), { title: i.title, norm_title: normTitle(i.title), cover_url: i.cover }])).values()];
    for (const c of chunks(seriesRows, 200)) {
      const { error } = await sb.from('series').upsert(c, { onConflict: 'norm_title', ignoreDuplicates: true });
      if (error) throw error;
    }
    const idByNorm = new Map((await fetchAll('series', 'id,norm_title')).map((r) => [r.norm_title, r.id]));

    // 2) enregistrer où lire chaque série + détecter les nouveaux chapitres
    const now = new Date().toISOString();
    const events = [];
    const sources = new Map();
    for (const i of items) {
      const series_id = idByNorm.get(normTitle(i.title));
      const prev = known.get(i.url);
      if (prev && prev.latest_chapter != null && i.latestChapter != null && i.latestChapter > Number(prev.latest_chapter)) {
        events.push({ series_id, site_id: site.id, chapter: i.latestChapter, chapter_url: i.latestChapterUrl });
        touched.add(i.url);
        console.log(`  nouveau chapitre : ${i.title} -> ${i.latestChapter}`);
      }
      sources.set(i.url, {
        series_id, site_id: site.id, url: i.url, title_on_site: i.title, cover_url: i.cover,
        chapter_count: i.chapterCount, latest_chapter: i.latestChapter, latest_chapter_url: i.latestChapterUrl, checked_at: now,
      });
    }
    for (const c of chunks([...sources.values()], 200)) {
      const { error } = await sb.from('series_sources').upsert(c, { onConflict: 'site_id,url' });
      if (error) throw error;
    }
    if (events.length) {
      const { error } = await sb.from('chapter_events').insert(events);
      if (error) throw error;
    }
    console.log(`OK : ${sources.size} séries enregistrées, ${events.length} nouveau(x) chapitre(s).`);
  } catch (e) {
    console.error(`ERREUR sur ${site.name} : ${e.message}`);
    process.exitCode = 1; // on continue avec le site suivant
    continue;
  }

  // 3) analyse des pages de séries (séparée : une erreur ici n'annule pas la mise à jour ci-dessus)
  if (!dry) {
    try { await enrich(mod, touched); }
    catch (e) { console.error(`ERREUR détails ${site.name} : ${e.message} (as-tu bien exécuté schema_v2.sql dans Supabase ?)`); process.exitCode = 1; }
  }
}
