// api/meta-geo.js
//
// Función serverless de Vercel: consulta el breakdown geográfico de Meta Ads
// Insights del lado del servidor, usando el token guardado en la variable de
// entorno META_ACCESS_TOKEN (Settings -> Environment Variables en Vercel).
// El token NUNCA llega al navegador — el frontend solo llama a /api/meta-geo.
//
// Requiere en Vercel:
//   META_ACCESS_TOKEN = <System User token con permiso ads_read>
//
// Uso desde el dashboard:
//   GET /api/meta-geo?property=Tulum&days=30
//   GET /api/meta-geo?property=Holbox&days=30

// Mapeo propiedad -> cuenta de anuncios de Meta (no son datos sensibles,
// son los mismos IDs que ya usa la query de Data Slayer).
const AD_ACCOUNTS = {
  Tulum: "2097689917516041",
  Holbox: "2133939397190177",
};

const GRAPH_API_VERSION = "v21.0";

// Cache simple en memoria: evita pegarle a la API de Meta en cada carga de
// página. Vercel puede reciclar la instancia de la función entre llamadas,
// así que esto es "best effort", no una garantía — pero ayuda bastante.
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

function extractAction(actions, actionType) {
  if (!Array.isArray(actions)) return 0;
  const found = actions.find((a) => a.action_type === actionType);
  return found ? Number(found.value) || 0 : 0;
}

async function fetchMetaGeoBreakdown(accountId, days) {
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

  const fields = ["spend", "impressions", "reach", "ctr", "actions"].join(",");
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/insights` +
    `?fields=${fields}&breakdowns=region&level=account&time_range=${encodeURIComponent(timeRange)}` +
    `&limit=200&access_token=${encodeURIComponent(token)}`;

  const resp = await fetch(url);
  const json = await resp.json();

  if (!resp.ok || json.error) {
    const message = json.error?.message || `Meta Graph API respondió ${resp.status}`;
    throw Object.assign(new Error(message), { statusCode: resp.status || 502 });
  }

  const rows = (json.data || []).map((row) => {
    const actions = row.actions || [];
    return {
      region: row.region || "Sin especificar",
      spend: Number(row.spend) || 0,
      impressions: Number(row.impressions) || 0,
      reach: Number(row.reach) || 0,
      ctr: Number(row.ctr) || 0,
      leads: extractAction(actions, "onsite_conversion.lead_grouped"),
      messagingConvos: extractAction(actions, "onsite_conversion.messaging_first_reply"),
    };
  });

  rows.sort((a, b) => b.spend - a.spend);
  return rows;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate"); // cache de borde de Vercel, 30 min

  const property = (req.query.property || "").toString();
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
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
    const rows = await fetchMetaGeoBreakdown(accountId, days);
    cache.set(cacheKey, { rows, at: Date.now() });
    res.status(200).json({ property, days, rows, cached: false });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}
