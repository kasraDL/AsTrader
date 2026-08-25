// Thin client around the (unofficial, reverse-engineered) Agah online trading API.
// Auth is handled OUTSIDE this bot: you log in manually in the browser, then send
// the fresh Bearer token to the bot via the dashboard.

const BASE = "https://tseonlineapi.agah.com/api/v1";
const CHART_BASE = "https://tsembdpapi.agah.com/api/mbdp/v1";
const WEB_ORIGIN = "https://online.agah.com";
const INSTRUMENTS_URL = `${BASE}/instruments/InstrumentsWithNote`;
const MARKET_WATCHES_URL = `${BASE}/usermarketwatches`;

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function normalizeUserIdentifier(value) {
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
    "Accept-Language": "en-US,en;q=0.9",
    "Authorization": `Bearer ${token}`,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:154.0) Gecko/20100101 Firefox/154.0",
    "Origin": WEB_ORIGIN,
    "Referer": `${WEB_ORIGIN}/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
  };
  if (userIdentifier) h["UserIdentifier"] = userIdentifier;
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
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(field); field = "";
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

function parseInstrumentCsvMatches(csv, query, limit = 8) {
  const lines = String(csv || "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const index = Object.fromEntries(headers.map((h, i) => [h.trim(), i]));
  const q = String(query || "").trim().toLocaleLowerCase("fa-IR");
  const fields = [index.Name, index.CompanyName, index.NscId].filter((i) => i != null);
  const results = [];
  for (const line of lines.slice(1)) {
    if (results.length >= limit) break;
    const row = parseCsvLine(line);
    const haystack = fields.map((i) => row[i] || "").join(" ").toLocaleLowerCase("fa-IR");
    if (haystack.includes(q)) results.push(Object.fromEntries(headers.map((h, i) => [h.trim(), row[i] ?? ""])));
  }
  return results;
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
  const watch = watches.find((w) => w?.includeAssetInstruments === true && Number(w?.id) > 0) || watches.find((w) => Number(w?.id) > 0);
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

async function getInstrumentCatalog(env) {
  try {
    const csv = await getMarketWatchInstrumentCatalog(env);
    if (csv.includes("NscId") && csv.includes("MarketTitle")) return csv;
  } catch (err) {
    if (err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN") throw err;
  }

  const auth = await getAuth(env);
  const res = await fetch(INSTRUMENTS_URL, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "InstrumentsWithNote");
  const payload = await res.json();
  if (payload?.isSuccess === false) throw new Error(`InstrumentsWithNote failed: ${JSON.stringify(payload)}`);
  return String(payload?.data || "");
}

async function getInstrumentFromCatalog(env, nscId) {
  const instrument = parseInstrumentCsv(await getInstrumentCatalog(env), nscId);
  if (!instrument) throw new Error(`instrument not found: ${nscId}`);
  return instrument;
}

export async function searchInstruments(env, query, limit = 8) {
  const matches = parseInstrumentCsvMatches(await getInstrumentCatalog(env), query, limit);
  return matches.map((instrument) => ({
    symbol: instrument.Name || "",
    name: instrument.CompanyName || "",
    nscId: instrument.NscId || "",
    marketTitle: instrument.MarketTitle || "",
    instrumentGroupCode: instrument.InstrumentGroupCode || "",
    tseId: instrument.TseId || "",
  }));
}

const PRICE_FIELD_CANDIDATES = [
  "LastTradedPrice", "LastPrice", "ClosePrice", "Close", "PDrCotVal",
  "PClosing", "LastTrade", "Price",
];
const CHANGE_FIELD_CANDIDATES = ["PriceChange", "PriceChangePercent", "PClosingPercent", "PriceVar"];

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
    price: pickField(instrument, PRICE_FIELD_CANDIDATES),
    change: pickField(instrument, CHANGE_FIELD_CANDIDATES),
    raw: instrument,
  };
}

export async function searchInstrumentsPublic(env, query, limit = 8) {
  const matches = parseInstrumentCsvMatches(await getInstrumentCatalog(env), query, limit);
  return matches.map(toPublicQuote);
}

export async function getInstrumentQuote(env, nscId) {
  const instrument = await getInstrumentFromCatalog(env, nscId);
  return toPublicQuote(instrument);
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

export async function getDailyCandles(env, nscId, { fromUnix, toUnix }) {
  const auth = await getAuth(env);
  const symbol = `${nscId}-2`;
  const url = `${CHART_BASE}/TradingViews/history?symbol=${encodeURIComponent(symbol)}&from=${fromUnix}&to=${toUnix}&resolution=1D&symbolType=2`;
  const res = await fetch(url, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "history");
  const json = await res.json();
  return json?.data?.candles ?? [];
}

export async function getDelegatedBankAccounts(env) {
  const auth = await getAuth(env);
  const res = await fetch(`${BASE}/financialAccounts/delegatedBankAccounts`, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "delegatedBankAccounts");
  return res.json();
}

export async function placeOrder(env, { categoryId, bankAccountId = 0, nscId, orderSide, price, quantity, validityType = 1 }) {
  const auth = await getAuth(env);
  const body = { categoryId, bankAccountId, disclosedQuantity: null, nscId, orderSide, price, quantity, validityType, minimumQuantity: null, validityDate: null, creationDate: new Date().toISOString() };
  const res = await fetch(`${BASE}/order`, { method: "POST", headers: authHeaders(auth), body: JSON.stringify(body) });
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
      result.checks[name] = { status: res.status, ok: res.ok, contentType: res.headers.get("content-type") || "", bodyPreview: text.slice(0, 1200) };
    } catch (err) {
      result.checks[name] = { networkError: err.message };
    }
  }
  try {
    const watches = await getUserMarketWatches(env);
    result.marketWatches = watches.map((w) => ({ id: w?.id, title: w?.title, includeAssetInstruments: !!w?.includeAssetInstruments }));
    const csv = await getMarketWatchInstrumentCatalog(env);
    result.marketWatchCatalog = { ok: true, bytes: csv.length, hasNscId: csv.includes("NscId"), hasMarketTitle: csv.includes("MarketTitle") };
    const instrument = parseInstrumentCsv(csv, nscId);
    result.instrument = instrument ? { symbol: instrument.Name || "", marketTitle: instrument.MarketTitle || "", categoryId: categoryIdFromMarketTitle(instrument.MarketTitle) } : null;
  } catch (err) {
    result.marketWatchCatalog = { ok: false, error: err.message };
  }
  return result;
}
