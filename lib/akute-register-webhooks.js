const { akuteRequest, requireEnv } = require("./akute-client");

const DEFAULT_DESTINATION = "https://glp-tennessee.vercel.app/api/akute-webhook";
const WANTED = [
  { resource: "tasks", event: "create" },
  { resource: "tasks", event: "update" }
];

function listWebhooks() {
  return akuteRequest("GET", "/v1/webhooks");
}

function updateWebhook(id, body) {
  return akuteRequest("POST", "/v1/webhooks/" + encodeURIComponent(id), body);
}

function createWebhook(body) {
  // Undocumented on some OpenAPI snapshots; Akute UI create may map here.
  return akuteRequest("POST", "/v1/webhooks", body);
}

function normalizeList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.webhooks)) return data.webhooks;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function matchWanted(hook, wanted) {
  const resource = String(hook.resource || hook.resource_type || "").toLowerCase();
  const event = String(hook.event || hook.event_type || "").toLowerCase();
  return resource === wanted.resource && event === wanted.event;
}

/**
 * Ensure Tasks create + update webhooks point at our handler with the
 * shared AKUTE_WEBHOOK_SECRET. Safe to run from cron; idempotent.
 */
async function ensureTaskWebhooks(options) {
  const destination = (options && options.destination) || DEFAULT_DESTINATION;
  const secret = requireEnv("AKUTE_WEBHOOK_SECRET");

  const listed = await listWebhooks();
  if (!listed.ok) {
    return {
      ok: false,
      error: "list_failed",
      status: listed.status,
      data: listed.data
    };
  }

  const existing = normalizeList(listed.data);
  const results = [];

  for (const wanted of WANTED) {
    const found = existing.filter(function (hook) {
      return matchWanted(hook, wanted);
    });

    if (found.length === 0) {
      const created = await createWebhook({
        resource: wanted.resource,
        event: wanted.event,
        destination: destination,
        secret: secret
      });
      results.push({
        resource: wanted.resource,
        event: wanted.event,
        action: "create",
        ok: created.ok,
        status: created.status,
        id: created.data && (created.data.id || created.data.webhook_id),
        needUi: !created.ok,
        data: created.ok ? undefined : created.data
      });
      continue;
    }

    for (const hook of found) {
      const id = hook.id || hook.webhook_id;
      const sameDest = String(hook.destination || "") === destination;
      // Secret is never returned; always re-apply so HMAC matches our env.
      const updated = await updateWebhook(id, {
        resource: wanted.resource,
        event: wanted.event,
        destination: destination,
        secret: secret
      });
      results.push({
        resource: wanted.resource,
        event: wanted.event,
        action: sameDest ? "refresh_secret" : "update_destination",
        ok: updated.ok,
        status: updated.status,
        id: id,
        previousDestination: hook.destination || null,
        data: updated.ok ? undefined : updated.data
      });
    }
  }

  const ok = results.every(function (r) { return r.ok; });
  const needUi = results.some(function (r) { return r.needUi; });
  return {
    ok: ok,
    destination: destination,
    existingCount: existing.length,
    results: results,
    needUi: needUi,
    uiHint: needUi
      ? "Create Tasks create/update webhooks in Akute → Settings → Developer → Notifications, then re-run."
      : undefined
  };
}

module.exports = {
  DEFAULT_DESTINATION,
  WANTED,
  listWebhooks,
  ensureTaskWebhooks,
  normalizeList,
  matchWanted
};
