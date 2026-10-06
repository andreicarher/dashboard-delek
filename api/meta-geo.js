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
//   GET /api/meta-geo?property=Holbox&days=30&moves=[{"campaign":"...","from":"Tulum","to":"Holbox"}]
//
// PROPIEDAD vs. CUENTA PUBLICITARIA
// La propiedad de una campaña se define en la columna PLAZA del Sheet
// ("Concatenado campañas"), no por la cuenta donde corre. Si una campaña corre
// en la cuenta de Tulum pero es de Holbox, el frontend la manda en `moves`
// (from = cuenta donde corre, to = propiedad a la que pertenece) y aquí:
//   - se EXCLUYE del panel de la propiedad "from", y
//   - se INCLUYE en el panel de la propiedad "to".
// Sin `moves` (o si ninguno aplica a la propiedad pedida) la consulta es la
// de siempre, a nivel de cuenta.

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

function getToken() {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw Object.assign(new Error("META_ACCESS_TOKEN no está configurado en Vercel."), { statusCode: 501 });
  }
  return token;
}

function timeRangeFor(days) {
  const until = new Date();
  const since = new Date(until.getTime() - days * 86400000);
  return JSON.stringify({
    since: since.toISOString().slice(0, 10),
    until: until.toISOString().slice(0, 10),
  });
}

// Sigue "paging.next" hasta agotar todas las páginas (a nivel campaña + región
// una cuenta puede pasar de una página).
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

// ---- Camino normal: breakdown por región a nivel de cuenta ----
async function fetchMetaGeoBreakdown(accountId, days) {
  const token = getToken();
  const fields = ["spend", "impressions", "reach", "ctr", "actions"].join(",");
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/insights` +
    `?fields=${fields}&breakdowns=region&level=account&time_range=${encodeURIComponent(timeRangeFor(days))}` +
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

// ---- Camino con campañas reasignadas: breakdown por región a nivel campaña ----
async function fetchCampaignRegionRows(accountId, days) {
  const token = getToken();
  const fields = ["campaign_name", "spend", "impressions", "reach", "clicks", "actions"].join(",");
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/act_${accountId}/insights` +
    `?fields=${fields}&breakdowns=region&level=campaign&time_range=${encodeURIComponent(timeRangeFor(days))}` +
    `&limit=500&access_token=${encodeURIComponent(token)}`;
  return fetchAllPages(url);
}

// Valida y limpia el parámetro `moves` que manda el frontend.
function parseMoves(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error("El parámetro moves no es un JSON válido."), { statusCode: 400 });
  }
  if (!Array.isArray(parsed) || parsed.length > 50) {
    throw Object.assign(new Error("El parámetro moves debe ser una lista de hasta 50 elementos."), { statusCode: 400 });
  }
  return parsed.map((m) => {
    const ok = m && typeof m.campaign === "string" && AD_ACCOUNTS[m.from] && AD_ACCOUNTS[m.to];
    if (!ok) throw Object.assign(new Error("Cada elemento de moves necesita campaign, from y to (Tulum u Holbox)."), { statusCode: 400 });
    return { campaign: m.campaign, from: m.from, to: m.to };
  });
}

async function fetchReassignedGeoBreakdown(property, days, moves) {
  const outNames = new Set(moves.filter((m) => m.from === property && m.to !== property).map((m) => m.campaign));
  const inByAccount = new Map(); // cuenta de origen -> Set de campañas que pertenecen a `property`
  for (const m of moves.filter((m) => m.to === property && m.from !== property)) {
    if (!inByAccount.has(m.from)) inByAccount.set(m.from, new Set());
    inByAccount.get(m.from).add(m.campaign);
  }

  const rows = [];
  const own = await fetchCampaignRegionRows(AD_ACCOUNTS[property], days);
  rows.push(...own.filter((r) => !outNames.has(r.campaign_name)));
  for (const [fromProperty, names] of inByAccount) {
    const other = await fetchCampaignRegionRows(AD_ACCOUNTS[fromProperty], days);
    rows.push(...other.filter((r) => names.has(r.campaign_name)));
  }

  const byRegion = new Map();
  for (const row of rows) {
    const region = row.region || "Sin especificar";
    if (!byRegion.has(region)) {
      byRegion.set(region, { region, spend: 0, impressions: 0, reach: 0, clicks: 0, leads: 0, messagingConvos: 0 });
    }
    const acc = byRegion.get(region);
    const actions = row.actions || [];
    acc.spend += Number(row.spend) || 0;
    acc.impressions += Number(row.impressions) || 0;
    acc.reach += Number(row.reach) || 0; // OJO: suma por campaña, puede contar dos veces a una misma persona
    acc.clicks += Number(row.clicks) || 0;
    acc.leads += extractAction(actions, "onsite_conversion.lead_grouped");
    acc.messagingConvos += extractAction(actions, "onsite_conversion.messaging_first_reply");
  }

  return Array.from(byRegion.values())
    .map(({ clicks, ...r }) => ({ ...r, ctr: r.impressions > 0 ? (clicks / r.impressions) * 100 : 0 }))
    .sort((a, b) => b.spend - a.spend);
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

  let relevantMoves;
  try {
    const moves = parseMoves(req.query.moves ? req.query.moves.toString() : "");
    relevantMoves = moves
      .filter((m) => m.from !== m.to && (m.from === property || m.to === property))
      .sort((a, b) => (a.campaign + a.from).localeCompare(b.campaign + b.from));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
    return;
  }
  const reattributed = relevantMoves.length > 0;

  const cacheKey = `${property}:${days}:${JSON.stringify(relevantMoves)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    res.status(200).json({ property, days, rows: cached.rows, cached: true, reattributed });
    return;
  }

  try {
    const rows = reattributed
      ? await fetchReassignedGeoBreakdown(property, days, relevantMoves)
      : await fetchMetaGeoBreakdown(accountId, days);
    cache.set(cacheKey, { rows, at: Date.now() });
    res.status(200).json({ property, days, rows, cached: false, reattributed });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}
