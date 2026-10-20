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
    last = {
      status: response.status,
      ok: response.ok,
      data: data,
      auth: Object.keys(headers).filter(function (k) {
        return k !== "Content-Type" && k !== "Accept";
      }).join("+")
    };
    if (response.ok) return last;
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

function hookResource(hook) {
  return String(
    (hook.resourceType && hook.resourceType.value) ||
    hook.resourceType ||
    hook.resource ||
    hook.resource_type ||
    ""
  ).toLowerCase();
}

function hookEvent(hook) {
  const raw = String(
    (hook.httpTriggerMethod && hook.httpTriggerMethod.value) ||
    hook.httpTriggerMethod ||
    hook.event ||
    hook.event_type ||
    ""
  ).toLowerCase();
  if (raw === "post") return "create";
  if (raw === "put") return "update";
  if (raw === "get") return "request";
  return raw;
}

function hookDestination(hook) {
  return String(hook.destination || hook.endpoint || hook.url || "");
}

function hookId(hook) {
  return hook.id || hook.webhook_id || hook._id || null;
}

function isTaskHook(hook) {
  const resource = hookResource(hook);
  return resource === "tasks" || resource === "task";
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

function summarizeHooks(hooks) {
  return (hooks || []).map(function (hook) {
    return {
      id: hookId(hook),
      resource: hookResource(hook) || null,
      event: hookEvent(hook) || null,
      destination: hookDestination(hook) || null
    };
  });
}

async function listNotifications() {
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

async function fetchNotificationSecret(id) {
  return akuteWrite("GET", "/notifications/" + encodeURIComponent(id) + "/secret");
}

/**
 * Prefer the same /notifications API the Akute Developer UI uses.
 * Fall back to /v1/webhooks create/update if notifications is unavailable.
 *
 * When Task webhooks already exist (pointed at us with the org secret),
 * updating their secret from our env would *break* org-wide signing.
 * Instead we report listed hooks + try to reveal secrets for the operator
 * to copy into Vercel AKUTE_WEBHOOK_SECRET.
 */
async function ensureTaskWebhooks(options) {
  const destination = (options && options.destination) || DEFAULT_DESTINATION;
  const secret = requireEnv("AKUTE_WEBHOOK_SECRET");
  const pushSecret = Boolean(options && options.pushSecret);
  const probes = [];

  // --- Path A: /notifications (UI-compatible) ---
  const listed = await listNotifications();
  probes.push({ path: "GET /notifications", status: listed.status, ok: listed.ok });

  if (listed.ok) {
    const existing = normalizeList(listed.data);
    const payload = [];
    const results = [];
    const secrets = [];

    for (const wanted of WANTED_NOTIFICATIONS) {
      const found = existing.find(function (item) {
        return notificationMatches(item, wanted);
      });
      const entry = {
        type: "webhook",
        resourceType: wanted.resourceType,
        httpTriggerMethod: wanted.httpTriggerMethod,
        endpoint: destination
      };
      if (pushSecret) entry.secret = secret;
      if (found && (found._id || found.id)) {
        entry._id = found._id || found.id;
        const revealed = await fetchNotificationSecret(entry._id);
        probes.push({
          path: "GET /notifications/" + entry._id + "/secret",
          status: revealed.status,
          ok: revealed.ok
        });
        if (revealed.ok) {
          secrets.push({
            id: entry._id,
            event: wanted.event,
            secret: revealed.data && (revealed.data.secret || revealed.data.value || revealed.data)
          });
        }
      }
      payload.push(entry);
      results.push({
        resource: wanted.resourceType,
        event: wanted.event,
        action: found ? (pushSecret ? "update_with_secret" : "update_destination") : "create",
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
      listed: summarizeHooks(existing),
      secrets: secrets,
      results: results,
      probes: probes,
      data: saved.ok ? undefined : saved.data,
      needUi: !saved.ok,
      hint: secrets.length
        ? "Copy a revealed secret into Vercel AKUTE_WEBHOOK_SECRET (org-wide), then redeploy."
        : undefined
    };
  }

  // --- Path B: Customer API /v1/webhooks ---
  const start = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const end = new Date().toISOString();
  const listedV1 = await listWebhooksV1({ start_time: start, end_time: end });
  const existing = listedV1.ok ? normalizeList(listedV1.data) : [];
  probes.push({
    path: "GET /v1/webhooks",
    status: listedV1.status,
    ok: listedV1.ok,
    count: existing.length,
    listed: summarizeHooks(existing),
    rawType: listedV1.data == null ? "null" : Array.isArray(listedV1.data) ? "array" : typeof listedV1.data,
    rawKeys: listedV1.data && !Array.isArray(listedV1.data) ? Object.keys(listedV1.data) : undefined,
    data: listedV1.ok ? undefined : listedV1.data
  });

  const results = [];
  if (listedV1.ok) {
    const taskHooks = existing.filter(isTaskHook);
    for (const wanted of WANTED_WEBHOOKS) {
      const found = existing.filter(function (hook) {
        return isTaskHook(hook) && hookEvent(hook) === wanted.event;
      });
      if (!found.length) {
        const body = {
          resource: wanted.resource,
          event: wanted.event,
          destination: destination,
          secret: secret
        };
        let created = await createWebhookV1(body);
        if (!created.ok) {
          const idGuess = wanted.resource + "-" + wanted.event;
          created = await updateWebhookV1(idGuess, Object.assign({ id: idGuess }, body));
          created = Object.assign({}, created, { triedId: idGuess });
        }
        results.push({
          resource: wanted.resource,
          event: wanted.event,
          action: "create",
          ok: created.ok,
          status: created.status,
          auth: created.auth,
          triedId: created.triedId,
          data: created.ok ? undefined : created.data
        });
      } else {
        for (const hook of found) {
          const id = hookId(hook);
          const body = {
            resource: wanted.resource,
            event: wanted.event,
            destination: destination
          };
          // Default: do NOT overwrite org secret. Only retarget destination.
          if (pushSecret) body.secret = secret;
          const updated = await updateWebhookV1(id, body);
          // Also try revealing portal secret if id looks usable.
          let revealed = null;
          if (id) {
            revealed = await fetchNotificationSecret(id);
            probes.push({
              path: "GET /notifications/" + id + "/secret",
              status: revealed.status,
              ok: revealed.ok
            });
          }
          results.push({
            resource: wanted.resource,
            event: wanted.event,
            action: pushSecret ? "update_with_secret" : "update_destination",
            ok: updated.ok,
            status: updated.status,
            auth: updated.auth,
            id: id,
            previousDestination: hookDestination(hook) || null,
            revealedSecret: revealed && revealed.ok
              ? (revealed.data && (revealed.data.secret || revealed.data.value || revealed.data))
              : null,
            data: updated.ok ? undefined : updated.data
          });
        }
      }
    }

    // If Task hooks exist under unexpected event labels, still surface them.
    const unmatched = taskHooks.filter(function (hook) {
      const event = hookEvent(hook);
      return event !== "create" && event !== "update";
    });

    const ok = results.length > 0 && results.every(function (r) { return r.ok; });
    const anyRevealed = results.some(function (r) { return r.revealedSecret; });
    return {
      ok: ok,
      via: "v1/webhooks",
      destination: destination,
      listed: summarizeHooks(existing),
      unmatchedTaskHooks: summarizeHooks(unmatched),
      results: results,
      probes: probes,
      needUi: !ok && !existing.length,
      hint: anyRevealed
        ? "Copy revealedSecret into Vercel Production AKUTE_WEBHOOK_SECRET, then redeploy."
        : (existing.length
          ? "Task webhooks exist. Set glp-tennessee AKUTE_WEBHOOK_SECRET to the Akute org secret (same as sprymd-ai), then redeploy."
          : undefined)
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
  notificationMatches,
  summarizeHooks,
  isTaskHook,
  hookEvent
};
