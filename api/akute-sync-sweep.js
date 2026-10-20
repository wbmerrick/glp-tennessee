const { runBackupSweep } = require("../lib/akute-chart-sync");

/**
 * Backup sweep for intake part 2 (address + preferred pharmacy → chart).
 * Runs on a Vercel cron and can be invoked manually with the shared secret.
 *
 * Env: AKUTE_API_KEY, AKUTE_USER_ID, AKUTE_SWEEP_SECRET (optional but recommended)
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
    const result = await runBackupSweep({ limit: 50 });
    res.status(result.ok ? 200 : 207).json(result);
  } catch (error) {
    const status = error.code === "missing_env" ? 503 : 500;
    res.status(status).json({
      ok: false,
      error: error.code || "sweep_failed",
      env: error.env
    });
  }
};
