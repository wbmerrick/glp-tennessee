/** Public Payment Link slug for the $99/month membership. */
const PAYMENT_LINK_SLUG = "6oU7sN2yM0mE7XZ2TP7Zu02";
const UNIT_AMOUNT = 9900;
const CURRENCY = "usd";

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/;

function isCheckoutSessionId(value) {
  return typeof value === "string" && SESSION_ID.test(value);
}

/**
 * A visitor may see post-payment steps only when this Checkout Session is a
 * completed, paid subscription bought through the membership Payment Link
 * at the $99 price. Anything else fails closed.
 */
function decideAccess(session) {
  if (!session || session.object !== "checkout.session") return { ok: false };
  if (session.status !== "complete") return { ok: false };
  if (session.payment_status !== "paid") return { ok: false };
  if (session.mode !== "subscription") return { ok: false };

  const link = session.payment_link;
  const url = link && typeof link === "object" ? link.url : "";
  if (typeof url !== "string" || !url.includes(PAYMENT_LINK_SLUG)) return { ok: false };

  const items = session.line_items && Array.isArray(session.line_items.data)
    ? session.line_items.data
    : [];
  const priced = items.some(function (item) {
    const price = item && item.price;
    return price
      && price.unit_amount === UNIT_AMOUNT
      && price.currency === CURRENCY
      && item.quantity === 1;
  });
  if (!priced) return { ok: false };

  return { ok: true };
}

module.exports = {
  PAYMENT_LINK_SLUG,
  isCheckoutSessionId,
  decideAccess
};
