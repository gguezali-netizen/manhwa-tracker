// Notifications sur le téléphone avec ntfy (https://ntfy.sh)
// Le robot envoie un message à un "sujet" secret ; l'appli ntfy du téléphone y est abonnée.

export function ntfyConfig(env = process.env) {
  const topic = (env.NTFY_TOPIC || '').trim();
  const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  let siteUrl = (env.SITE_URL || '').trim();
  // Sur GitHub Actions, l'adresse du site (GitHub Pages) se déduit du nom du dépôt
  if (!siteUrl && env.GITHUB_REPOSITORY) {
    const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
    siteUrl = `https://${owner.toLowerCase()}.github.io/${repo}/`;
  }
  if (siteUrl && !siteUrl.endsWith('/')) siteUrl += '/';
  return { topic, server, token: (env.NTFY_TOKEN || '').trim(), siteUrl };
}

const num = (n) => String(Number(n));

// Un message par série (le chapitre le plus récent), 8 au maximum par passage + un message de synthèse
export function buildMessages({ events, siteUrl = '', maskedIds = new Set(), max = 8 }) {
  const bySeries = new Map();
  for (const e of events) {
    const p = bySeries.get(e.series_id);
    if (!p || Number(e.chapter) > Number(p.chapter)) bySeries.set(e.series_id, e);
  }
  const list = [...bySeries.values()];
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;

  const msgs = shown.map((e) => {
    const masked = maskedIds.has(e.series_id);
    const fiche = siteUrl ? `${siteUrl}#serie-${e.series_id}` : '';
    return {
      title: masked ? 'Nouveau chapitre' : e.title,
      message: masked ? `Œuvre masquée · chapitre ${num(e.chapter)} sur ${e.site}` : `Chapitre ${num(e.chapter)} · ${e.site}`,
      tags: ['books'],
      priority: 3,
      ...(e.url ? { click: e.url } : fiche ? { click: fiche } : {}),
      ...(fiche ? { actions: [{ action: 'view', label: 'Ouvrir la fiche', url: fiche }] } : {}),
    };
  });
  if (rest > 0) {
    msgs.push({
      title: 'Nouveaux chapitres',
      message: `et ${rest} autre${rest > 1 ? 's' : ''} œuvre${rest > 1 ? 's' : ''} suivie${rest > 1 ? 's' : ''}`,
      tags: ['books'], priority: 3, ...(siteUrl ? { click: siteUrl } : {}),
    });
  }
  return msgs;
}

// Publication au format JSON (accepte les accents, le coréen, etc.)
export async function publish(cfg, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${cfg.server}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
    body: JSON.stringify({ topic: cfg.topic, ...body }),
  });
  if (!res.ok) throw new Error(`ntfy a répondu HTTP ${res.status}`);
}

// Notifie seulement les séries suivies dont les notifications sont activées.
// Si le floutage des œuvres pour adultes est activé, le titre est masqué (l'écran verrouillé reste discret).
export async function notifyNewChapters({ sb, events, cfg, fetchImpl = fetch, pause = 300 }) {
  if (!cfg.topic || !events.length) return 0;

  let fr = await sb.from('follows').select('series_id,notify');
  if (fr.error) fr = await sb.from('follows').select('series_id');   // schema_v3.sql pas encore lancé
  if (fr.error) throw new Error(fr.error.message);
  const on = new Set((fr.data || []).filter((r) => r.notify !== false).map((r) => r.series_id));
  const mine = events.filter((e) => on.has(e.series_id));
  if (!mine.length) return 0;

  const maskedIds = new Set();
  try {
    const us = await sb.from('user_settings').select('data').limit(1).maybeSingle();
    const st = us.data?.data;
    if (st?.blurAdult) {
      const blur = new Set((st.blurGenres || []).map((g) => String(g).toLowerCase()));
      const ids = [...new Set(mine.map((e) => e.series_id))];
      const sr = await sb.from('series').select('id,genres').in('id', ids);
      (sr.data || []).forEach((s) => { if ((s.genres || []).some((g) => blur.has(String(g).toLowerCase()))) maskedIds.add(s.id); });
    }
  } catch { /* on n'empêche jamais la notification pour ça */ }

  let sent = 0;
  for (const m of buildMessages({ events: mine, siteUrl: cfg.siteUrl, maskedIds })) {
    await publish(cfg, m, fetchImpl);
    sent++;
    if (pause) await new Promise((r) => setTimeout(r, pause));
  }
  return sent;
}
