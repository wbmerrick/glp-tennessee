const { akuteRequest, requireEnv, API_BASE } = require("./akute-client");

const DEFAULT_DESTINATION = "https://glp-tennessee.vercel.app/api/akute-webhook";

/** Try X-API-Key and Bearer (some Akute write routes want an access token). */
async function akuteWrite(method, path, body) {
  const key = requireEnv("AKUTE_API_KEY");
  const attempts = [
    { "Content-Type": "application/json", Accept: "application/json", "X-API-Key": key },
    { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + key },
    { "Content-Type": "application/json", Accept: "application/json", "X-API-Key": key, Authorization: "Bearer " + key }
  ];
  let last = null;
  for (const headers of attempts) {
    const response = await fetch(API_BASE + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch (e) { data = { raw: text }; }
    }
    last = { status: response.status, ok: response.ok, data: data, auth: Object.keys(headers).filter(function (k) { return k !== "Content-Type" && k !== "Accept"; }).join("+") };
    if (response.ok) return last;
    // Keep trying other auth styles on 401 only.
    if (response.status !== 401) return last;
  }
  return last;
}

/** Portal Developer → Notifications shape (Task + POST/PUT). */
const WANTED_NOTIFICATIONS = [
  { resourceType: "Task", httpTriggerMethod: "POST", event: "create" },
  { resourceType: "Task", httpTriggerMethod: "PUT", event: "update" }
];

/** Public Customer API Webhook schema (tasks + create/update). */
const WANTED_WEBHOOKS = [
  { resource: "tasks", event: "create" },
  { resource: "tasks", event: "update" }
];

function normalizeList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.webhooks)) return data.webhooks;
  if (Array.isArray(data.notifications)) return data.notifications;
  if (Array.isArray(data.data)) return data.data;
  return [];
}

function notificationMatches(item, wanted) {
  const resource = String(
    (item.resourceType && item.resourceType.value) || item.resourceType || item.resource || ""
  );
  const method = String(
    (item.httpTriggerMethod && item.httpTriggerMethod.value) || item.httpTriggerMethod || item.event || ""
  ).toUpperCase();
  return resource === wanted.resourceType && method === wanted.httpTriggerMethod;
}

async function listNotifications() {
  // Portal list lives at /notifications (not /v1/webhooks).
  return akuteRequest("GET", "/notifications?resource=Task&type=webhook&notificationType=webhook");
}

async function createOrUpdateNotifications(notificationsArray) {
  return akuteWrite("POST", "/notifications", { notificationsArray: notificationsArray });
}

async function listWebhooksV1(query) {
  const qs = new URLSearchParams(query || {}).toString();
  return akuteRequest("GET", "/v1/webhooks" + (qs ? "?" + qs : ""));
}

async function updateWebhookV1(id, body) {
  return akuteWrite("POST", "/v1/webhooks/" + encodeURIComponent(id), body);
}

async function createWebhookV1(body) {
  return akuteWrite("POST", "/v1/webhooks", body);
}

/**
 * Prefer the same /notifications API the Akute Developer UI uses.
 * Fall back to /v1/webhooks create/update if notifications is unavailable.
 */
async function ensureTaskWebhooks(options) {
  const destination = (options && options.destination) || DEFAULT_DESTINATION;
  const secret = requireEnv("AKUTE_WEBHOOK_SECRET");
  const probes = [];

  // --- Path A: /notifications (UI-compatible) ---
  const listed = await listNotifications();
  probes.push({ path: "GET /notifications", status: listed.status, ok: listed.ok });

  if (listed.ok) {
    const existing = normalizeList(listed.data);
    const payload = [];
    const results = [];

    for (const wanted of WANTED_NOTIFICATIONS) {
      const found = existing.find(function (item) {
        return notificationMatches(item, wanted);
      });
      const entry = {
        type: "webhook",
        resourceType: wanted.resourceType,
        httpTriggerMethod: wanted.httpTriggerMethod,
        endpoint: destination,
        secret: secret
      };
      if (found && (found._id || found.id)) {
        entry._id = found._id || found.id;
      }
      payload.push(entry);
      results.push({
        resource: wanted.resourceType,
        event: wanted.event,
        action: found ? "update" : "create",
        previousEndpoint: found && found.endpoint ? found.endpoint : null
      });
    }

    const saved = await createOrUpdateNotifications(payload);
    probes.push({ path: "POST /notifications", status: saved.status, ok: saved.ok });
    return {
      ok: saved.ok,
      via: "notifications",
      destination: destination,
      existingCount: existing.length,
      results: results,
      probes: probes,
      data: saved.ok ? undefined : saved.data,
      needUi: !saved.ok
    };
  }

  // --- Path B: Customer API /v1/webhooks ---
  const start = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const end = new Date().toISOString();
  const listedV1 = await listWebhooksV1({ start_time: start, end_time: end });
  probes.push({ path: "GET /v1/webhooks", status: listedV1.status, ok: listedV1.ok, data: listedV1.ok ? undefined : listedV1.data });

  const results = [];
  if (listedV1.ok) {
    const existing = normalizeList(listedV1.data);
    for (const wanted of WANTED_WEBHOOKS) {
      const found = existing.filter(function (hook) {
        return String(hook.resource || "").toLowerCase() === wanted.resource
          && String(hook.event || "").toLowerCase() === wanted.event;
      });
      if (!found.length) {
        const created = await createWebhookV1({
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
          data: created.ok ? undefined : created.data
        });
      } else {
        for (const hook of found) {
          const id = hook.id || hook.webhook_id;
          const updated = await updateWebhookV1(id, {
            resource: wanted.resource,
            event: wanted.event,
            destination: destination,
            secret: secret
          });
          results.push({
            resource: wanted.resource,
            event: wanted.event,
            action: "update",
            ok: updated.ok,
            status: updated.status,
            id: id,
            data: updated.ok ? undefined : updated.data
          });
        }
      }
    }
    const ok = results.every(function (r) { return r.ok; });
    return {
      ok: ok,
      via: "v1/webhooks",
      destination: destination,
      results: results,
      probes: probes,
      needUi: !ok
    };
  }

  // --- Path C: try create on both without a prior list ---
  for (const wanted of WANTED_NOTIFICATIONS) {
    const created = await createOrUpdateNotifications([{
      type: "webhook",
      resourceType: wanted.resourceType,
      httpTriggerMethod: wanted.httpTriggerMethod,
      endpoint: destination,
      secret: secret
    }]);
    results.push({
      resource: wanted.resourceType,
      event: wanted.event,
      action: "create_notifications",
      ok: created.ok,
      status: created.status,
      data: created.ok ? undefined : created.data
    });
    probes.push({ path: "POST /notifications (create)", status: created.status, ok: created.ok });
  }

  for (const wanted of WANTED_WEBHOOKS) {
    const idGuess = wanted.resource + "-" + wanted.event;
    const updated = await updateWebhookV1(idGuess, {
      resource: wanted.resource,
      event: wanted.event,
      destination: destination,
      secret: secret
    });
    results.push({
      resource: wanted.resource,
      event: wanted.event,
      action: "upsert_v1_" + idGuess,
      ok: updated.ok,
      status: updated.status,
      data: updated.ok ? undefined : updated.data
    });
    probes.push({ path: "POST /v1/webhooks/" + idGuess, status: updated.status, ok: updated.ok });

    const created = await createWebhookV1({
      resource: wanted.resource,
      event: wanted.event,
      destination: destination,
      secret: secret
    });
    results.push({
      resource: wanted.resource,
      event: wanted.event,
      action: "create_v1",
      ok: created.ok,
      status: created.status,
      data: created.ok ? undefined : created.data
    });
    probes.push({ path: "POST /v1/webhooks", status: created.status, ok: created.ok });
  }

  const ok = results.some(function (r) { return r.ok; });
  return {
    ok: ok,
    via: "probe",
    destination: destination,
    results: results,
    probes: probes,
    needUi: !ok,
    uiHint: ok ? undefined : "Create Tasks create/update webhooks in Akute → Settings → Developer → Notifications pointing at " + destination
  };
}

module.exports = {
  DEFAULT_DESTINATION,
  WANTED_NOTIFICATIONS,
  WANTED_WEBHOOKS,
  ensureTaskWebhooks,
  normalizeList,
  notificationMatches
};
