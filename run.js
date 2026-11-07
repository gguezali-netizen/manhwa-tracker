import { createClient } from '@supabase/supabase-js';
import { normTitle } from './lib.js';
import * as asura from './sites/asura.js';
import * as mangaread from './sites/mangaread.js';

const args = process.argv.slice(2);
const full = args.includes('--full');   // parcourt tout le catalogue
const dry = args.includes('--dry');     // affiche seulement, n'écrit rien
const only = args.find((a) => a.startsWith('--site='))?.split('=')[1];
const modules = [asura, mangaread].filter((m) => !only || m.site.id === only);

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

for (const { site, crawl } of modules) {
  console.log(`\n== ${site.name} ${full ? '(catalogue complet)' : '(mise à jour rapide)'} ==`);
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
  }
}
