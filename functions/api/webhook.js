/* POST /api/webhook — Stripe event sink.
 *
 * This is the only thing that creates purchase rows. The browser cannot: there is
 * no client insert policy on `purchases` (see schema.sql), so a user cannot mint
 * themselves a completed purchase and unlock a repo they never paid for.
 *
 * Everything here must tolerate being delivered twice. Stripe guarantees
 * at-least-once, and a retry after a timeout is normal, not exceptional.
 */
import { json, fail, requireEnv, failSetup } from '../_shared/http.js';
import { verifyWebhook } from '../_shared/stripe.js';
import { sbAdmin } from '../_shared/supabase.js';
import { sendEmail, userEmail, buyerReceipt, sellerSale, buyerRefunded, sellerRefunded }
  from '../_shared/notify.js';

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['STRIPE_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  } catch (e) {
    return failSetup(e);
  }

  // Read the body as raw text. Parsing before verifying would mean acting on
  // bytes we haven't authenticated yet.
  const raw = await request.text();

  let event;
  try {
    event = await verifyWebhook(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return fail(`Webhook signature verification failed: ${e.message}`, 400);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await onCheckoutComplete(env, event.data.object);
        break;

      case 'charge.refunded':
        await onChargeRefunded(env, event.data.object);
        break;

      case 'account.updated':
        await onAccountUpdated(env, event.data.object);
        break;

      default:
        break; // Unhandled types are fine — acknowledge so Stripe stops retrying.
    }
  } catch (e) {
    // 500 tells Stripe to retry. Correct for transient failures; the unique index
    // on the session id keeps the retry from double-inserting.
    return fail(e.message || 'Handler failed', 500);
  }

  return json({ received: true });
}

async function onCheckoutComplete(env, session) {
  if (session.payment_status !== 'paid') return;

  const meta = session.metadata || {};
  if (!meta.listing_id || !meta.buyer_id) {
    throw new Error('Checkout session missing listing_id/buyer_id metadata');
  }

  const settings = await sbAdmin(env, '/platform_settings?select=refund_window_days&limit=1');
  const days = settings?.[0]?.refund_window_days ?? 14;

  const expires = new Date(Date.now() + days * 86400000).toISOString();

  await sbAdmin(env, '/purchases', {
    method: 'POST',
    headers: {
      // Idempotency: a redelivered event hits the unique index on
      // stripe_checkout_session_id and updates in place instead of erroring.
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: {
      listing_id: meta.listing_id,
      buyer_id: meta.buyer_id,
      seller_id: meta.seller_id || null,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent,
      amount_cents: session.amount_total,
      platform_fee_cents: Number(meta.platform_fee_cents || 0),
      license: meta.license === 'extended' ? 'extended' : 'single',
      status: 'complete',
      refund_window_expires_at: expires
    }
  });

  // Everything below is best-effort. The purchase is already written and the
  // money has already moved; a mail outage must not make this handler throw,
  // because throwing here asks Stripe to redeliver an event we have processed.
  await tellThemAboutTheSale(env, session, meta, days);
}

async function tellThemAboutTheSale(env, session, meta, refundDays) {
  try {
    const siteUrl = (env.SITE_URL || '').replace(/\/$/, '');

    const rows = await sbAdmin(
      env,
      `/listings?select=title,seller_id&id=eq.${encodeURIComponent(meta.listing_id)}`
    );
    const listing = rows?.[0];
    if (!listing) return;

    const amountCents = session.amount_total;
    const feeCents = Number(meta.platform_fee_cents || 0);
    const license = meta.license === 'extended' ? 'extended' : 'single';

    // The buyer's address is already on the session — no lookup needed.
    const buyerAddr = session.customer_email || await userEmail(env, meta.buyer_id);
    if (buyerAddr) {
      await sendEmail(env, Object.assign({ to: buyerAddr }, buyerReceipt({
        listingTitle: listing.title, amountCents, license, siteUrl, refundDays
      })));
    }

    const sellerAddr = await userEmail(env, listing.seller_id);
    if (sellerAddr) {
      await sendEmail(env, Object.assign({ to: sellerAddr }, sellerSale({
        listingTitle: listing.title, amountCents, feeCents, siteUrl, refundDays
      })));
    }
  } catch (e) {
    console.error('[webhook] sale notifications failed: ' + (e && e.message ? e.message : e));
  }
}

async function onChargeRefunded(env, charge) {
  // Covers refunds issued from the Stripe dashboard as well as our own endpoint,
  // so the two can never drift apart.
  if (!charge.payment_intent) return;
  await sbAdmin(env, `/purchases?stripe_payment_intent_id=eq.${encodeURIComponent(charge.payment_intent)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: { status: 'refunded', refunded_at: new Date().toISOString() }
  });

  // Fired from here rather than from refund.js so that refunds issued in the
  // Stripe dashboard notify people too. charge.refunded is the one event both
  // paths pass through.
  await tellThemAboutTheRefund(env, charge);
}

async function tellThemAboutTheRefund(env, charge) {
  try {
    const rows = await sbAdmin(
      env,
      '/purchases?select=amount_cents,buyer_id,listing_id' +
      `&stripe_payment_intent_id=eq.${encodeURIComponent(charge.payment_intent)}`
    );
    const purchase = rows?.[0];
    if (!purchase) return;

    const listings = await sbAdmin(
      env,
      `/listings?select=title,seller_id&id=eq.${encodeURIComponent(purchase.listing_id)}`
    );
    const listing = listings?.[0];
    if (!listing) return;

    const buyerAddr = await userEmail(env, purchase.buyer_id);
    if (buyerAddr) {
      await sendEmail(env, Object.assign({ to: buyerAddr }, buyerRefunded({
        listingTitle: listing.title, amountCents: purchase.amount_cents
      })));
    }

    const sellerAddr = await userEmail(env, listing.seller_id);
    if (sellerAddr) {
      await sendEmail(env, Object.assign({ to: sellerAddr }, sellerRefunded({
        listingTitle: listing.title, amountCents: purchase.amount_cents
      })));
    }
  } catch (e) {
    console.error('[webhook] refund notifications failed: ' + (e && e.message ? e.message : e));
  }
}

async function onAccountUpdated(env, account) {
  // Keeps the seller dashboard honest about whether onboarding is actually done.
  await sbAdmin(env, `/profiles?stripe_connect_id=eq.${encodeURIComponent(account.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: {
      stripe_charges_enabled: !!account.charges_enabled,
      stripe_payouts_enabled: !!account.payouts_enabled,
      stripe_details_submitted: !!account.details_submitted
    }
  });
}
