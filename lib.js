import * as cheerio from 'cheerio';
export { cheerio };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// User-Agent honnête : on se présente comme un petit robot perso.
export const UA = 'ManhwaTrackerBot/1.0 (projet perso; suivi de nouveaux chapitres)';

// Télécharge une page. Renvoie null si 404, lève une erreur sinon.
export async function getHtml(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
        redirect: 'follow',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (html.length < 60000 && /just a moment|challenge-platform|cf-chl/i.test(html.slice(0, 6000))) {
        throw new Error('page de protection Cloudflare');
      }
      return html;
    } catch (e) {
      if (i === tries) throw new Error(`${url} -> ${e.message}`);
      await sleep(2000 * i);
    }
  }
}

// "Solo Leveling (2020)" et "solo-leveling" -> "sololeveling" : sert à regrouper les doublons entre sites
export const normTitle = (t) =>
  t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\(\s*\d{4}\s*\)/g, '').replace(/[^a-z0-9]+/g, '') || t.trim().toLowerCase();

// "220", "220-5", "220.5", "304-chapter-243" -> 220 / 220.5 / 304
export const chapterNum = (s) => {
  const m = String(s).match(/(\d+)(?:[-.](\d+))?/);
  if (!m) return null;
  return parseFloat(m[2] ? `${m[1]}.${m[2]}` : m[1]);
};

// Envoie un formulaire (POST), comme le fait le bouton "Load more" de certains sites.
export async function postForm(url, params, referer) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      accept: '*/*',
      referer,
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Tout le texte d'un bloc, avec une espace entre chaque morceau ("9.6" + "6 Chs." ne doit pas devenir "9.66 Chs.")
export const textOf = (el) =>
  el.find('*').addBack().contents().filter((_, n) => n.type === 'text').map((_, n) => n.data.trim()).get().filter(Boolean).join(' ');
