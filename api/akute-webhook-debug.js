
const { akuteRequest, requireEnv } = require("../lib/akute-client");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  if (!process.env.AKUTE_API_KEY) {
    res.status(503).json({ ok: false, error: "not_configured" });
    return;
  }
  const isCron = Boolean(req.headers["x-vercel-cron"]);
  const expected = process.env.AKUTE_SWEEP_SECRET;
  const provided = (req.query && req.query.secret) || req.headers["x-sweep-secret"] || "";
  if (!isCron && (!expected || provided !== expected)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const id = (req.query && req.query.id) || "evt-23b1c3ce643f4dd3854f967cfe2293c5";
  const probes = [];

  async function probe(label, method, path) {
    const result = await akuteRequest(method, path);
    probes.push({ label, method, path, status: result.status, ok: result.ok, data: result.data });
  }

  await probe("get_webhook_id", "GET", "/v1/webhooks/" + encodeURIComponent(id));
  await probe("list_no_query", "GET", "/v1/webhooks");
  await probe("notifications_all", "GET", "/notifications");
  await probe("notifications_secret", "GET", "/notifications/" + encodeURIComponent(id) + "/secret");
  await probe("notif_task", "GET", "/notifications?resource=Task");
  await probe("notif_type_webhook", "GET", "/notifications?type=webhook");

  // Never echo AKUTE_WEBHOOK_SECRET; only whether set + length
  const secret = process.env.AKUTE_WEBHOOK_SECRET || "";
  res.status(200).json({
    ok: true,
    localSecretConfigured: Boolean(secret),
    localSecretLength: secret.length,
    probes
  });
};
