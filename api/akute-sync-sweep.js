/**
 * Backup sweep — retired.
 *
 * Chart sync lives on sprymd only. Kept as a stub so old cron/manual
 * callers get a clear response instead of writing the chart again.
 */
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  res.status(200).json({
    ok: true,
    retired: true,
    reason: "chart_sync_retired",
    owner: "https://www.sprymd.ai/api/webhooks/akute"
  });
};
