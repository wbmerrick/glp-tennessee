const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ensureTaskWebhooks,
  normalizeList,
  matchWanted,
  DEFAULT_DESTINATION
} = require("./akute-register-webhooks");

test("normalizeList accepts array or wrapped payloads", function () {
  assert.deepEqual(normalizeList([{ id: "1" }]), [{ id: "1" }]);
  assert.deepEqual(normalizeList({ webhooks: [{ id: "2" }] }), [{ id: "2" }]);
  assert.deepEqual(normalizeList({ data: [{ id: "3" }] }), [{ id: "3" }]);
  assert.deepEqual(normalizeList(null), []);
});

test("matchWanted compares resource + event case-insensitively", function () {
  assert.equal(matchWanted({ resource: "Tasks", event: "Create" }, { resource: "tasks", event: "create" }), true);
  assert.equal(matchWanted({ resource_type: "tasks", event_type: "update" }, { resource: "tasks", event: "update" }), true);
  assert.equal(matchWanted({ resource: "patients", event: "create" }, { resource: "tasks", event: "create" }), false);
});

test("ensureTaskWebhooks creates missing Tasks create/update hooks", async function () {
  process.env.AKUTE_API_KEY = "key";
  process.env.AKUTE_WEBHOOK_SECRET = "whsec";
  const calls = [];
  const original = global.fetch;
  global.fetch = async function (url, opts) {
    const method = opts.method || "GET";
    const path = String(url).replace("https://api.akutehealth.com", "");
    calls.push({ method: method, path: path, body: opts.body ? JSON.parse(opts.body) : null });
    if (method === "GET" && path === "/v1/webhooks") {
      return {
        ok: true,
        status: 200,
        text: async function () { return "[]"; }
      };
    }
    if (method === "POST" && path === "/v1/webhooks") {
      return {
        ok: true,
        status: 200,
        text: async function () {
          return JSON.stringify({ id: "new-" + calls.length, resource: calls[calls.length - 1].body.resource });
        }
      };
    }
    return { ok: false, status: 500, text: async function () { return "{}"; } };
  };

  try {
    const result = await ensureTaskWebhooks({});
    assert.equal(result.ok, true);
    assert.equal(result.destination, DEFAULT_DESTINATION);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].action, "create");
    assert.equal(result.results[1].action, "create");
    const creates = calls.filter(function (c) { return c.method === "POST" && c.path === "/v1/webhooks"; });
    assert.equal(creates.length, 2);
    assert.equal(creates[0].body.secret, "whsec");
    assert.equal(creates[0].body.destination, DEFAULT_DESTINATION);
  } finally {
    global.fetch = original;
    delete process.env.AKUTE_API_KEY;
    delete process.env.AKUTE_WEBHOOK_SECRET;
  }
});

test("ensureTaskWebhooks updates existing destination and refreshes secret", async function () {
  process.env.AKUTE_API_KEY = "key";
  process.env.AKUTE_WEBHOOK_SECRET = "whsec";
  const calls = [];
  const original = global.fetch;
  global.fetch = async function (url, opts) {
    const method = opts.method || "GET";
    const path = String(url).replace("https://api.akutehealth.com", "");
    calls.push({ method: method, path: path, body: opts.body ? JSON.parse(opts.body) : null });
    if (method === "GET" && path === "/v1/webhooks") {
      return {
        ok: true,
        status: 200,
        text: async function () {
          return JSON.stringify([
            { id: "c1", resource: "tasks", event: "create", destination: "https://old.example/hook" },
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
    assert.equal(result.results[0].action, "update_destination");
    assert.equal(result.results[1].action, "refresh_secret");
    assert.equal(calls.filter(function (c) { return c.method === "POST"; }).length, 2);
  } finally {
    global.fetch = original;
    delete process.env.AKUTE_API_KEY;
    delete process.env.AKUTE_WEBHOOK_SECRET;
  }
});
