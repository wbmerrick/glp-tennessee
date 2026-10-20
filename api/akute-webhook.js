const { verifyAkuteSignature, readRawBody, parseWebhookPayload } = require("../lib/akute-webhook");

/**
 * Akute → GLP Tennessee webhook (retired chart writer).
 *
 * Address/pharmacy chart sync + pharmacy-pick tasks are owned by sprymd
 * (www.sprymd.ai/api/webhooks/akute). This handler only verifies the
 * signature and acknowledges so leftover Akute subscriptions here do not
 * retry or double-write the patient chart.
 *
 * Env: AKUTE_WEBHOOK_SECRET (signature only)
 */
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  const secret = process.env.AKUTE_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ ok: false, error: "not_configured" });
    return;
  }

  const signature = req.headers["x-akute-signature"] || req.headers["X-Akute-Signature"];
  const raw = readRawBody(req);
  if (!verifyAkuteSignature(raw, signature, secret)) {
    res.status(401).json({ ok: false, error: "invalid_signature" });
    return;
  }

  try {
    parseWebhookPayload(req);
  } catch (e) {
    res.status(400).json({ ok: false, error: "invalid_json" });
    return;
  }

  res.status(200).json({
    ok: true,
    ignored: true,
    reason: "chart_sync_retired",
    owner: "https://www.sprymd.ai/api/webhooks/akute"
  });
};
