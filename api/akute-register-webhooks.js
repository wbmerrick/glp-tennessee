const { ensureTaskWebhooks } = require("../lib/akute-register-webhooks");

/**
 * One-shot / manual: ensure Akute Tasks create+update webhooks point at us.
 *
 * Auth: x-vercel-cron (same as sweep) or AKUTE_SWEEP_SECRET.
 * Env: AKUTE_API_KEY, AKUTE_WEBHOOK_SECRET
 */
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  if (!process.env.AKUTE_API_KEY || !process.env.AKUTE_WEBHOOK_SECRET) {
    res.status(503).json({ ok: false, error: "not_configured" });
    return;
  }

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
    // Default: retarget destination only (do not overwrite org-wide signing secret).
    // ?pushSecret=1 forces writing AKUTE_WEBHOOK_SECRET onto the Akute subscriptions.
    const pushSecret = Boolean(
      (req.query && (req.query.pushSecret === "1" || req.query.pushSecret === "true"))
    );
    const result = await ensureTaskWebhooks({ pushSecret: pushSecret });
    res.status(result.ok ? 200 : 207).json(result);
  } catch (error) {
    const status = error.code === "missing_env" ? 503 : 500;
    res.status(status).json({
      ok: false,
      error: error.code || "register_failed",
      env: error.env
    });
  }
};
