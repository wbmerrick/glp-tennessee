const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const handler = require("../api/checkout-session");

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  return res;
}

function paidSession() {
  return {
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "subscription",
    payment_link: { url: "https://buy.stripe.com/6oU7sN2yM0mE7XZ2TP7Zu02" },
    line_items: { data: [{ quantity: 1, price: { unit_amount: 9900, currency: "usd" } }] }
  };
}

test("refuses to reveal links without a confirmed paid session", async function () {
  delete process.env.STRIPE_SECRET_KEY;
  const missing = mockRes();
  await handler({ method: "GET", query: { session_id: "cs_test_abc123" } }, missing);
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.intakeUrl, undefined);

  process.env.STRIPE_SECRET_KEY = "sk_test_example";
  const original = global.fetch;
  global.fetch = async function () {
    return { ok: true, status: 200, json: async function () { return paidSession(); } };
  };
  try {
    const unpaid = mockRes();
    global.fetch = async function () {
      return {
        ok: true,
        status: 200,
        json: async function () { return Object.assign(paidSession(), { payment_status: "unpaid" }); }
      };
    };
    await handler({ method: "GET", query: { session_id: "cs_test_abc123" } }, unpaid);
    assert.equal(unpaid.statusCode, 403);
    assert.equal(unpaid.body.intakeUrl, undefined);

    global.fetch = async function () {
      return { ok: true, status: 200, json: async function () { return paidSession(); } };
    };
    const paid = mockRes();
    await handler({ method: "GET", query: { session_id: "cs_live_paid123" } }, paid);
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.body.ok, true);
    assert.match(paid.body.intakeUrl, /^https:\/\/glptennessee\.akutehealth\.com\/forms\/6ad624f0329a6097a0d5d8f6$/);
    assert.match(paid.body.bookingUrl, /^https:\/\/glptennessee\.akutehealth\.com\/appointments\/6ad60073a670cf017381e06c$/);
  } finally {
    global.fetch = original;
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test("rejects a malformed session id before calling Stripe", async function () {
  process.env.STRIPE_SECRET_KEY = "sk_test_example";
  let called = false;
  const original = global.fetch;
  global.fetch = async function () { called = true; throw new Error("should not call"); };
  try {
    const res = mockRes();
    await handler({ method: "GET", query: { session_id: "not-a-session" } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
  } finally {
    global.fetch = original;
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test("the success page does not embed the intake or booking links", function () {
  const html = fs.readFileSync(path.join(__dirname, "../success.html"), "utf8");
  assert.equal(html.includes("/forms/"), false);
  assert.equal(html.includes("/appointments/"), false);
  assert.equal(html.includes("AKUTE_INTAKE_URL"), false);
});
