const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const webhookHandler = require("../api/akute-webhook");
const sweepHandler = require("../api/akute-sync-sweep");

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

function sign(body, secret) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

test("webhook refuses unsigned or unconfigured requests", async function () {
  delete process.env.AKUTE_API_KEY;
  delete process.env.AKUTE_USER_ID;
  delete process.env.AKUTE_WEBHOOK_SECRET;
  const missing = mockRes();
  await webhookHandler({ method: "POST", headers: {}, body: {} }, missing);
  assert.equal(missing.statusCode, 503);

  process.env.AKUTE_API_KEY = "key";
  process.env.AKUTE_USER_ID = "user";
  process.env.AKUTE_WEBHOOK_SECRET = "secret";
  const badSig = mockRes();
  const raw = Buffer.from('{"resource_type":"tasks","event_type":"create","data":{}}');
  await webhookHandler({
    method: "POST",
    headers: { "x-akute-signature": "nope" },
    rawBody: raw,
    body: JSON.parse(raw.toString())
  }, badSig);
  assert.equal(badSig.statusCode, 401);
});

test("webhook ignores non-form tasks and syncs form-submission tasks", async function () {
  process.env.AKUTE_API_KEY = "key";
  process.env.AKUTE_USER_ID = "user-1";
  process.env.AKUTE_WEBHOOK_SECRET = "secret";

  const calls = [];
  const original = global.fetch;
  global.fetch = async function (url, init) {
    calls.push({ url: String(url), method: (init && init.method) || "GET", body: init && init.body });
    const u = String(url);
    if (u.includes("/3_0_1/questionnaireResponse/qr-1") && !u.includes("items/add")) {
      return {
        ok: true, status: 200,
        text: async function () {
          return JSON.stringify({
            id: "qr-1",
            questionnaire: { reference: "Questionnaire/1190ffee-9e26-4dbf-bc63-dd07a7540377" },
            subject: { reference: "Patient/pat-1" },
            item: [{
              linkId: "home-address",
              item: [{ linkId: "address-line-1", answer: [{ valueString: "1 Main" }] }]
            }, {
              linkId: "preferred-pharmacy",
              item: [
                { linkId: "pharmacy-name", answer: [{ valueString: "CVS" }] },
                { linkId: "pharmacy-id", answer: [{ valueString: "42" }] }
              ]
            }]
          });
        }
      };
    }
    if (u.includes("/3_0_1/questionnaire/")) {
      return {
        ok: true, status: 200,
        text: async function () {
          return JSON.stringify({
            id: "1190ffee-9e26-4dbf-bc63-dd07a7540377",
            item: [
              { linkId: "home-address", definition: "address", type: "group", item: [] },
              { linkId: "preferred-pharmacy", definition: "pharmacy", type: "group", item: [] }
            ]
          });
        }
      };
    }
    if (u.includes("/items/add")) {
      return { ok: true, status: 200, text: async function () { return JSON.stringify({ response: {} }); } };
    }
    return { ok: false, status: 404, text: async function () { return "{}"; } };
  };

  try {
    const ignoredBody = Buffer.from(JSON.stringify({
      resource_type: "tasks",
      event_type: "create",
      data: { tags: ["other"], attachmentResourceType: "Note", attachmentResources: ["n1"] }
    }));
    const ignored = mockRes();
    await webhookHandler({
      method: "POST",
      headers: { "x-akute-signature": sign(ignoredBody, "secret") },
      rawBody: ignoredBody,
      body: JSON.parse(ignoredBody.toString())
    }, ignored);
    assert.equal(ignored.statusCode, 200);
    assert.equal(ignored.body.ignored, true);

    const syncBody = Buffer.from(JSON.stringify({
      resource_type: "tasks",
      event_type: "create",
      patient_id: "pat-1",
      data: {
        tags: ["form submission"],
        attachmentResourceType: "QuestionnaireResponse",
        attachmentResources: ["qr-1"],
        patientId: "pat-1"
      }
    }));
    const synced = mockRes();
    await webhookHandler({
      method: "POST",
      headers: { "x-akute-signature": sign(syncBody, "secret") },
      rawBody: syncBody,
      body: JSON.parse(syncBody.toString())
    }, synced);
    assert.equal(synced.statusCode, 200);
    assert.equal(synced.body.ok, true);
    assert.equal(synced.body.synced, 1);
    const adds = calls.filter(function (c) { return c.url.includes("/items/add"); });
    assert.equal(adds.length, 2);
    const types = adds.map(function (c) { return JSON.parse(c.body).resourceType; }).sort();
    assert.deepEqual(types, ["address", "pharmacy"]);
  } finally {
    global.fetch = original;
    delete process.env.AKUTE_API_KEY;
    delete process.env.AKUTE_USER_ID;
    delete process.env.AKUTE_WEBHOOK_SECRET;
  }
});

test("sweep requires configuration and optional shared secret", async function () {
  delete process.env.AKUTE_API_KEY;
  delete process.env.AKUTE_USER_ID;
  delete process.env.AKUTE_SWEEP_SECRET;
  const missing = mockRes();
  await sweepHandler({ method: "GET", headers: {}, query: {} }, missing);
  assert.equal(missing.statusCode, 503);

  process.env.AKUTE_API_KEY = "key";
  process.env.AKUTE_USER_ID = "user";
  process.env.AKUTE_SWEEP_SECRET = "sweep";
  const denied = mockRes();
  await sweepHandler({ method: "GET", headers: {}, query: {} }, denied);
  assert.equal(denied.statusCode, 401);

  const original = global.fetch;
  global.fetch = async function () {
    return { ok: true, status: 200, text: async function () { return "[]"; } };
  };
  try {
    const ok = mockRes();
    await sweepHandler({
      method: "GET",
      headers: { "x-vercel-cron": "1" },
      query: { secret: "sweep" }
    }, ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.ok, true);
  } finally {
    global.fetch = original;
    delete process.env.AKUTE_API_KEY;
    delete process.env.AKUTE_USER_ID;
    delete process.env.AKUTE_SWEEP_SECRET;
  }
});
