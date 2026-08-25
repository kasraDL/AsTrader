// Thin client around the unofficial Agah online trading API.
// Login stays outside the bot: the user pastes a fresh Bearer token after
// solving Agah captcha in the browser. This code never bypasses captcha.

const BASE = "https://tseonlineapi.agah.com/api/v1";
const CHART_BASE = "https://tsembdpapi.agah.com/api/mbdp/v1";
const WEB_ORIGIN = "https://online.agah.com";
const INSTRUMENTS_URL = `${BASE}/instruments/InstrumentsWithNote`;
const MARKET_WATCHES_URL = `${BASE}/usermarketwatches`;
const CATALOG_CACHE_KEY = "cache:instrument-catalog";
const CATALOG_TTL = 60;

const PRICE_FIELD_CANDIDATES = [
  "LastTradedPrice", "LastPrice", "ClosePrice", "Close", "PDrCotVal",
  "PClosing", "LastTrade", "Price",
];
const CHANGE_FIELD_CANDIDATES = ["PriceChange", "PriceChangePercent", "PClosingPercent", "PriceVar"];
const VOLUME_FIELD_CANDIDATES = ["TotalTradeQuantity", "TradeQuantity", "Volume", "QTotTran5J"];

const ACCOUNT_PATHS = {
  remaining: [
    "/remainings",
    "/remaining",
    "/financialAccounts/remainings",
    "/financialAccounts/remaining",
    "/customerRemainings",
    "/customers/remaining",
  ],
  assets: [
    "/assets",
    "/asset",
    "/portfolio",
    "/portfolios",
    "/customerAssets",
    "/assetPortfolios",
    "/portfo",
  ],
  orders: [
    "/orders",
    "/order/open",
    "/openOrders",
    "/order",
  ],
};

export function normalizeToken(value) {
  return String(value || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

export function normalizeUserIdentifier(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

async function getAuth(env) {
  const [token, userIdentifier] = await Promise.all([
    env.BOT_KV.get("agah:token"),
    env.BOT_KV.get("agah:userIdentifier"),
  ]);
  const resolvedToken = normalizeToken(token);
  const resolvedUserIdentifier = normalizeUserIdentifier(env.AGAH_USER_IDENTIFIER || userIdentifier);
  if (!resolvedToken) throw new Error("NO_TOKEN");
  return { token: resolvedToken, userIdentifier: resolvedUserIdentifier };
}

function authHeaders({ token, userIdentifier }) {
  const h = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
    "Authorization": `Bearer ${token}`,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:154.0) Gecko/20100101 Firefox/154.0",
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
  };
  if (userIdentifier) h.UserIdentifier = userIdentifier;
  return h;
}

async function readError(res, label) {
  const body = await res.text();
  return new Error(`${label} failed: ${res.status} ${body.slice(0, 2000)}`);
}

function parseCsvLine(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

function parseInstrumentCsv(csv, wantedNscId = null) {
  const lines = String(csv || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  const headers = parseCsvLine(lines[0]);
  const index = Object.fromEntries(headers.map((h, i) => [h.trim(), i]));
  const nscIndex = index.NscId;
  if (nscIndex == null) return null;
  for (const line of lines.slice(1)) {
    const row = parseCsvLine(line);
    if (wantedNscId && row[nscIndex] !== wantedNscId) continue;
    return Object.fromEntries(headers.map((h, i) => [h.trim(), row[i] ?? ""]));
  }
  return null;
}

function parseInstrumentCsvAll(csv) {
  const lines = String(csv || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""])));
  }
  return rows;
}

function parseInstrumentCsvMatches(csv, query, limit = 8) {
  const q = String(query || "").trim().toLocaleLowerCase("fa-IR");
  const results = [];
  for (const row of parseInstrumentCsvAll(csv)) {
    if (results.length >= limit) break;
    const haystack = [row.Name, row.CompanyName, row.NscId].join(" ").toLocaleLowerCase("fa-IR");
    if (haystack.includes(q)) results.push(row);
  }
  return results;
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== "") return row[key];
  }
  return null;
}

function toPublicQuote(instrument) {
  return {
    symbol: instrument.Name || "",
    name: instrument.CompanyName || "",
    nscId: instrument.NscId || "",
    marketTitle: instrument.MarketTitle || "",
    instrumentGroupCode: instrument.InstrumentGroupCode || "",
    tseId: instrument.TseId || "",
    price: pickField(instrument, PRICE_FIELD_CANDIDATES),
    change: pickField(instrument, CHANGE_FIELD_CANDIDATES),
    volume: pickField(instrument, VOLUME_FIELD_CANDIDATES),
  };
}

async function agahGet(env, path) {
  const auth = await getAuth(env);
  const url = path.startsWith("http") ? path : `${BASE}${path}`;
  const res = await fetch(url, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function firstWorking(env, paths) {
  const errors = [];
  for (const path of paths) {
    try {
      const result = await agahGet(env, path);
      if (result.ok && result.json) {
        if (result.json.isSuccess === false) {
          errors.push(`${path}: ${JSON.stringify(result.json).slice(0, 180)}`);
          continue;
        }
        return { path, data: result.json.data ?? result.json, raw: result.json };
      }
      errors.push(`${path}: HTTP ${result.status}`);
    } catch (err) {
      if (err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN") throw err;
      errors.push(`${path}: ${err.message}`);
    }
  }
  return { path: null, data: null, errors };
}

async function getUserMarketWatches(env) {
  const auth = await getAuth(env);
  const res = await fetch(MARKET_WATCHES_URL, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "usermarketwatches");
  const payload = await res.json();
  if (payload?.isSuccess === false) throw new Error(`usermarketwatches failed: ${JSON.stringify(payload)}`);
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function validateAgahAuth(env) {
  const watches = await getUserMarketWatches(env);
  return { ok: true, marketWatchCount: watches.length };
}

async function getMarketWatchInstrumentCatalog(env) {
  const watches = await getUserMarketWatches(env);
  const watch =
    watches.find((w) => w?.includeAssetInstruments === true && Number(w?.id) > 0) ||
    watches.find((w) => Number(w?.id) > 0);
  if (!watch) throw new Error("no market watch available");

  const auth = await getAuth(env);
  const url = `${BASE}/usermarketwatches/${encodeURIComponent(watch.id)}/instruments/csv`;
  const res = await fetch(url, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "market-watch instruments csv");
  const payload = await res.json();
  if (payload?.isSuccess === false) throw new Error(`market-watch instruments csv failed: ${JSON.stringify(payload)}`);
  return String(payload?.data || "");
}

async function getInstrumentCatalog(env, { force = false } = {}) {
  if (!force) {
    const cached = await env.BOT_KV.get(CATALOG_CACHE_KEY);
    if (cached) return cached;
  }

  let csv = "";
  try {
    csv = await getMarketWatchInstrumentCatalog(env);
  } catch (err) {
    if (err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN") throw err;
  }

  if (!csv.includes("NscId")) {
    const auth = await getAuth(env);
    const res = await fetch(INSTRUMENTS_URL, { headers: authHeaders(auth) });
    if (res.status === 401) throw new Error("TOKEN_EXPIRED");
    if (!res.ok) throw await readError(res, "InstrumentsWithNote");
    const payload = await res.json();
    if (payload?.isSuccess === false) throw new Error(`InstrumentsWithNote failed: ${JSON.stringify(payload)}`);
    csv = String(payload?.data || "");
  }

  await env.BOT_KV.put(CATALOG_CACHE_KEY, csv, { expirationTtl: CATALOG_TTL });
  return csv;
}

async function getInstrumentFromCatalog(env, nscId) {
  const instrument = parseInstrumentCsv(await getInstrumentCatalog(env), nscId);
  if (!instrument) throw new Error(`instrument not found: ${nscId}`);
  return instrument;
}

export async function searchInstruments(env, query, limit = 8) {
  const matches = parseInstrumentCsvMatches(await getInstrumentCatalog(env), query, limit);
  return matches.map(toPublicQuote);
}

export async function searchInstrumentsPublic(env, query, limit = 8) {
  return searchInstruments(env, query, limit);
}

export async function listMarket(env, { q = "", market = "", page = 1, pageSize = 80 } = {}) {
  const rows = parseInstrumentCsvAll(await getInstrumentCatalog(env)).map(toPublicQuote);
  const query = q.trim().toLocaleLowerCase("fa-IR");
  const marketFilter = market.trim();
  const filtered = rows.filter((row) => {
    if (marketFilter && row.marketTitle !== marketFilter) return false;
    if (!query) return true;
    const haystack = `${row.symbol} ${row.name} ${row.nscId}`.toLocaleLowerCase("fa-IR");
    return haystack.includes(query);
  });
  const markets = [...new Set(rows.map((r) => r.marketTitle).filter(Boolean))];
  const start = Math.max(0, (Number(page) - 1) * Number(pageSize));
  return {
    total: filtered.length,
    page: Number(page) || 1,
    pageSize: Number(pageSize) || 80,
    markets,
    results: filtered.slice(start, start + Number(pageSize)),
  };
}

export async function getInstrumentQuote(env, nscId) {
  return toPublicQuote(await getInstrumentFromCatalog(env, nscId));
}

function categoryIdFromMarketTitle(marketTitle) {
  const market = String(marketTitle || "").trim();
  if (market === "بورس") return "272de7e4-5c65-463a-92c2-535e2caa30fe";
  if (market === "فرابورس" || market === "پایه فرابورس") return "0be2ade7-d826-4760-920c-fc4b6b96d427";
  return null;
}

export async function getLiveSegmentation(env, nscId) {
  const instrument = await getInstrumentFromCatalog(env, nscId);
  const categoryId = categoryIdFromMarketTitle(instrument.MarketTitle);
  if (!categoryId) throw new Error(`category not mapped for market: ${instrument.MarketTitle || "unknown"}`);
  return { nscId, marketTitle: instrument.MarketTitle || "", categoryId, instrument };
}

function normalizeCandles(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((c) => ({
      time: c.time ?? c.t ?? c.date ?? null,
      open: Number(c.open ?? c.o),
      high: Number(c.high ?? c.h),
      low: Number(c.low ?? c.l),
      last: Number(c.last ?? c.close ?? c.c),
      volume: Number(c.volume ?? c.v ?? 0),
    }))
    .filter((c) => Number.isFinite(c.last));
}

export async function getDailyCandles(env, nscId, { fromUnix, toUnix }) {
  const auth = await getAuth(env);
  const symbol = `${nscId}-2`;
  const url = `${CHART_BASE}/TradingViews/history?symbol=${encodeURIComponent(symbol)}&from=${fromUnix}&to=${toUnix}&resolution=1D&symbolType=2`;
  const res = await fetch(url, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "history");
  const json = await res.json();
  const raw = json?.data?.candles ?? (Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []);
  return normalizeCandles(raw);
}

export async function getDelegatedBankAccounts(env) {
  const auth = await getAuth(env);
  const res = await fetch(`${BASE}/financialAccounts/delegatedBankAccounts`, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "delegatedBankAccounts");
  return res.json();
}

export async function getAccountSnapshot(env) {
  const [remaining, assets, orders] = await Promise.all([
    firstWorking(env, ACCOUNT_PATHS.remaining),
    firstWorking(env, ACCOUNT_PATHS.assets),
    firstWorking(env, ACCOUNT_PATHS.orders),
  ]);
  return {
    remaining: remaining.data,
    remainingPath: remaining.path,
    assets: assets.data,
    assetsPath: assets.path,
    orders: orders.data,
    ordersPath: orders.path,
    probes: {
      remaining: remaining.errors || [],
      assets: assets.errors || [],
      orders: orders.errors || [],
    },
  };
}

function holdingsFromUnknown(payload) {
  const items = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== "object") return;
    const nscId = node.nscId || node.NscId || node.insCode || node.instrumentId;
    const qty = Number(node.quantity ?? node.qty ?? node.assetQuantity ?? node.remainQuantity ?? node.volume);
    if (nscId && Number.isFinite(qty) && qty > 0) {
      items.push({
        nscId: String(nscId),
        symbol: node.symbol || node.name || node.Name || String(nscId),
        quantity: qty,
      });
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(payload);
  return items;
}

export async function getHoldingsMap(env) {
  try {
    const snapshot = await getAccountSnapshot(env);
    const holdings = holdingsFromUnknown(snapshot.assets);
    return { ok: !!snapshot.assetsPath, holdings, snapshot };
  } catch (err) {
    if (err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN") throw err;
    return { ok: false, holdings: [], error: err.message };
  }
}

export async function placeOrder(env, { categoryId, bankAccountId = 0, nscId, orderSide, price, quantity, validityType = 1 }) {
  const auth = await getAuth(env);
  const body = {
    categoryId,
    bankAccountId,
    disclosedQuantity: null,
    nscId,
    orderSide,
    price,
    quantity,
    validityType,
    minimumQuantity: null,
    validityDate: null,
    creationDate: new Date().toISOString(),
  };
  const res = await fetch(`${BASE}/order`, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "order");
  const data = await res.json();
  if (data.isSuccess === false) throw new Error(`order failed: ${JSON.stringify(data)}`);
  return data;
}

export async function getAgahDiagnostics(env, nscId = "IRO1IKCO0001") {
  const auth = await getAuth(env);
  const result = { tokenPresent: true, userIdentifierPresent: !!auth.userIdentifier, nscId, checks: {} };
  const now = Math.floor(Date.now() / 1000);
  const checks = [
    ["marketWatches", MARKET_WATCHES_URL],
    ["instrumentCatalog", INSTRUMENTS_URL],
    ["history", `${CHART_BASE}/TradingViews/history?symbol=${nscId}-2&from=${now - 30 * 86400}&to=${now}&resolution=1D&symbolType=2`],
    ["chartdata", `${CHART_BASE}/instruments/${encodeURIComponent(nscId)}/chartdata?duration=1`],
  ];
  for (const [name, url] of checks) {
    try {
      const res = await fetch(url, { headers: authHeaders(auth) });
      const text = await res.text();
      result.checks[name] = {
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get("content-type") || "",
        bodyPreview: text.slice(0, 1200),
      };
    } catch (err) {
      result.checks[name] = { networkError: err.message };
    }
  }
  try {
    const watches = await getUserMarketWatches(env);
    result.marketWatches = watches.map((w) => ({
      id: w?.id,
      title: w?.title,
      includeAssetInstruments: !!w?.includeAssetInstruments,
    }));
    const csv = await getMarketWatchInstrumentCatalog(env);
    result.marketWatchCatalog = {
      ok: true,
      bytes: csv.length,
      hasNscId: csv.includes("NscId"),
      hasMarketTitle: csv.includes("MarketTitle"),
    };
    const instrument = parseInstrumentCsv(csv, nscId);
    result.instrument = instrument
      ? {
          symbol: instrument.Name || "",
          marketTitle: instrument.MarketTitle || "",
          categoryId: categoryIdFromMarketTitle(instrument.MarketTitle),
        }
      : null;
  } catch (err) {
    result.marketWatchCatalog = { ok: false, error: err.message };
  }
  try {
    result.account = await getAccountSnapshot(env);
  } catch (err) {
    result.account = { error: err.message };
  }
  return result;
}
