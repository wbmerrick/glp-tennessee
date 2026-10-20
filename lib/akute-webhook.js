const crypto = require("crypto");

/**
 * Akute signs deliveries with HMAC-SHA256 in x-akute-signature.
 * Accept hex or base64 digests of the raw body (both appear in the wild).
 */
function verifyAkuteSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || rawBody === undefined || rawBody === null) return false;
  const provided = String(signatureHeader).trim();
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const digest = hmac.digest();
  const candidates = [
    digest.toString("hex"),
    digest.toString("base64"),
    "sha256=" + digest.toString("hex"),
    "v1=" + digest.toString("hex")
  ];
  return candidates.some(function (expected) {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (typeof req.rawBody === "string") return Buffer.from(req.rawBody, "utf8");
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body), "utf8");
  return Buffer.alloc(0);
}

function parseWebhookPayload(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  const raw = readRawBody(req).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

module.exports = {
  verifyAkuteSignature,
  readRawBody,
  parseWebhookPayload
};
