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
  await env.BOT_KV.put("agah:token", token);
  if (userIdentifier) await env.BOT_KV.put("agah:userIdentifier", userIdentifier);
  const validation = await validateAgahAuth(env);
  const session = `sess_${crypto.randomUUID()}`;
  await env.BOT_KV.put(SESSION_PREFIX + session, JSON.stringify({ ts: Date.now() }), { expirationTtl: 12 * 3600 });
  await log(env, "ورود با توکن آگاه موفق بود.");
  return { ok: true, session, ...validation };
}

async function saveToken(env, body) {
  const token = normalizeToken(body?.token);
  const userIdentifier = normalizeUserIdentifier(body?.userIdentifier);
  if (!token) return { error: "token required" };
  await env.BOT_KV.put("agah:token", token);
  if (userIdentifier) await env.BOT_KV.put("agah:userIdentifier", userIdentifier);
  else await env.BOT_KV.delete("agah:userIdentifier");
  try {
    const validation = await validateAgahAuth(env);
    await log(env, "توکن جدید ذخیره و اعتبارسنجی شد.");
    return { ok: true, validated: true, ...validation };
  } catch (err) {
    await log(env, `⚠️ توکن ذخیره شد ولی اعتبارسنجی آگاه ناموفق بود: ${err.message}`);
    return { ok: false, stored: true, validated: false, error: err.message };
  }
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
  await env.BOT_KV.put(PENDING_INDEX_KEY, JSON.stringify(ids.slice(-100)));
}

async function removePendingId(env, id) {
  const ids = JSON.parse((await env.BOT_KV.get(PENDING_INDEX_KEY)) || "[]");
  await env.BOT_KV.put(PENDING_INDEX_KEY, JSON.stringify(ids.filter((item) => item !== id)));
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
    results.push({ ...item, categoryId, categoryError });
  }
  return { results };
}

async function handleWatchlist(env, body) {
  const list = JSON.parse((await env.BOT_KV.get("watchlist")) || "[]");
  if (body.action === "add") {
    if (!body.nscId) throw new Error("nscId required");
    let categoryId = body.categoryId;
    if (!categoryId) {
      const segmentation = await getLiveSegmentation(env, body.nscId);
      categoryId = segmentation.categoryId;
    }
    const filtered = list.filter((w) => w.nscId !== body.nscId);
    filtered.push({
      nscId: body.nscId,
      categoryId,
      quantity: Number(body.quantity || 0),
      symbol: body.symbol || body.nscId,
      name: body.name || "",
    });
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

async function placePendingOrder(env, pending) {
  const settings = await getSettings(env);
  const cap = Number(settings.maxOrderValueRial || env.MAX_ORDER_VALUE_RIAL || 0);
  const orderValue = pending.price * pending.quantity;
  if (cap && orderValue > cap) {
    await log(env, `⛔️ سفارش ${pending.symbol || pending.nscId} به‌خاطر سقف ارزش لغو شد.`);
    return { error: "exceeds MAX_ORDER_VALUE_RIAL" };
  }
  if (!pending.quantity) {
    await log(env, `⛔️ سفارش ${pending.symbol || pending.nscId} تعداد نامعتبر دارد.`);
    return { error: "invalid quantity" };
  }
  const result = await placeOrder(env, {
    categoryId: pending.categoryId,
    nscId: pending.nscId,
    orderSide: pending.side === "buy" ? 1 : 2,
    price: pending.price,
    quantity: pending.quantity,
  });
  await bumpDailyOrders(env);
  await log(env, `✅ سفارش ${pending.symbol || pending.nscId} (${pending.side}) ثبت شد (decisionId: ${result?.data?.decisionId ?? "?"}).`);
  return { ok: true, result };
}

async function handleSignalAction(env, id, action) {
  const raw = await env.BOT_KV.get(`pending:${id}`);
  if (!raw) return { error: "signal not found or expired" };
  const pending = JSON.parse(raw);
  await env.BOT_KV.delete(`pending:${id}`);
  await removePendingId(env, id);
  if (action === "reject") {
    await log(env, `❌ سیگنال ${pending.symbol || pending.nscId} (${pending.side}) رد شد.`);
    return { ok: true };
  }
  try {
    return await placePendingOrder(env, pending);
  } catch (err) {
    await log(env, `⚠️ خطا در ارسال سفارش ${pending.nscId}: ${err.message}`);
    return { error: err.message };
  }
}

async function alreadyPending(env, nscId, side) {
  const ids = JSON.parse((await env.BOT_KV.get(PENDING_INDEX_KEY)) || "[]");
  for (const id of ids) {
    const raw = await env.BOT_KV.get(`pending:${id}`);
    if (!raw) continue;
    const item = JSON.parse(raw);
    if (item.nscId === nscId && item.side === side) return true;
  }
  return false;
}

async function runSignalCheck(env) {
  const list = JSON.parse((await env.BOT_KV.get("watchlist")) || "[]");
  if (!list.length) {
    await log(env, "واچ‌لیست خالی است؛ ابتدا نمادهایی برای رصد انتخاب کنید.");
    return;
  }

  const settings = await getSettings(env);
  const daily = await getDaily(env);
  const toUnix = Math.floor(Date.now() / 1000);
  const fromUnix = toUnix - 220 * DAY;
  let holdings = [];
  let buyingPower = 0;
  try {
    const held = await getHoldingsMap(env);
    holdings = held.holdings || [];
    const cash = held.snapshot?.remaining;
    buyingPower = Number(cash?.buyingPower ?? cash?.remain ?? cash?.remaining ?? cash?.power ?? 0) || 0;
  } catch (err) {
    if (err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN") {
      await log(env, "⚠️ توکن نامعتبر یا منقضی است. دوباره وارد شوید.");
      return;
    }
  }

  for (const item of list) {
    try {
      const candles = await getDailyCandles(env, item.nscId, { fromUnix, toUnix });
      if (!candles.length) continue;
      const analysis = analyzeInstrument(candles);
      if (analysis.signal === "hold" || (analysis.score || 0) < settings.minScore) continue;

      const lastSignalKey = `lastSignal:${item.nscId}`;
      const last = JSON.parse((await env.BOT_KV.get(lastSignalKey)) || "{}");
      const today = tehranDateKey();
      if (last.date === today && last.side === analysis.signal) continue;
      if (await alreadyPending(env, item.nscId, analysis.signal)) continue;

      if (analysis.signal === "sell" && settings.sellOnlyHoldings) {
        const heldQty = holdings.find((h) => h.nscId === item.nscId)?.quantity || 0;
        if (heldQty <= 0) continue;
      }

      const qty = analysis.signal === "sell"
        ? Math.max(1, Math.floor(holdings.find((h) => h.nscId === item.nscId)?.quantity || item.quantity || 0))
        : sizeQuantity({
            price: analysis.last,
            buyingPower,
            settings,
            fallbackQuantity: item.quantity,
          });
      if (!qty) continue;

      const pending = {
        nscId: item.nscId,
        categoryId: item.categoryId,
        quantity: qty,
        price: analysis.last,
        side: analysis.signal,
        reason: analysis.reason,
        score: analysis.score,
        symbol: item.symbol || item.nscId,
        name: item.name || "",
      };

      const gate = canAutoTrade(settings, daily);
      if (gate.ok) {
        try {
          await placePendingOrder(env, pending);
          daily.orders = (daily.orders || 0) + 1;
          await env.BOT_KV.put(lastSignalKey, JSON.stringify({ date: today, side: analysis.signal }));
          await notify(env, `سفارش خودکار ${pending.symbol}: ${pending.side} ${pending.quantity} @ ${pending.price}`);
          continue;
        } catch (err) {
          await log(env, `⚠️ ارسال خودکار ${pending.symbol} ناموفق بود؛ سیگنال برای تایید دستی ثبت شد. ${err.message}`);
        }
      }

      const signalId = crypto.randomUUID();
      await env.BOT_KV.put(`pending:${signalId}`, JSON.stringify(pending), { expirationTtl: 3600 });
      await addPendingId(env, signalId);
      await env.BOT_KV.put(lastSignalKey, JSON.stringify({ date: today, side: analysis.signal }));
      await log(env, `📊 سیگنال ${analysis.signal === "buy" ? "خرید" : "فروش"} برای ${pending.symbol} ثبت شد.`);
      await notify(env, `سیگنال جدید: ${pending.symbol} (${analysis.signal})`);
    } catch (err) {
      if (err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN") {
        await log(env, "⚠️ توکن نامعتبر یا منقضی است. دوباره وارد شوید.");
        return;
      }
      await log(env, `⚠️ خطا در بررسی ${item.symbol || item.nscId}: ${err.message}`);
    }
  }
}
