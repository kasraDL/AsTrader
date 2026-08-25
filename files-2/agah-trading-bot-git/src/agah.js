// Thin client around the (unofficial, reverse-engineered) Agah online trading API.
// Auth is handled OUTSIDE this bot: you log in manually in the browser (captcha +
// device-fingerprint are intentionally hard to automate), then send the fresh
// Bearer token to the bot via the /settoken Telegram command. This module just
// uses whatever token is currently stored in KV.

const BASE = "https://tseonlineapi.agah.com/api/v1";

async function getAuth(env) {
  const token = await env.BOT_KV.get("agah:token");
  const userIdentifier = env.AGAH_USER_IDENTIFIER || (await env.BOT_KV.get("agah:userIdentifier"));
  if (!token) throw new Error("NO_TOKEN"); // caller should tell the user to /settoken
  return { token, userIdentifier };
}

function authHeaders({ token, userIdentifier }) {
  const h = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Authorization": `Bearer ${token}`,
  };
  if (userIdentifier) h["UserIdentifier"] = userIdentifier;
  return h;
}

// nscId e.g. "IRO1IKCO0001"
export async function getLiveSegmentation(env, nscId) {
  const auth = await getAuth(env);
  const res = await fetch(`${BASE}/instruments/live-segmentation/${nscId}`, {
    headers: authHeaders(auth),
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error(`live-segmentation failed: ${res.status}`);
  return res.json();
}

const CHART_BASE = "https://tsembdpapi.agah.com/api/mbdp/v1";

// Daily OHLCV candles (TradingView-UDF-style), confirmed working in the captured
// traffic. symbol is "<nscId>-2", resolution "1D". Returns candles:
// [{ first, high, last, low, quantity, change, since, realSince }, ...]
// first=open, last=close, quantity=volume.
export async function getDailyCandles(env, nscId, { fromUnix, toUnix }) {
  const auth = await getAuth(env);
  const symbol = `${nscId}-2`;
  const url = `${CHART_BASE}/TradingViews/history?symbol=${symbol}&from=${fromUnix}&to=${toUnix}&resolution=1D&symbolType=2`;
  const res = await fetch(url, { headers: authHeaders(auth) });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error(`history failed: ${res.status}`);
  const json = await res.json();
  return json?.data?.candles ?? [];
}

export async function getDelegatedBankAccounts(env) {
  const auth = await getAuth(env);
  const res = await fetch(`${BASE}/financialAccounts/delegatedBankAccounts`, {
    headers: authHeaders(auth),
  });
  if (res.status === 401) throw new Error("TOKEN_EXPIRED");
  if (!res.ok) throw new Error(`delegatedBankAccounts failed: ${res.status}`);
  return res.json();
}

// orderSide: 1 = buy, 2 = sell (as observed in the captured traffic)
// validityType: 1 = day order (as observed)
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
  const data = await res.json();
  if (!res.ok || data.isSuccess === false) {
    throw new Error(`order failed: ${JSON.stringify(data)}`);
  }
  return data;
}
