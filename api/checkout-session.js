const { decideAccess, isCheckoutSessionId } = require("../lib/checkout-access");

const INTAKE_URL = "https://glptennessee.akutehealth.com/forms/6ad624f0329a6097a0d5d8f6";
const BOOKING_URL = "https://glptennessee.akutehealth.com/appointments/6ad60073a670cf017381e06c";

async function stripeGet(key, path) {
  const response = await fetch("https://api.stripe.com" + path, {
    headers: { Authorization: "Bearer " + key }
  });
  if (!response.ok) {
    const error = new Error("stripe");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "GET") {
    res.status(405).json({ ok: false });
    return;
  }

  const sessionId = req.query && req.query.session_id;
  if (!isCheckoutSessionId(sessionId)) {
    res.status(400).json({ ok: false });
    return;
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    res.status(503).json({ ok: false });
    return;
  }

  const path = "/v1/checkout/sessions/" + encodeURIComponent(sessionId)
    + "?expand[]=line_items&expand[]=payment_link";

  try {
    const session = await stripeGet(key, path);
    const decision = decideAccess(session);
    if (!decision.ok) {
      res.status(403).json({ ok: false });
      return;
    }
    res.status(200).json({
      ok: true,
      intakeUrl: INTAKE_URL,
      bookingUrl: BOOKING_URL
    });
  } catch (error) {
    res.status(error.status === 404 ? 403 : 502).json({ ok: false });
  }
};
