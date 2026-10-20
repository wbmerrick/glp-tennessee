const { verifyAkuteSignature, readRawBody, parseWebhookPayload } = require("../lib/akute-webhook");
const { syncFromTaskWebhook } = require("../lib/akute-chart-sync");

/**
 * Akute → GLP Tennessee webhook.
 * Subscribe to Tasks create (and update) in Akute Developer → Notifications.
 * Form submissions create a task tagged "form submission" with a
 * QuestionnaireResponse attachment; we then push address + pharmacy onto the chart.
 *
 * Env: AKUTE_API_KEY, AKUTE_USER_ID, AKUTE_WEBHOOK_SECRET
 */
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.status(405).json({ ok: false });
    return;
  }

  const secret = process.env.AKUTE_WEBHOOK_SECRET;
  if (!secret || !process.env.AKUTE_API_KEY || !process.env.AKUTE_USER_ID) {
    res.status(503).json({ ok: false, error: "not_configured" });
    return;
  }

  const signature = req.headers["x-akute-signature"] || req.headers["X-Akute-Signature"];
  const raw = readRawBody(req);
  if (!verifyAkuteSignature(raw, signature, secret)) {
    res.status(401).json({ ok: false, error: "invalid_signature" });
    return;
  }

  let payload;
  try {
    payload = parseWebhookPayload(req);
  } catch (e) {
    res.status(400).json({ ok: false, error: "invalid_json" });
    return;
  }

  const resource = String(payload.resource_type || payload.resourceType || "").toLowerCase();
  const event = String(payload.event_type || payload.eventType || "").toLowerCase();
  if (resource && resource !== "tasks" && resource !== "task") {
    res.status(200).json({ ok: true, ignored: true, reason: "unhandled_resource" });
    return;
  }
  if (event && event !== "create" && event !== "update") {
    res.status(200).json({ ok: true, ignored: true, reason: "unhandled_event" });
    return;
  }

  try {
    const result = await syncFromTaskWebhook(payload);
    res.status(200).json(result);
  } catch (error) {
    const status = error.code === "missing_env" ? 503 : 500;
    res.status(status).json({
      ok: false,
      error: error.code || "sync_failed",
      env: error.env
    });
  }
};
