const test = require("node:test");
const assert = require("node:assert/strict");
const { decideAccess, isCheckoutSessionId } = require("./checkout-access");

function paidSession(overrides) {
  return Object.assign({
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "subscription",
    payment_link: { url: "https://buy.stripe.com/6oU7sN2yM0mE7XZ2TP7Zu02" },
    line_items: {
      data: [{ quantity: 1, price: { unit_amount: 9900, currency: "usd" } }]
    }
  }, overrides);
}

test("allows a completed paid membership checkout", function () {
  assert.equal(decideAccess(paidSession()).ok, true);
});

test("rejects unpaid, open, and non-subscription sessions", function () {
  assert.equal(decideAccess(paidSession({ payment_status: "unpaid" })).ok, false);
  assert.equal(decideAccess(paidSession({ status: "open" })).ok, false);
  assert.equal(decideAccess(paidSession({ mode: "payment" })).ok, false);
  assert.equal(decideAccess(null).ok, false);
  assert.equal(decideAccess(paidSession({ object: "payment_intent" })).ok, false);
});

test("rejects a different payment link or price", function () {
  assert.equal(decideAccess(paidSession({
    payment_link: { url: "https://buy.stripe.com/some-other-link" }
  })).ok, false);
  assert.equal(decideAccess(paidSession({ payment_link: "plink_123" })).ok, false);
  assert.equal(decideAccess(paidSession({
    line_items: { data: [{ quantity: 1, price: { unit_amount: 100, currency: "usd" } }] }
  })).ok, false);
  assert.equal(decideAccess(paidSession({
    line_items: { data: [{ quantity: 2, price: { unit_amount: 9900, currency: "usd" } }] }
  })).ok, false);
  assert.equal(decideAccess(paidSession({ line_items: { data: [] } })).ok, false);
});

test("accepts only Stripe checkout session ids", function () {
  assert.equal(isCheckoutSessionId("cs_live_abc123"), true);
  assert.equal(isCheckoutSessionId("cs_test_abc123"), true);
  assert.equal(isCheckoutSessionId("cs_live_"), false);
  assert.equal(isCheckoutSessionId("pi_live_abc123"), false);
  assert.equal(isCheckoutSessionId(""), false);
  assert.equal(isCheckoutSessionId(null), false);
});
