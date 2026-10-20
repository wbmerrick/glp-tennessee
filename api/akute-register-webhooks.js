/**
 * Webhook registration — retired on this project.
 *
 * Do not point Akute Task create/update subscriptions here for chart sync.
 * Use sprymd: https://www.sprymd.ai/api/webhooks/akute
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
    owner: "https://www.sprymd.ai/api/webhooks/akute",
    hint: "Remove any Akute Developer → Notifications entries that still target glp-tennessee.vercel.app/api/akute-webhook for Tasks."
  });
};
