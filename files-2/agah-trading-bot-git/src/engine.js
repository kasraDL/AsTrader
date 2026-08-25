import { smaCrossoverSignal } from "./signals.js";

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function analyzeInstrument(candles) {
  const smaResult = smaCrossoverSignal(candles);
  const closes = candles.map((c) => Number(c.last)).filter(Number.isFinite);
  const last = closes[closes.length - 1];
  const rsiNow = rsi(closes, 14);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, Math.min(50, closes.length));
  const trend = sma20 && last ? (last >= sma20 ? "up" : "down") : "flat";

  let signal = "hold";
  let reason = smaResult.reason;
  let score = 0;

  if (smaResult.signal === "buy" && (rsiNow == null || rsiNow < 70)) {
    signal = "buy";
    score = 70 + (rsiNow != null && rsiNow < 40 ? 15 : 0);
    reason = `${smaResult.reason} · RSI ${rsiNow != null ? rsiNow.toFixed(1) : "n/a"}`;
  } else if (smaResult.signal === "sell" && (rsiNow == null || rsiNow > 30)) {
    signal = "sell";
    score = 70 + (rsiNow != null && rsiNow > 60 ? 15 : 0);
    reason = `${smaResult.reason} · RSI ${rsiNow != null ? rsiNow.toFixed(1) : "n/a"}`;
  } else if (rsiNow != null && rsiNow < 28 && trend === "up") {
    signal = "buy";
    score = 55;
    reason = `RSI oversold (${rsiNow.toFixed(1)}) while price is above SMA20`;
  } else if (rsiNow != null && rsiNow > 75 && trend === "down") {
    signal = "sell";
    score = 55;
    reason = `RSI overbought (${rsiNow.toFixed(1)}) while price is below SMA20`;
  }

  return {
    signal,
    reason,
    score,
    last,
    rsi: rsiNow,
    sma20,
    sma50,
    trend,
  };
}

export function defaultSettings(env) {
  return {
    autoTrade: false,
    maxOrderValueRial: Number(env.MAX_ORDER_VALUE_RIAL || 50_000_000),
    maxDailyOrders: 8,
    riskPercent: 5,
    defaultQuantity: 0,
    sellOnlyHoldings: true,
    minScore: 55,
  };
}

export function tehranDateKey(now = Date.now()) {
  return new Date(now + 3.5 * 3600 * 1000).toISOString().slice(0, 10);
}

export function sizeQuantity({ price, buyingPower, settings, fallbackQuantity }) {
  const px = Number(price);
  if (!Number.isFinite(px) || px <= 0) return 0;
  const cap = Number(settings.maxOrderValueRial || 0);
  const risk = Math.max(1, Math.min(20, Number(settings.riskPercent || 5))) / 100;
  const budgetFromCash = Number(buyingPower) > 0 ? Number(buyingPower) * risk : 0;
  const positive = [cap, budgetFromCash].filter((n) => n > 0);
  const budget = positive.length ? Math.min(...positive) : 0;
  const byBudget = budget > 0 ? Math.floor(budget / px) : 0;
  const qty = byBudget || Number(fallbackQuantity) || Number(settings.defaultQuantity) || 0;
  if (cap && qty * px > cap) return Math.floor(cap / px);
  return Math.max(0, Math.floor(qty));
}

export function canAutoTrade(settings, daily) {
  if (!settings?.autoTrade) return { ok: false, reason: "اتوماسیون خاموش است" };
  if ((daily?.orders || 0) >= Number(settings.maxDailyOrders || 0)) {
    return { ok: false, reason: "سقف تعداد سفارش روزانه پر شده" };
  }
  return { ok: true };
}
