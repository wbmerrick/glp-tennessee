const { runBackupSweep } = require("../lib/akute-chart-sync");
const { ensureTaskWebhooks } = require("../lib/akute-register-webhooks");

/**
 * Backup sweep for intake part 2 (address + preferred pharmacy → chart).
 * Also keeps Tasks create/update webhooks pointed at our handler.
 *
 * Env: AKUTE_API_KEY, AKUTE_USER_ID, AKUTE_WEBHOOK_SECRET, AKUTE_SWEEP_SECRET
 * Cron: see vercel.json
 */
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  if (!process.env.AKUTE_API_KEY || !process.env.AKUTE_USER_ID) {
    res.status(503).json({ ok: false, error: "not_configured" });
    return;
  }

  // Vercel Cron sends x-vercel-cron. Manual runs need AKUTE_SWEEP_SECRET.
  const isCron = Boolean(req.headers["x-vercel-cron"]);
  const expected = process.env.AKUTE_SWEEP_SECRET;
  const provided = (req.query && req.query.secret)
    || req.headers["x-sweep-secret"]
    || "";
  if (!isCron) {
    if (!expected || provided !== expected) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
  }

  try {
    let webhooks = null;
    if (process.env.AKUTE_WEBHOOK_SECRET) {
      try {
        webhooks = await ensureTaskWebhooks({});
      } catch (error) {
        webhooks = {
          ok: false,
          error: error.code || "register_failed",
          env: error.env
        };
      }
    }

    const result = await runBackupSweep({ limit: 50 });
    res.status(result.ok ? 200 : 207).json(Object.assign({}, result, { webhooks: webhooks }));
  } catch (error) {
    const status = error.code === "missing_env" ? 503 : 500;
    res.status(status).json({
      ok: false,
      error: error.code || "sweep_failed",
      env: error.env
    });
  }
};
