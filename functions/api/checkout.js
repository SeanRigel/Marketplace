/* POST /api/checkout  { listing_id } -> { url }
 *
 * Creates a Stripe Checkout Session for one listing.
 *
 * Two things here are deliberate and should not be "simplified" later:
 *
 * 1. The price is read from the database, never from the request body. A client
 *    that can name its own price can buy a $500 template for a cent.
 * 2. There is no transfer_data / destination charge. Money settles on the platform
 *    account and the seller is paid by a separate transfer after the refund window
 *    closes (see release-payouts.js). That hold is what makes the guarantee real
 *    rather than a paragraph on a page.
 */
import { json, fail, requireEnv } from '../_shared/http.js';
import { stripe } from '../_shared/stripe.js';
import { sbAdmin, requireUser } from '../_shared/supabase.js';

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['STRIPE_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY']);
  } catch (e) {
    return fail(e.message, 500);
  }

  const { user, error } = await requireUser(request, env);
  if (error) return fail(error, 401);

  const body = await request.json().catch(() => ({}));
  const listingId = body.listing_id;
  if (!listingId) return fail('listing_id is required.');

  // Price, status, and seller all come from the server's view of the world.
  const rows = await sbAdmin(
    env,
    `/listings?select=id,title,price_cents,status,seller_id,profiles:seller_id(stripe_connect_id,stripe_charges_enabled)&id=eq.${encodeURIComponent(listingId)}`
  );
  const listing = rows?.[0];

  if (!listing) return fail('Listing not found.', 404);
  if (listing.status !== 'live') return fail('That listing is not for sale.', 409);
  if (listing.seller_id === user.id) return fail('You cannot buy your own listing.', 409);
  if (listing.price_cents <= 0) return fail('That listing has no price set.', 409);

  // Refuse rather than take money we might not be able to pass on.
  const seller = listing.profiles;
  if (!seller?.stripe_connect_id || !seller.stripe_charges_enabled) {
    return fail('This seller has not finished payment setup yet.', 409);
  }

  // Already bought it? Send them to their purchases instead of charging twice.
  const existing = await sbAdmin(
    env,
    `/purchases?select=id&buyer_id=eq.${user.id}&listing_id=eq.${listingId}&status=in.(pending,complete)`
  );
  if (existing?.length) return fail('You already own this tool.', 409);

  const settings = await sbAdmin(env, '/platform_settings?select=platform_fee_bps&limit=1');
  const feeBps = settings?.[0]?.platform_fee_bps ?? 1500;
  const feeCents = Math.round((listing.price_cents * feeBps) / 10000);

  const siteUrl = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');

  try {
    const session = await stripe(env, 'POST', '/checkout/sessions', {
      mode: 'payment',
      client_reference_id: user.id,
      customer_email: user.email,
      success_url: `${siteUrl}/app.html#/dashboard/buyer?purchased=1`,
      cancel_url: `${siteUrl}/app.html#/listing/${listing.id}`,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: listing.price_cents,
            product_data: { name: listing.title }
          }
        }
      ],
      // Everything the webhook needs to write the purchase row, carried by Stripe
      // so we don't need our own pending-session table.
      metadata: {
        listing_id: listing.id,
        buyer_id: user.id,
        seller_id: listing.seller_id,
        platform_fee_cents: String(feeCents)
      },
      payment_intent_data: {
        metadata: { listing_id: listing.id, buyer_id: user.id }
      }
    }, {
      // Same user + same listing within the same second shouldn't open two sessions.
      idempotencyKey: `checkout:${user.id}:${listing.id}:${Math.floor(Date.now() / 1000)}`
    });

    return json({ url: session.url, id: session.id });
  } catch (e) {
    return fail(e.message || 'Could not start checkout.', 502);
  }
}
