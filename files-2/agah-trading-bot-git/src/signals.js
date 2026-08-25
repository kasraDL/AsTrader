// Minimal, transparent rule-based signal engine. Deliberately simple to start
// with (SMA crossover) so behavior is easy to audit before trusting it with
// real money. Swap or extend this with a proper indicator library or an LLM
// call once you trust the plumbing around it (auth, confirmation, order
// placement) end-to-end.

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// candles: array from getDailyCandles, oldest first
export function smaCrossoverSignal(candles, { fast = 5, slow = 20 } = {}) {
  if (candles.length < slow + 1) return { signal: "hold", reason: "not enough data" };

  const closes = candles.map((c) => c.last);
  const fastNow = sma(closes, fast);
  const slowNow = sma(closes, slow);
  const fastPrev = sma(closes.slice(0, -1), fast);
  const slowPrev = sma(closes.slice(0, -1), slow);

  if (fastPrev <= slowPrev && fastNow > slowNow) {
    return { signal: "buy", reason: `SMA${fast} crossed above SMA${slow}`, fastNow, slowNow };
  }
  if (fastPrev >= slowPrev && fastNow < slowNow) {
    return { signal: "sell", reason: `SMA${fast} crossed below SMA${slow}`, fastNow, slowNow };
  }
  return { signal: "hold", reason: "no crossover", fastNow, slowNow };
}
