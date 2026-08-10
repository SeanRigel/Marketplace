import { verifyWebhook, formEncode } from './stripe.js';

const SECRET = 'whsec_test_abc123';
const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

// Build a signature exactly the way Stripe does.
async function sign(payload, ts, secret = SECRET) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${payload}`));
  return Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const now = Math.floor(Date.now() / 1000);
let pass = 0, fail = 0;
const check = (name, ok) => { ok ? (pass++, console.log('  PASS  ' + name)) : (fail++, console.log('  FAIL  ' + name)); };

// 1. valid signature
let sig = await sign(body, now);
try { const e = await verifyWebhook(body, `t=${now},v1=${sig}`, SECRET); check('accepts a valid signature', e.id === 'evt_1'); }
catch (e) { check('accepts a valid signature -> ' + e.message, false); }

// 2. tampered body
try { await verifyWebhook(body.replace('cs_1', 'cs_EVIL'), `t=${now},v1=${sig}`, SECRET); check('rejects a tampered body', false); }
catch { check('rejects a tampered body', true); }

// 3. wrong secret
try { await verifyWebhook(body, `t=${now},v1=${await sign(body, now, 'whsec_wrong')}`, SECRET); check('rejects a wrong secret', false); }
catch { check('rejects a wrong secret', true); }

// 4. replay of an old but genuine payload
const old = now - 900;
try { await verifyWebhook(body, `t=${old},v1=${await sign(body, old)}`, SECRET); check('rejects a replayed old event', false); }
catch { check('rejects a replayed old event', true); }

// 5. missing header
try { await verifyWebhook(body, null, SECRET); check('rejects a missing header', false); }
catch { check('rejects a missing header', true); }

// 6. rotation: several v1 sigs, one correct
try { const e = await verifyWebhook(body, `t=${now},v1=${await sign(body,now,'other')},v1=${sig}`, SECRET);
  check('accepts during secret rotation', e.id === 'evt_1'); }
catch (e) { check('accepts during secret rotation -> ' + e.message, false); }

// 7. nested form encoding, as Stripe's API needs it
const enc = decodeURIComponent(formEncode({ line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 14900 } }] }));
check('encodes nested params', enc.includes('line_items[0][price_data][unit_amount]=14900') && enc.includes('line_items[0][quantity]=1'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
