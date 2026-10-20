
const { akuteRequest } = require("../lib/akute-client");

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

  const start = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const end = new Date().toISOString();
  const listed = await akuteRequest("GET", "/v1/webhooks?start_time=" + encodeURIComponent(start) + "&end_time=" + encodeURIComponent(end));
  const items = Array.isArray(listed.data) ? listed.data : [];

  // Fetch details for recent task events (cap) to find recipients + response codes
  const taskIds = items.filter(function (i) {
    return String(i.resource || i.resource_type || "").toLowerCase().indexOf("task") >= 0;
  }).slice(0, 25).map(function (i) { return i.id; });

  const details = [];
  for (const id of taskIds) {
    const got = await akuteRequest("GET", "/v1/webhooks/" + encodeURIComponent(id));
    if (!got.ok) continue;
    const d = got.data || {};
    details.push({
      id: d.id,
      timestamp: d.timestamp,
      resource_type: d.resource_type,
      recipient: d.recipient,
      status: d.status,
      response_code: d.response_code,
      event_type: d.payload && d.payload.event_type
    });
  }

  const byRecipient = {};
  details.forEach(function (d) {
    const key = d.recipient || "(none)";
    byRecipient[key] = byRecipient[key] || { count: 0, codes: {} };
    byRecipient[key].count += 1;
    const code = String(d.response_code);
    byRecipient[key].codes[code] = (byRecipient[key].codes[code] || 0) + 1;
  });

  const secret = process.env.AKUTE_WEBHOOK_SECRET || "";
  res.status(200).json({
    ok: true,
    localSecretConfigured: Boolean(secret),
    localSecretLength: secret.length,
    listCount: items.length,
    sampledTaskDeliveries: details.length,
    byRecipient: byRecipient,
    recentGlp: details.filter(function (d) {
      return String(d.recipient || "").indexOf("glp-tennessee") >= 0;
    }),
    recentSample: details.slice(0, 8)
  });
};
