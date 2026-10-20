const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const webhookHandler = require("../api/akute-webhook");
const sweepHandler = require("../api/akute-sync-sweep");
const registerHandler = require("../api/akute-register-webhooks");

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
  delete process.env.AKUTE_WEBHOOK_SECRET;
  const missing = mockRes();
  await webhookHandler({ method: "POST", headers: {}, body: {} }, missing);
  assert.equal(missing.statusCode, 503);

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
  delete process.env.AKUTE_WEBHOOK_SECRET;
});

test("webhook acknowledges but does not chart-sync (sprymd owns sync)", async function () {
  process.env.AKUTE_WEBHOOK_SECRET = "secret";
  const original = global.fetch;
  let fetchCalls = 0;
  global.fetch = async function () {
    fetchCalls += 1;
    return { ok: true, status: 200, text: async function () { return "{}"; } };
  };

  try {
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
    const res = mockRes();
    await webhookHandler({
      method: "POST",
      headers: { "x-akute-signature": sign(syncBody, "secret") },
      rawBody: syncBody,
      body: JSON.parse(syncBody.toString())
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.ignored, true);
    assert.equal(res.body.reason, "chart_sync_retired");
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = original;
    delete process.env.AKUTE_WEBHOOK_SECRET;
  }
});

test("sweep and register are retired stubs", async function () {
  const sweep = mockRes();
  await sweepHandler({ method: "GET", headers: {}, query: {} }, sweep);
  assert.equal(sweep.statusCode, 200);
  assert.equal(sweep.body.retired, true);

  const register = mockRes();
  await registerHandler({ method: "GET", headers: {}, query: {} }, register);
  assert.equal(register.statusCode, 200);
  assert.equal(register.body.retired, true);
  assert.match(register.body.owner, /sprymd\.ai/);
});
