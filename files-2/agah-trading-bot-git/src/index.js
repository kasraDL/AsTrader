import {
  getAccountSnapshot,
  getAgahDiagnostics,
  getDailyCandles,
  getHoldingsMap,
  getInstrumentQuote,
  getLiveSegmentation,
  listMarket,
  normalizeToken,
  normalizeUserIdentifier,
  placeOrder,
  searchInstruments,
  validateAgahAuth,
} from "./agah.js";
import { analyzeInstrument, canAutoTrade, defaultSettings, sizeQuantity, tehranDateKey } from "./engine.js";
import { notify } from "./telegram.js";

const DAY = 86400;
const MAX_LOG = 80;
const PENDING_INDEX_KEY = "pending:index";
const SETTINGS_KEY = "bot:settings";
const DAILY_KEY = "bot:daily";
const SESSION_PREFIX = "session:";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });

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
      if (key?.startsWith("sess_")) await env.BOT_KV.delete(SESSION_PREFIX + key);
      return json({ ok: true });
    }

    if (!(await checkAuth(request, env))) return json({ error: "unauthorized" }, 401);

    try {
      if (url.pathname === "/api/state" && request.method === "GET") return json(await getState(env));
      if (url.pathname === "/api/token" && request.method === "POST") return json(await saveToken(env, await request.json()));
      if (url.pathname === "/api/market" && request.method === "GET") {
        return json(await listMarket(env, {
          q: url.searchParams.get("q") || "",
          market: url.searchParams.get("market") || "",
          page: Number(url.searchParams.get("page") || 1),
          pageSize: Math.min(150, Number(url.searchParams.get("pageSize") || 80)),
        }));
      }
      if (url.pathname === "/api/quote" && request.method === "GET") {
        const nscId = url.searchParams.get("nscId");
        if (!nscId) return json({ error: "nscId required" }, 400);
        return json(await getInstrumentQuote(env, nscId));
      }
      if (url.pathname === "/api/candles" && request.method === "GET") {
        const nscId = url.searchParams.get("nscId");
        if (!nscId) return json({ error: "nscId required" }, 400);
        const days = Math.min(Math.max(Number(url.searchParams.get("days") || 180), 5), 1000);
        const toUnix = Math.floor(Date.now() / 1000);
        const candles = await getDailyCandles(env, nscId, { fromUnix: toUnix - days * DAY, toUnix });
        return json({ nscId, candles, analysis: candles.length ? analyzeInstrument(candles) : null });
      }
      if (url.pathname === "/api/account" && request.method === "GET") return json(await getAccountSnapshot(env));
      if (url.pathname === "/api/settings" && request.method === "GET") return json(await getSettings(env));
      if (url.pathname === "/api/settings" && request.method === "POST") return json(await saveSettings(env, await request.json()));
      if (url.pathname === "/api/diagnostics/agah" && request.method === "GET") {
        return json(await getAgahDiagnostics(env, url.searchParams.get("nscId") || "IRO1IKCO0001"));
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
      const status = err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN" ? 401 : 500;
      return json({ error: err.message }, status);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSignalCheck(env));
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function checkAuth(request, env) {
  const key = request.headers.get("X-Dashboard-Key");
  if (!key) return false;
  if (env.DASHBOARD_PASSWORD && key === env.DASHBOARD_PASSWORD) return true;
  const session = await env.BOT_KV.get(SESSION_PREFIX + key);
  return !!session;
}

async function handleLogin(env, body) {
  const token = normalizeToken(body?.token);
  const userIdentifier = normalizeUserIdentifier(body?.userIdentifier);
  if (!token) throw new Error("token required");

  // Store the token and create the dashboard session without calling
  // /usermarketwatches. That endpoint can return a 500 HTML error even when
  // the supplied Bearer token is otherwise usable. Actual Agah API calls
  // below still detect HTTP 401 and report TOKEN_EXPIRED when appropriate.
  await env.BOT_KV.put("agah:token", token);
  if (userIdentifier) await env.BOT_KV.put("agah:userIdentifier", userIdentifier);
  else await env.BOT_KV.delete("agah:userIdentifier");

  const session = `sess_${crypto.randomUUID()}`;
  await env.BOT_KV.put(SESSION_PREFIX + session, JSON.stringify({ ts: Date.now() }), { expirationTtl: 12 * 3600 });
  await log(env, "توکن آگاه ذخیره شد و ورود به داشبورد انجام شد.");
  return { ok: true, session, validated: false };
}

async function saveToken(env, body) {
  const token = normalizeToken(body?.token);
  const userIdentifier = normalizeUserIdentifier(body?.userIdentifier);
  if (!token) return { error: "token required" };
  await env.BOT_KV.put("agah:token", token);
  if (userIdentifier) await env.BOT_KV.put("agah:userIdentifier", userIdentifier);
  else await env.BOT_KV.delete("agah:userIdentifier");

  // Do not make saving a token depend on /usermarketwatches. The token is
  // stored immediately; downstream API calls will surface a real 401 if it
  // has expired or is otherwise rejected by Agah.
  await log(env, "توکن جدید ذخیره شد.");
  return { ok: true, stored: true, validated: false };
}

async function log(env, text) {
  const list = JSON.parse((await env.BOT_KV.get("log")) || "[]");
  list.push({ ts: Date.now(), text });
  while (list.length > MAX_LOG) list.shift();
  await env.BOT_KV.put("log", JSON.stringify(list));
}

async function getSettings(env) {
  const stored = JSON.parse((await env.BOT_KV.get(SETTINGS_KEY)) || "{}");
  return { ...defaultSettings(env), ...stored };
}

async function saveSettings(env, body) {
  const current = await getSettings(env);
  const next = {
    ...current,
    autoTrade: Boolean(body.autoTrade),
    maxOrderValueRial: Math.max(0, Number(body.maxOrderValueRial ?? current.maxOrderValueRial)),
    maxDailyOrders: Math.max(0, Number(body.maxDailyOrders ?? current.maxDailyOrders)),
    riskPercent: Math.max(1, Math.min(20, Number(body.riskPercent ?? current.riskPercent))),
    defaultQuantity: Math.max(0, Number(body.defaultQuantity ?? current.defaultQuantity)),
    sellOnlyHoldings: body.sellOnlyHoldings !== false,
    minScore: Math.max(0, Math.min(100, Number(body.minScore ?? current.minScore))),
  };
  await env.BOT_KV.put(SETTINGS_KEY, JSON.stringify(next));
  await log(env, next.autoTrade ? "اتوماسیون خرید/فروش روشن شد." : "اتوماسیون خاموش شد. سفارش‌ها فقط پس از تایید دستی ارسال می‌شوند.");
  return next;
}

async function getDaily(env) {
  const key = tehranDateKey();
  const stored = JSON.parse((await env.BOT_KV.get(DAILY_KEY)) || "{}");
  if (stored.date !== key) {
    const fresh = { date: key, orders: 0 };
    await env.BOT_KV.put(DAILY_KEY, JSON.stringify(fresh));
    return fresh;
  }
  return stored;
}

async function bumpDailyOrders(env) {
  const daily = await getDaily(env);
  daily.orders = (daily.orders || 0) + 1;
  await env.BOT_KV.put(DAILY_KEY, JSON.stringify(daily));
  return daily;
}

async function getState(env) {
  const [token, watchlistRaw, logRaw, pendingIndexRaw, settings, daily] = await Promise.all([
    env.BOT_KV.get("agah:token"),
    env.BOT_KV.get("watchlist"),
    env.BOT_KV.get("log"),
    env.BOT_KV.get(PENDING_INDEX_KEY),
    getSettings(env),
    getDaily(env),
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
  return { hasToken: !!token, watchlist, pending, log: JSON.parse(logRaw || "[]"), settings, daily };
}

async function addPendingId(env, id) {
  const ids = JSON.parse((await env.BOT_KV.get(PENDING_INDEX_KEY)) || "[]");
  if (!ids.includes(id)) ids.push(id);
  await env.BOT_KV.put(PENDING_INDEX_KEY, JSON.stringify(ids));
}

async function removePendingId(env, id) {
  const ids = JSON.parse((await env.BOT_KV.get(PENDING_INDEX_KEY)) || "[]");
  await env.BOT_KV.put(PENDING_INDEX_KEY, JSON.stringify(ids.filter((x) => x !== id)));
}

async function searchSymbols(env, q) {
  if (!q.trim()) return [];
  return searchInstruments(env, q.trim(), 8);
}

async function handleWatchlist(env, body) {
  const current = JSON.parse((await env.BOT_KV.get("watchlist")) || "[]");
  const action = body?.action;
  const nscId = String(body?.nscId || "").trim();
  if (action === "add" && nscId) {
    const quote = await getInstrumentQuote(env, nscId);
    if (!current.some((x) => x.nscId === nscId)) current.push(quote);
  } else if (action === "remove" && nscId) {
    const next = current.filter((x) => x.nscId !== nscId);
    await env.BOT_KV.put("watchlist", JSON.stringify(next));
    return next;
  }
  await env.BOT_KV.put("watchlist", JSON.stringify(current));
  return current;
}

async function runSignalCheck(env) {
  const settings = await getSettings(env);
  const watchlist = JSON.parse((await env.BOT_KV.get("watchlist")) || "[]");
  if (!watchlist.length) return;
  for (const item of watchlist) {
    try {
      const toUnix = Math.floor(Date.now() / 1000);
      const candles = await getDailyCandles(env, item.nscId, { fromUnix: toUnix - 180 * DAY, toUnix });
      if (candles.length < 30) continue;
      const analysis = analyzeInstrument(candles);
      if (!analysis?.signal || analysis.score < settings.minScore) continue;
      const id = crypto.randomUUID();
      const pending = { id, nscId: item.nscId, symbol: item.symbol, analysis, createdAt: Date.now() };
      await env.BOT_KV.put(`pending:${id}`, JSON.stringify(pending), { expirationTtl: 24 * 3600 });
      await addPendingId(env, id);
      await log(env, `سیگنال ${analysis.signal} برای ${item.symbol} ایجاد شد.`);
      await notify(env, pending);
    } catch (err) {
      await log(env, `⚠️ بررسی ${item.symbol || item.nscId} ناموفق بود: ${err.message}`);
    }
  }
}

async function handleSignalAction(env, id, action) {
  const raw = await env.BOT_KV.get(`pending:${id}`);
  if (!raw) return { error: "signal not found" };
  const pending = JSON.parse(raw);
  if (action === "reject") {
    await env.BOT_KV.delete(`pending:${id}`);
    await removePendingId(env, id);
    await log(env, `سیگنال ${pending.symbol || pending.nscId} رد شد.`);
    return { ok: true, action: "rejected" };
  }
  if (action !== "confirm") return { error: "invalid action" };
  const settings = await getSettings(env);
  const daily = await getDaily(env);
  if (!canAutoTrade(settings) && !settings.allowManualConfirm) {
    await log(env, `تایید دستی ${pending.symbol || pending.nscId} مجاز نیست.`);
    return { error: "manual confirmation disabled" };
  }
  if (daily.orders >= settings.maxDailyOrders) return { error: "daily order limit reached" };
  const quantity = await sizeQuantity(env, pending.nscId, settings, pending.analysis);
  if (!quantity) return { error: "quantity could not be determined" };
  const result = await placeOrder(env, {
    nscId: pending.nscId,
    side: pending.analysis.signal === "BUY" ? "buy" : "sell",
    quantity,
    price: pending.analysis.price,
  });
  await bumpDailyOrders(env);
  await env.BOT_KV.delete(`pending:${id}`);
  await removePendingId(env, id);
  await log(env, `سفارش ${pending.analysis.signal} برای ${pending.symbol || pending.nscId} ارسال شد.`);
  return { ok: true, result };
}

async function getHoldingsForAutoTrade(env) {
  try {
    return await getHoldingsMap(env);
  } catch {
    return new Map();
  }
}
