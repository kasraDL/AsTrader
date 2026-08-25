// Thin client around the (unofficial, reverse-engineered) Agah online trading API.
// Auth is handled OUTSIDE this bot: you log in manually in the browser (captcha +
// device-fingerprint are intentionally hard to automate), then send the fresh
// Bearer token to the bot via the dashboard. This module just uses whatever token
// is currently stored in KV.

const BASE = "https://tseonlineapi.agah.com/api/v1";
const CHART_BASE = "https://tsembdpapi.agah.com/api/mbdp/v1";

async function getAuth(env) {
  const token = await env.BOT_KV.get("agah:token");
  const userIdentifier = env.AGAH_USER_IDENTIFIER || (await env.BOT_KV.get("agah:userIdentifier"));
  if (!token) throw new Error("NO_TOKEN");
  return { token, userIdentifier };
}

function authHeaders({ token, userIdentifier }) {
  const h = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Authorization": `Bearer ${token}`,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/140.0 Safari/537.36",
    "Origin": "https://online.agah.com",
    "Referer": "https://online.agah.com/",
  };
  if (userIdentifier) h["UserIdentifier"] = userIdentifier;
  return h;
}

async function readError(res, label) {
  const body = await res.text();
  return new Error(`${label} failed: ${res.status} ${body.slice(0, 2000)}`);
}

// nscId e.g. "IRO1IKCO0001"
export async function getLiveSegmentation(env, nscId) {
  const auth = await getAuth(env);
  const res = await fetch(`${BASE}/instruments/live-segmentation/${nscId}`, {
    headers: authHeaders(auth),
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "live-segmentation");
  return res.json();
}

export async function getDailyCandles(env, nscId, { fromUnix, toUnix }) {
  const auth = await getAuth(env);
  const symbol = `${nscId}-2`;
  const url = `${CHART_BASE}/TradingViews/history?symbol=${symbol}&from=${fromUnix}&to=${toUnix}&resolution=1D&symbolType=2`;
  const res = await fetch(url, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "history");
  const json = await res.json();
  return json?.data?.candles ?? [];
}

export async function getDelegatedBankAccounts(env) {
  const auth = await getAuth(env);
  const res = await fetch(`${BASE}/financialAccounts/delegatedBankAccounts`, {
    headers: authHeaders(auth),
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw await readError(res, "delegatedBankAccounts");
  return res.json();
}

// orderSide: 1 = buy, 2 = sell
// validityType: 1 = day order
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
  if (data.isSuccess === false) {
    throw new Error(`order failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// Authenticated connectivity diagnostics. Never returns the Bearer token itself.
export async function getAgahDiagnostics(env, nscId = "IRO1IKCO0001") {
  const auth = await getAuth(env);
  const result = {
    tokenPresent: true,
    userIdentifierPresent: !!auth.userIdentifier,
    nscId,
    checks: {},
  };

  const checks = [
    ["segmentation", `${BASE}/instruments/live-segmentation/${nscId}`],
    ["bankAccounts", `${BASE}/financialAccounts/delegatedBankAccounts`],
  ];

  const now = Math.floor(Date.now() / 1000);
  checks.push([
    "history",
    `${CHART_BASE}/TradingViews/history?symbol=${nscId}-2&from=${now - 30 * 86400}&to=${now}&resolution=1D&symbolType=2`,
  ]);

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

  return result;
}
