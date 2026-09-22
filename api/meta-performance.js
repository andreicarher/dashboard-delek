// api/meta-performance.js
//
// Función serverless de Vercel: trae el desempeño diario por anuncio
// (spend, impresiones, alcance, frecuencia, clics, leads, conversaciones de
// WhatsApp) directo de la API de Meta Ads Insights. Esta es ahora LA fuente
// de métricas de campañas del dashboard — ya no se leen de Google Sheets.
//
// La clasificación de negocio (Etapa Funnel / Objetivo / Plaza / Línea de
// Negocio) sigue viviendo en la pestaña "Concatenado campañas" del Sheet;
// el frontend la lee aparte y cruza por nombre de Campaña+AdSet.
//
// Requiere en Vercel (mismo token que ya usa /api/meta-geo):
//   META_ACCESS_TOKEN = <System User token con permiso ads_read>
//
// Uso desde el dashboard:
//   GET /api/meta-performance?property=Tulum&days=90
//   GET /api/meta-performance?property=Holbox&days=90

const AD_ACCOUNTS = {
  Tulum: "2097689917516041",
  Holbox: "2133939397190177",
};

const GRAPH_API_VERSION = "v21.0";

// Cache en memoria — "best effort" (Vercel puede reciclar la instancia),
// pero evita golpear la API de Meta en cada carga de página. TTL más corto
// que el de geodata porque esto alimenta TODO el dashboard, no un panel aparte.
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos

function extractAction(actions, actionType) {
  if (!Array.isArray(actions)) return 0;
  const found = actions.find((a) => a.action_type === actionType);
  return found ? Number(found.value) || 0 : 0;
}

// Sigue "paging.next" hasta agotar todas las páginas — con nivel "ad" y
// desglose diario, 90 días de varias campañas fácilmente pasan de una página.
async function fetchAllPages(url) {
  const rows = [];
  let next = url;
  let guard = 0; // corta si algo sale mal, para no hacer loop infinito
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

async function fetchAdPerformance(accountId, days) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw Object.assign(new Error("META_ACCESS_TOKEN no está configurado en Vercel."), { statusCode: 501 });
  }

  const until = new Date();
  const since = new Date(until.getTime() - days * 86400000);
  const timeRange = JSON.stringify({
    since: since.toISOString().slice(0, 10),
    until: until.toISOString().slice(0, 10),
  });

  const fields = ["campaign_name", "adset_name", "ad_name", "spend", "impressions", "reach", "frequency", "inline_link_clicks", "actions"].join(",");
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/insights` +
    `?fields=${fields}&level=ad&time_increment=1&time_range=${encodeURIComponent(timeRange)}` +
    `&limit=500&access_token=${encodeURIComponent(token)}`;

  const raw = await fetchAllPages(url);

  return raw.map((row) => {
    const actions = row.actions || [];
    return {
      date: row.date_start, // "YYYY-MM-DD"
      campaign: row.campaign_name || "",
      adset: row.adset_name || "",
      ad: row.ad_name || "",
      spend: Number(row.spend) || 0,
      impressions: Number(row.impressions) || 0,
      reach: Number(row.reach) || 0,
      frequency: Number(row.frequency) || 0,
      linkClicks: Number(row.inline_link_clicks) || 0,
      facebookLeads: extractAction(actions, "onsite_conversion.lead_grouped"),
      messagingConvos: extractAction(actions, "onsite_conversion.messaging_first_reply"),
    };
  });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate"); // cache de borde de Vercel, 15 min

  const property = (req.query.property || "").toString();
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 90));
  const accountId = AD_ACCOUNTS[property];

  if (!accountId) {
    res.status(400).json({ error: `Propiedad desconocida: "${property}". Usa Tulum u Holbox.` });
    return;
  }

  const cacheKey = `${property}:${days}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.status(200).json({ property, days, rows: cached.rows, cached: true });
    return;
  }

  try {
    const rows = await fetchAdPerformance(accountId, days);
    cache.set(cacheKey, { rows, at: Date.now() });
    res.status(200).json({ property, days, rows, cached: false });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}
