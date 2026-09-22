// api/meta-creatives.js
//
// Función serverless de Vercel: trae el thumbnail de cada anuncio de una
// cuenta de Meta Ads, para mostrarlo junto a sus métricas en la pestaña
// "Performance de Anuncios". Se cruza del lado del navegador con las filas
// de /api/meta-performance usando el mismo ad_id.
//
// Requiere en Vercel (mismo token que ya usan /api/meta-geo y /api/meta-performance):
//   META_ACCESS_TOKEN = <System User token con permiso ads_read>
//
// Uso desde el dashboard:
//   GET /api/meta-creatives?property=Tulum
//   GET /api/meta-creatives?property=Holbox

const AD_ACCOUNTS = {
  Tulum: "2097689917516041",
  Holbox: "2133939397190177",
};

const GRAPH_API_VERSION = "v21.0";

// Los creativos cambian poco día a día — cache más largo que el de métricas.
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutos

async function fetchAllPages(url) {
  const rows = [];
  let next = url;
  let guard = 0;
  while (next && guard < 50) {
    const resp = await fetch(next);
    const json = await resp.json();
    if (!resp.ok || json.error) {
      const message = json.error?.message || `Meta Graph API respondió ${resp.status}`;
      throw Object.assign(new Error(message), { statusCode: resp.status || 502 });
    }
    rows.push(...(json.data || []));
    next = json.paging?.next || null;
    guard++;
  }
  return rows;
}

async function fetchCreatives(accountId) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw Object.assign(new Error("META_ACCESS_TOKEN no está configurado en Vercel."), { statusCode: 501 });
  }

  // Se piden TODOS los anuncios (no solo los activos) para poder mostrar
  // también el creativo de anuncios pausados que siguieron con historial
  // de gasto dentro del rango que se esté filtrando en el dashboard.
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/ads` +
    `?fields=id,name,creative{thumbnail_url,image_url}` +
    `&effective_status=["ACTIVE","PAUSED","ARCHIVED","PENDING_REVIEW","DISAPPROVED","CAMPAIGN_PAUSED","ADSET_PAUSED"]` +
    `&limit=500&access_token=${encodeURIComponent(token)}`;

  const raw = await fetchAllPages(url);

  const map = {};
  for (const ad of raw) {
    const thumb = ad.creative?.thumbnail_url || ad.creative?.image_url || null;
    if (thumb) map[ad.id] = thumb;
  }
  return map;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");

  const property = (req.query.property || "").toString();
  const accountId = AD_ACCOUNTS[property];

  if (!accountId) {
    res.status(400).json({ error: `Propiedad desconocida: "${property}". Usa Tulum u Holbox.` });
    return;
  }

  const cached = cache.get(property);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.status(200).json({ property, thumbnails: cached.thumbnails, cached: true });
    return;
  }

  try {
    const thumbnails = await fetchCreatives(accountId);
    cache.set(property, { thumbnails, at: Date.now() });
    res.status(200).json({ property, thumbnails, cached: false });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}
