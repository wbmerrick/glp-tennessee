const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ensureTaskWebhooks,
  normalizeList,
  notificationMatches,
  isTaskHook,
  hookEvent,
  DEFAULT_DESTINATION
} = require("./akute-register-webhooks");

test("normalizeList accepts array or wrapped payloads", function () {
  assert.deepEqual(normalizeList([{ id: "1" }]), [{ id: "1" }]);
  assert.deepEqual(normalizeList({ webhooks: [{ id: "2" }] }), [{ id: "2" }]);
  assert.deepEqual(normalizeList({ notifications: [{ id: "3" }] }), [{ id: "3" }]);
  assert.deepEqual(normalizeList(null), []);
});

test("notificationMatches and hook helpers normalize Task/POST shapes", function () {
  assert.equal(
    notificationMatches(
      { resourceType: "Task", httpTriggerMethod: "POST" },
      { resourceType: "Task", httpTriggerMethod: "POST" }
    ),
    true
  );
  assert.equal(isTaskHook({ resource: "Task" }), true);
  assert.equal(isTaskHook({ resourceType: "tasks" }), true);
  assert.equal(hookEvent({ httpTriggerMethod: "POST" }), "create");
  assert.equal(hookEvent({ event: "update" }), "update");
});

test("ensureTaskWebhooks uses /notifications when list succeeds", async function () {
  process.env.AKUTE_API_KEY = "key";
  process.env.AKUTE_WEBHOOK_SECRET = "whsec";
  const calls = [];
  const original = global.fetch;
  global.fetch = async function (url, opts) {
    const method = opts.method || "GET";
    const path = String(url).replace("https://api.akutehealth.com", "");
    calls.push({ method: method, path: path, body: opts.body ? JSON.parse(opts.body) : null });
    if (method === "GET" && path.indexOf("/notifications/") === 0 && path.indexOf("/secret") > 0) {
      return { ok: false, status: 401, text: async function () { return "{}"; } };
    }
    if (method === "GET" && path.indexOf("/notifications") === 0) {
      return {
        ok: true,
        status: 200,
        text: async function () {
          return JSON.stringify([
            { _id: "n1", resourceType: "Task", httpTriggerMethod: "POST", endpoint: "https://old.example" }
          ]);
        }
      };
    }
    if (method === "POST" && path === "/notifications") {
      return { ok: true, status: 200, text: async function () { return "{}"; } };
    }
    return { ok: false, status: 500, text: async function () { return "{}"; } };
  };

  try {
    const result = await ensureTaskWebhooks({});
    assert.equal(result.ok, true);
    assert.equal(result.via, "notifications");
    assert.equal(result.destination, DEFAULT_DESTINATION);
    const post = calls.find(function (c) { return c.method === "POST" && c.path === "/notifications"; });
    assert.ok(post);
    assert.equal(post.body.notificationsArray.length, 2);
    assert.equal(post.body.notificationsArray[0].endpoint, DEFAULT_DESTINATION);
    assert.equal(post.body.notificationsArray[0].secret, undefined);
    assert.equal(post.body.notificationsArray[0]._id, "n1");
  } finally {
    global.fetch = original;
    delete process.env.AKUTE_API_KEY;
    delete process.env.AKUTE_WEBHOOK_SECRET;
  }
});

test("ensureTaskWebhooks updates Task hooks found via /v1/webhooks", async function () {
  process.env.AKUTE_API_KEY = "key";
  process.env.AKUTE_WEBHOOK_SECRET = "whsec";
  const calls = [];
  const original = global.fetch;
  global.fetch = async function (url, opts) {
    const method = opts.method || "GET";
    const path = String(url).replace("https://api.akutehealth.com", "");
    calls.push({ method: method, path: path, body: opts.body ? JSON.parse(opts.body) : null });
    if (method === "GET" && path.indexOf("/notifications") === 0) {
      return { ok: false, status: 401, text: async function () { return '{"message":"no"}'; } };
    }
    if (method === "GET" && path.indexOf("/v1/webhooks") === 0) {
      return {
        ok: true,
        status: 200,
        text: async function () {
          return JSON.stringify([
            { id: "c1", resource: "Task", event: "create", destination: "https://old.example/hook" },
            { id: "u1", resource: "tasks", event: "update", destination: DEFAULT_DESTINATION }
          ]);
        }
      };
    }
    if (method === "POST" && path.indexOf("/v1/webhooks/") === 0) {
      return { ok: true, status: 200, text: async function () { return "{}"; } };
    }
    return { ok: false, status: 500, text: async function () { return "{}"; } };
  };

  try {
    const result = await ensureTaskWebhooks({});
    assert.equal(result.ok, true);
    assert.equal(result.via, "v1/webhooks");
    assert.equal(result.listed.length, 2);
    assert.equal(result.results[0].action, "update_destination");
    const updates = calls.filter(function (c) { return c.method === "POST" && c.path.indexOf("/v1/webhooks/") === 0; });
    assert.equal(updates.length, 2);
    assert.equal(updates[0].body.secret, undefined);
    assert.equal(updates[0].body.destination, DEFAULT_DESTINATION);
  } finally {
    global.fetch = original;
    delete process.env.AKUTE_API_KEY;
    delete process.env.AKUTE_WEBHOOK_SECRET;
  }
});
