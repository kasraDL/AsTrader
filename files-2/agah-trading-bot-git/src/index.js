import { getDailyCandles, getLiveSegmentation, placeOrder } from "./agah.js";
import { smaCrossoverSignal } from "./signals.js";
import { notify } from "./telegram.js";

const DAY = 86400;
const MAX_LOG = 50;
const TSETMC_SEARCH = "https://cdn.tsetmc.com/api/Instrument/GetInstrumentSearch/";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });

    if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);

    try {
      if (url.pathname === "/api/state" && request.method === "GET") {
        return json(await getState(env));
      }
      if (url.pathname === "/api/token" && request.method === "POST") {
        const { token, userIdentifier } = await request.json();
        if (!token) return json({ error: "token required" }, 400);
        await env.BOT_KV.put("agah:token", token);
        if (userIdentifier) await env.BOT_KV.put("agah:userIdentifier", userIdentifier);
        await log(env, "توکن جدید ذخیره شد.");
        return json({ ok: true });
      }
      if (url.pathname === "/api/symbols/search" && request.method === "GET") {
        return json(await searchSymbols(env, url.searchParams.get("q") || ""));
      }
      if (url.pathname === "/api/test/agah-category" && request.method === "GET") {
        const nscId = "IRO1IKCO0001";
        const segmentation = await getLiveSegmentation(env, nscId);
        return json({
          ok: true,
          nscId,
          categoryId: findCategoryId(segmentation),
        });
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

function checkAuth(request, env) {
  const key = request.headers.get("X-Dashboard-Key");
  return !!env.DASHBOARD_PASSWORD && key === env.DASHBOARD_PASSWORD;
}

async function log(env, text) {
  const list = JSON.parse((await env.BOT_KV.get("log")) || "[]");
  list.push({ ts: Date.now(), text });
  while (list.length > MAX_LOG) list.shift();
  await env.BOT_KV.put("log", JSON.stringify(list));
}

async function getState(env) {
  const [token, watchlistRaw, logRaw] = await Promise.all([
    env.BOT_KV.get("agah:token"),
    env.BOT_KV.get("watchlist"),
    env.BOT_KV.get("log"),
  ]);
  const watchlist = JSON.parse(watchlistRaw || "[]");
  const list = await env.BOT_KV.list({ prefix: "pending:" });
  const pending = [];
  for (const k of list.keys) {
    const raw = await env.BOT_KV.get(k.name);
    if (raw) pending.push({ id: k.name.replace("pending:", ""), ...JSON.parse(raw) });
  }
  return { hasToken: !!token, watchlist, pending, log: JSON.parse(logRaw || "[]") };
}

async function searchSymbols(env, query) {
  const q = query.trim();
  if (q.length < 2) return { results: [] };

  const res = await fetch(`${TSETMC_SEARCH}${encodeURIComponent(q)}`, {
    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 AsTrader/1.0" },
  });
  if (!res.ok) throw new Error(`symbol search failed: ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data?.instrumentSearch) ? data.instrumentSearch : [];

  // Resolve Agah's categoryId server-side. The dashboard never receives the Agah token.
  const results = [];
  for (const item of raw.slice(0, 8)) {
    const nscId = item.cIsin || item.isin || item.nscId || "";
    let categoryId = null;
    if (nscId) {
      try {
        const segmentation = await getLiveSegmentation(env, nscId);
        categoryId = findCategoryId(segmentation);
      } catch (_) {
        // Search remains usable even if Agah's segmentation endpoint temporarily fails.
      }
    }
    results.push({
      symbol: item.lVal18AFC || "",
      name: item.lVal30 || "",
      nscId,
      categoryId,
      flow: item.flow ?? null,
      flowTitle: item.flowTitle || "",
      insCode: item.insCode || "",
    });
  }
  return { results };
}

function findCategoryId(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCategoryId(item);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, val] of Object.entries(value)) {
    if (/^categoryid$/i.test(key) && (typeof val === "string" || typeof val === "number")) return String(val);
  }
  for (const val of Object.values(value)) {
    const found = findCategoryId(val);
    if (found !== null) return found;
  }
  return null;
}

async function handleWatchlist(env, body) {
  const list = JSON.parse((await env.BOT_KV.get("watchlist")) || "[]");
  if (body.action === "add") {
    if (!body.nscId || !body.categoryId || !body.quantity) throw new Error("nscId, categoryId, quantity required");
    const filtered = list.filter((w) => w.nscId !== body.nscId);
    filtered.push({
      nscId: body.nscId,
      categoryId: body.categoryId,
      quantity: Number(body.quantity),
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

async function handleSignalAction(env, id, action) {
  const raw = await env.BOT_KV.get(`pending:${id}`);
  if (!raw) return { error: "signal not found or expired" };
  const pending = JSON.parse(raw);
  await env.BOT_KV.delete(`pending:${id}`);

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
    const result = await placeOrder(env, {
      categoryId: pending.categoryId,
      nscId: pending.nscId,
      orderSide: pending.side === "buy" ? 1 : 2,
      price: pending.price,
      quantity: pending.quantity,
    });
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
      const pending = {
        nscId: item.nscId,
        categoryId: item.categoryId,
        quantity: item.quantity,
        price: lastClose,
        side: result.signal,
        reason: result.reason,
      };
      await env.BOT_KV.put(`pending:${signalId}`, JSON.stringify(pending), { expirationTtl: 3600 });
      await log(env, `📊 سیگنال ${result.signal === "buy" ? "خرید" : "فروش"} برای ${item.nscId} ثبت شد.`);
      await notify(env, `سیگنال جدید: ${item.nscId} (${result.signal}) - داشبورد رو چک کن.`);
    } catch (err) {
      if (err.message === "TOKEN_EXPIRED" || err.message === "NO_TOKEN") {
        await log(env, "⚠️ توکن نامعتبر یا منقضی - از داشبورد توکن تازه ثبت کن.");
        return;
      }
      await log(env, `⚠️ خطا در بررسی ${item.nscId}: ${err.message}`);
    }
  }
}
