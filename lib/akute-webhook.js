const crypto = require("crypto");

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseAkuteSignatureHeader(header) {
  if (typeof header !== "string" || !header.trim()) return null;
  const parts = header.split(",").reduce(
    function (accum, item) {
      const kv = item.split("=");
      if (kv.length < 2) return accum;
      const key = kv[0].trim();
      const value = kv.slice(1).join("=").trim();
      if (key === "t") accum.timestamp = value;
      if (key === "v1") accum.signatures.push(value);
      return accum;
    },
    { timestamp: null, signatures: [] }
  );
  if (parts.timestamp && parts.signatures.length) return parts;
  return null;
}

/**
 * Akute signs deliveries with HMAC-SHA256 in x-akute-signature.
 * Supports:
 *  - Official docs: t=<unix>,v1=<hex(hmac(secret, `${t}.${rawBody}`))>
 *  - Raw-body digests (hex / base64 / sha256= / v1=) seen in the wild
 */
function verifyAkuteSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader || rawBody === undefined || rawBody === null) return false;
  const provided = String(signatureHeader).trim();
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const bodyText = body.toString("utf8");

  const structured = parseAkuteSignatureHeader(provided);
  if (structured) {
    const ageSec = Math.abs(Date.now() / 1000 - Number(structured.timestamp));
    if (!Number.isFinite(ageSec) || ageSec > 60 * 5) return false;
    const signedPayload = structured.timestamp + "." + bodyText;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(signedPayload, "utf8")
      .digest("hex");
    return structured.signatures.some(function (sig) {
      return timingSafeEqualString(sig, expected);
    });
  }

  const digest = crypto.createHmac("sha256", secret).update(body).digest();
  const candidates = [
    digest.toString("hex"),
    digest.toString("base64"),
    "sha256=" + digest.toString("hex"),
    "v1=" + digest.toString("hex")
  ];
  return candidates.some(function (expected) {
    return timingSafeEqualString(provided, expected);
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
  parseAkuteSignatureHeader,
  readRawBody,
  parseWebhookPayload
};
