// Optional: if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID secrets are set, ping the
// user when a new signal appears so they don't have to keep the dashboard tab
// open. The dashboard remains the only place actions actually happen - this
// is a notify-only, best-effort side channel.
export async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
  } catch {
    // best-effort - never let a notification failure break the signal check
  }
}
