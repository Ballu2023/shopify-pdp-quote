import crypto from 'node:crypto';
import { httpError } from './shopify.js';

// Shopify signs every app proxy request. To check it:
// take all query params except "signature", make "key=value" pairs
// (same key twice -> values joined by comma), sort them, join with nothing,
// then HMAC-SHA256 with the app secret.
export function getSignature(params, secret) {
  const values = {};
  for (const [key, value] of params) {
    if (key === 'signature') continue;
    values[key] = values[key] ? `${values[key]},${value}` : value;
  }

  const message = Object.keys(values)
    .map((key) => `${key}=${values[key]}`)
    .sort()
    .join('');

  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

export function verifyProxy(req, res, next) {
  const params = new URL(req.originalUrl, 'http://localhost').searchParams;
  const received = params.get('signature') || '';
  const expected = getSignature(params, process.env.SHOPIFY_CLIENT_SECRET);

  // timingSafeEqual needs equal length buffers
  const valid =
    received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));

  if (!valid || params.get('shop') !== process.env.SHOPIFY_SHOP_DOMAIN) {
    console.warn('Rejected proxy request with bad signature/shop');
    return next(httpError(401, 'Unauthorized'));
  }

  // signed but old -> probably replayed
  const age = Date.now() / 1000 - Number(params.get('timestamp'));
  if (!(Math.abs(age) < 300)) {
    return next(httpError(401, 'Request expired, please refresh the page'));
  }

  next();
}
