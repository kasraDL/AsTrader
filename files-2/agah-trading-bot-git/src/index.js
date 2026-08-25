import { getAgahDiagnostics, getDailyCandles, getInstrumentQuote, getLiveSegmentation, placeOrder, searchInstruments, searchInstrumentsPublic } from "./agah.js";
import { smaCrossoverSignal } from "./signals.js";
import { notify } from "./telegram.js";

const DAY = 86400;
const MAX_LOG = 50;
const PENDING_INDEX_KEY = "pending:index";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });

    if (url.pathname.startsWith("/api/public/")) {
      if (request.method === "OPTIONS") return corsJson(null, 204);
      try {
        if (url.pathname === "/api/public/symbols" && request.method === "GET") {
          return corsJson(await publicSearchSymbols(env, url.searchParams.get("q") || ""));
        }
        if (url.pathname === "/api/public/quote" && request.method === "GET") {
          const nscId = url.searchParams.get("nscId");
          if (!nscId) return corsJson({ error: "nscId required" }, 400);
          return corsJson(await getInstrumentQuote(env, nscId));
        }
        if (url.pathname === "/api/public/candles" && request.method === "GET") {
          const nscId = url.searchParams.get("nscId");
          if (!nscId) return corsJson({ error: "nscId required" }, 400);
          const days = Math.min(Math.max(Number(url.searchParams.get("days") || 120), 5), 1000);
          const toUnix = Math.floor(Date.now() / 1000);
          const candles = await getDailyCandles(env, nscId, { fromUnix: toUnix - days * DAY, toUnix });
          return corsJson({ nscId, candles });
        }
        return corsJson({ error: "not found" }, 404);
      } catch (err) {
        const status = err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN" ? 503 : 500;
        return corsJson({ error: err.message }, status);
      }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        return json(await handleLogin(env, await request.json()));
      } catch (err) {
        const status = err.message === "TOKEN_EXPIRED" ? 401 : 400;
        return json({ error: err.message }, status);
      }
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      const key = request.headers.get("X-Dashboard-Key");
      if (key?.startsWith("sess_")) await env.BOT_KV.delete("session:" + key);
      return json({ ok: true });
    }

    if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);

    try {
      if (url.pathname === "/api/state" && request.method === "GET") {
        return json(await getState(env));
      }
      if (url.pathname === "/api/token" && request.method === "POST") {
        const body = await request.json();
        return json(await saveToken(env, body));
      }
      if (url.pathname === "/api/diagnostics/agah" && request.method === "GET") {
        const nscId = url.searchParams.get("nscId") || "IRO1IKCO0001";
        return json(await getAgahDiagnostics(env, nscId));
      }
      if (url.pathname === "/api/symbols/search" && request.method === "GET") {
        return json(await searchSymbols(env, url.searchParams.get("q") || ""));
      }
      if (url.pathname === "/api/watchlist" && request.method === "POST") {
        return json(await handleWatchlist(env, await request.json()));
      }
      if (url.pathname === "/api/check" && request.method === "POST") {
        ctx.waitUntil(runSignalCheck(env));
        return json({ ok: true });
      }
      const signalMatch = url.pathname.match(/^\/api\/signals\/([^/]+)\/(confirm|reject)$/);
      if (signalMatch && request.method === "POST") {
        const [, id, action] = signalMatch;
        return json(await handleSignalAction(env, id, action));
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSignalCheck(env));
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function corsJson(data, status = 200) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=15",
  };
  if (data === null) return new Response(null, { status, headers });
  return new Response(JSON.stringify(data), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

async function publicSearchSymbols(env, query) {
  const q = query.trim();
  if (q.length < 2) return { results: [] };
  return { results: await searchInstrumentsPublic(env, q, 8) };
}

function checkAuth(request, env) {
  const key = request.headers.get("X-Dashboard-Key");
  return !!env.DASHBOARD_PASSWORD && key === env.DASHBOARD_PASSWORD;
}

async function handleLogin(env, body) {
  const token = String(body?.token || "").trim().replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "").trim();
  const userIdentifier = String(body?.userIdentifier || "").trim().replace(/^['"]|['"]$/g, "").trim();
  if (!token) throw new Error("token required");

  await env.BOT_KV.put("agah:token", token);
  if (userIdentifier) await env.BOT_KV.put("agah:userIdentifier", userIdentifier);
  else await env.BOT_KV.delete("agah:userIdentifier");

  // Do not call /usermarketwatches during login. Agah can return an HTTP 500
  // HTML error from this endpoint even when the token can be used elsewhere.
  // Real API calls still return TOKEN_EXPIRED on HTTP 401.
  const session = `sess_${crypto.randomUUID()}`;
  await env.BOT_KV.put("session:" + session, JSON.stringify({ ts: Date.now() }), { expirationTtl: 12 * 3600 });
  await log(env, "توکن آگاه ذخیره شد و ورود به داشبورد انجام شد.");
  return { ok: true, session, validated: false };
}

async function saveToken(env, body) {
  const token = String(body?.token || "").trim().replace(/^Bearer\s+/i, "").replace(/^['"]|['"]$/g, "").trim();
  const userIdentifier = String(body?.userIdentifier || "").trim().replace(/^['"]|['"]$/g, "").trim();
  if (!token) return { error: "token required" };

  await env.BOT_KV.put("agah:token", token);
  if (userIdentifier) await env.BOT_KV.put("agah:userIdentifier", userIdentifier);
  else await env.BOT_KV.delete("agah:userIdentifier");

  await log(env, "توکن جدید ذخیره شد.");
  return { ok: true, stored: true, validated: false };
}

async function log(env, text) {
  const list = JSON.parse((await env.BOT_KV.get("log")) || "[]");
  list.push({ ts: Date.now(), text });
  while (list.length > MAX_LOG) list.shift();
  await env.BOT_KV.put("log", JSON.stringify(list));
}

async function getState(env) {
  const [token, watchlistRaw, logRaw, pendingIndexRaw] = await Promise.all([
    env.BOT_KV.get("agah:token"),
    env.BOT_KV.get("watchlist"),
    env.BOT_KV.get("log"),
    env.BOT_KV.get(PENDING_INDEX_KEY),
  ]);
  const watchlist = JSON.parse(watchlistRaw || "[]");
  const pendingIds = JSON.parse(pendingIndexRaw || "[]");
  const pending = [];
  const validIds = [];
  for (const id of pendingIds) {
    const raw = await env.BOT_KV.get(`pending:${id}`);
    if (raw) {
      pending.push({ id, ...JSON.parse(raw) });
      validIds.push(id);
    }
  }
  if (validIds.length !== pendingIds.length) {
    await env.BOT_KV.put(PENDING_INDEX_KEY, JSON.stringify(validIds));
  }
  return { hasToken: !!token, watchlist, pending, log: JSON.parse(logRaw || "[]") };
}

async function addPendingId(env, id) {
  const ids = JSON.parse((await env.BOT_KV.get(PENDING_INDEX_KEY)) || "[]");
  if (!ids.includes(id)) ids.push(id);
  await env.BOT_KV.put(PENDING_INDEX_KEY, JSON.stringify(ids.slice(-100)));
}

async function removePendingId(env, id) {
  const ids = JSON.parse((await env.BOT_KV.get(PENDING_INDEX_KEY)) || "[]");
  const next = ids.filter((item) => item !== id);
  await env.BOT_KV.put(PENDING_INDEX_KEY, JSON.stringify(next));
}

async function searchSymbols(env, query) {
  const q = query.trim();
  if (q.length < 2) return { results: [] };

  const raw = await searchInstruments(env, q, 8);
  const results = [];
  for (const item of raw) {
    let categoryId = null;
    let categoryError = null;
    try {
      const segmentation = await getLiveSegmentation(env, item.nscId);
      categoryId = segmentation.categoryId;
    } catch (err) {
      categoryError = err.message;
    }
    results.push({
      symbol: item.symbol,
      name: item.name,
      nscId: item.nscId,
      categoryId,
      categoryError,
      marketTitle: item.marketTitle,
      instrumentGroupCode: item.instrumentGroupCode,
      tseId: item.tseId,
    });
  }
  return { results };
}

async function handleWatchlist(env, body) {
  const list = JSON.parse((await env.BOT_KV.get("watchlist")) || "[]");
  if (body.action === "add") {
    if (!body.nscId || !body.categoryId || !body.quantity) throw new Error("nscId, categoryId, quantity required");
    const filtered = list.filter((w) => w.nscId !== body.nscId);
    filtered.push({ nscId: body.nscId, categoryId: body.categoryId, quantity: Number(body.quantity), symbol: body.symbol || body.nscId, name: body.name || "" });
    await env.BOT_KV.put("watchlist", JSON.stringify(filtered));
    await log(env, `${body.symbol || body.nscId} به واچ‌لیست اضافه شد.`);
  } else if (body.action === "remove") {
    await env.BOT_KV.put("watchlist", JSON.stringify(list.filter((w) => w.nscId !== body.nscId)));
    await log(env, `${body.nscId} از واچ‌لیست حذف شد.`);
  } else {
    throw new Error("invalid action");
  }
  return { ok: true };
}

async function handleSignalAction(env, id, action) {
  const raw = await env.BOT_KV.get(`pending:${id}`);
  if (!raw) return { error: "signal not found or expired" };
  const pending = JSON.parse(raw);
  await env.BOT_KV.delete(`pending:${id}`);
  await removePendingId(env, id);

  if (action === "reject") {
    await log(env, `❌ سیگنال ${pending.nscId} (${pending.side}) رد شد.`);
    return { ok: true };
  }

  const orderValue = pending.price * pending.quantity;
  const cap = Number(env.MAX_ORDER_VALUE_RIAL || 0);
  if (cap && orderValue > cap) {
    await log(env, `⛔️ سفارش ${pending.nscId} به دلیل عبور از سقف مجاز لغو شد.`);
    return { error: "exceeds MAX_ORDER_VALUE_RIAL" };
  }

  try {
    const result = await placeOrder(env, { categoryId: pending.categoryId, nscId: pending.nscId, orderSide: pending.side === "buy" ? 1 : 2, price: pending.price, quantity: pending.quantity });
    await log(env, `✅ سفارش ${pending.nscId} ثبت شد (decisionId: ${result?.data?.decisionId ?? "?"}).`);
    return { ok: true, result };
  } catch (err) {
    await log(env, `⚠️ خطا در ارسال سفارش ${pending.nscId}: ${err.message}`);
    return { error: err.message };
  }
}

async function runSignalCheck(env) {
  const list = JSON.parse((await env.BOT_KV.get("watchlist")) || "[]");
  if (!list.length) return;

  const toUnix = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - 200 * DAY;

  for (const item of list) {
    try {
      const candles = await getDailyCandles(env, item.nscId, { fromUnix, toUnix });
      if (!candles.length) continue;

      const result = smaCrossoverSignal(candles);
      if (result.signal === "hold") continue;

      const lastClose = candles[candles.length - 1].last;
      const signalId = crypto.randomUUID();
      const pending = { nscId: item.nscId, categoryId: item.categoryId, quantity: item.quantity, price: lastClose, side: result.signal, reason: result.reason, symbol: item.symbol || item.nscId, name: item.name || "" };
      await env.BOT_KV.put(`pending:${signalId}`, JSON.stringify(pending), { expirationTtl: 3600 });
      await addPendingId(env, signalId);
      await log(env, `📊 سیگنال ${result.signal === "buy" ? "خرید" : "فروش"} برای ${item.symbol || item.nscId} ثبت شد.`);
      await notify(env, `سیگنال جدید: ${item.symbol || item.nscId} (${result.signal}) - داشبورد رو چک کن.`);
    } catch (err) {
      if (err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN") {
        await log(env, "⚠️ توکن نامعتبر یا منقضی - از داشبورد توکن تازه ثبت کن.");
        return;
      }
      await log(env, `⚠️ خطا در بررسی ${item.nscId}: ${err.message}`);
    }
  }
}
