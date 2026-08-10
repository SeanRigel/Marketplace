/* Stripe over plain fetch.
 *
 * We deliberately do not use the Stripe SDK: Pages Functions would then need a
 * bundler, and the whole project is currently build-step-free. The REST API is
 * form-encoded, so the only real work is flattening nested params and verifying
 * webhook signatures by hand.
 */

const API = 'https://api.stripe.com/v1';

/* Stripe wants bracket notation: line_items[0][price_data][currency]=usd */
export function formEncode(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (v !== null && typeof v === 'object') formEncode(v, `${k}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${k}[${i}]`)}=${encodeURIComponent(v)}`);
      });
    } else if (typeof value === 'object') {
      formEncode(value, k, out);
    } else {
      out.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
    }
  }
  return out.join('&');
}

export async function stripe(env, method, path, params, opts = {}) {
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  // Retried writes must not double-charge or double-transfer.
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: params ? formEncode(params) : undefined
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message || `Stripe ${res.status}`;
    const err = new Error(msg);
    err.stripeCode = body?.error?.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

/* ---- webhook signature verification (Web Crypto, no SDK) ---------------- */

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies a Stripe-Signature header against the raw request body.
 * Returns the parsed event, or throws. `rawBody` must be the exact bytes Stripe
 * sent — parse the JSON only after this passes, never before.
 */
export async function verifyWebhook(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader) throw new Error('Missing Stripe-Signature header');

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );

  const timestamp = parts.t;
  if (!timestamp) throw new Error('No timestamp in signature header');

  // Reject replays of an old, legitimately-signed payload.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > toleranceSeconds) throw new Error('Signature timestamp outside tolerance');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // Stripe may send several v1 signatures during a secret rotation.
  const provided = signatureHeader
    .split(',')
    .map((p) => p.split('='))
    .filter(([k]) => k.trim() === 'v1')
    .map(([, v]) => v.trim());

  if (!provided.some((sig) => timingSafeEqual(sig, expected))) {
    throw new Error('Signature mismatch');
  }

  return JSON.parse(rawBody);
}
