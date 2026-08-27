/* Transactional email.
 *
 * Until now nothing in this project told anyone anything. A seller made a sale
 * and found out by refreshing a dashboard; a buyer refunded into silence; a demo
 * broke and its owner never knew. That is survivable while every listing belongs
 * to us and the users are people we can text. It is not survivable at launch.
 *
 * Sent over Resend's REST API with plain `fetch`, for the same reason Stripe is:
 * the SDK would need a bundler and this project has no build step.
 *
 * TWO RULES, both load-bearing:
 *
 * 1. UNSET KEY MEANS SILENCE, NOT FAILURE. With no RESEND_API_KEY the whole
 *    module no-ops and logs. A half-configured deploy still takes money
 *    correctly; it just doesn't email. Same principle as failSetup() elsewhere —
 *    a partly-configured site is safe to show strangers.
 *
 * 2. EMAIL MUST NEVER BREAK THE MONEY PATH. Every function here swallows its own
 *    errors. This matters more than it looks: the Stripe webhook returns 500 to
 *    ask for a retry, so if a failed email propagated out of onCheckoutComplete,
 *    Stripe would redeliver an event we already processed — turning a mail outage
 *    into repeated purchase writes. Notifications are strictly fire-and-forget
 *    with respect to payments.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/* Who mail comes from, and where replies land. Both overridable per-deploy so
 * this works on a pages.dev subdomain before a real domain exists. */
function sender(env) {
  return {
    from: env.MAIL_FROM || 'Forkable <onboarding@resend.dev>',
    replyTo: env.SUPPORT_EMAIL || null
  };
}

/**
 * Sends one email. Resolves either way — never throws, never rejects.
 * Returns { sent: boolean, skipped?: string, error?: string }.
 */
export async function sendEmail(env, { to, subject, text, html }) {
  if (!env.RESEND_API_KEY) {
    console.log(`[notify] RESEND_API_KEY unset — would have sent "${subject}" to ${to}`);
    return { sent: false, skipped: 'no_api_key' };
  }
  if (!to) {
    console.error('[notify] no recipient for: ' + subject);
    return { sent: false, skipped: 'no_recipient' };
  }

  const { from, replyTo } = sender(env);

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        html: html || undefined,
        ...(replyTo ? { reply_to: replyTo } : {})
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Logged, not thrown. See rule 2 at the top of this file.
      console.error(`[notify] Resend ${res.status} sending "${subject}": ${body.slice(0, 200)}`);
      return { sent: false, error: `resend_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error(`[notify] send failed for "${subject}": ${e && e.message ? e.message : e}`);
    return { sent: false, error: 'exception' };
  }
}

/**
 * Looks up a user's email by id through the GoTrue admin API.
 *
 * Needed because `auth.users` is not reachable over PostgREST — the auth schema
 * is not exposed — so the ordinary sbAdmin path cannot see it. Returns null
 * rather than throwing, so a missing address degrades to "no email sent".
 */
export async function userEmail(env, userId) {
  if (!userId || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(
      `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    if (!res.ok) {
      console.error(`[notify] could not look up user ${userId}: HTTP ${res.status}`);
      return null;
    }
    const user = await res.json();
    return user?.email || null;
  } catch (e) {
    console.error(`[notify] user lookup failed: ${e && e.message ? e.message : e}`);
    return null;
  }
}

/* ---------------------------------------------------------------- templates
 *
 * Plain text is the payload; the HTML is a light wrapper over the same words.
 * Deliberately no images, no tracking pixels, no marketing tone — these are
 * transactional messages about someone's money, and they should read like it.
 */

const money = (cents) => '$' + (Number(cents || 0) / 100).toFixed(Number(cents || 0) % 100 ? 2 : 0);

function wrap(bodyHtml) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:15px;line-height:1.6;color:#1a1a1a;max-width:520px">${bodyHtml}</div>`;
}

/** To the buyer, immediately after payment clears. */
export function buyerReceipt({ listingTitle, amountCents, license, siteUrl, refundDays }) {
  const text =
`You bought ${listingTitle}.

Amount: ${money(amountCents)}${license === 'extended' ? ' (extended licence)' : ''}

Your repository access is on your purchases page:
${siteUrl}/app.html#/dashboard/buyer

If it isn't what you expected, you can refund it yourself from that page — no
questions, no email to write. That option stays open for ${refundDays} days.`;

  return {
    subject: `Your purchase: ${listingTitle}`,
    text,
    html: wrap(
      `<p>You bought <strong>${escapeHtml(listingTitle)}</strong>.</p>
       <p>Amount: <strong>${money(amountCents)}</strong>${license === 'extended' ? ' (extended licence)' : ''}</p>
       <p><a href="${siteUrl}/app.html#/dashboard/buyer">Get your repository access →</a></p>
       <p style="color:#555">If it isn't what you expected, you can refund it yourself from that
       page — no questions, no email to write. That option stays open for ${refundDays} days.</p>`
    )
  };
}

/** To the seller, when someone buys. The one that was most conspicuously missing. */
export function sellerSale({ listingTitle, amountCents, feeCents, siteUrl, refundDays }) {
  const net = Number(amountCents || 0) - Number(feeCents || 0);
  const text =
`You sold ${listingTitle}.

Sale: ${money(amountCents)}
Platform fee: ${money(feeCents)}
You receive: ${money(net)}

The payout is held until the buyer's ${refundDays}-day refund window closes, then
released automatically. That hold is what lets us promise buyers a refund they
control — it is why they bought.

${siteUrl}/app.html#/dashboard/seller`;

  return {
    subject: `You sold ${listingTitle}`,
    text,
    html: wrap(
      `<p>You sold <strong>${escapeHtml(listingTitle)}</strong>.</p>
       <table style="border-collapse:collapse;margin:12px 0">
         <tr><td style="padding:2px 16px 2px 0;color:#555">Sale</td><td>${money(amountCents)}</td></tr>
         <tr><td style="padding:2px 16px 2px 0;color:#555">Platform fee</td><td>${money(feeCents)}</td></tr>
         <tr><td style="padding:2px 16px 2px 0"><strong>You receive</strong></td><td><strong>${money(net)}</strong></td></tr>
       </table>
       <p style="color:#555">The payout is held until the buyer's ${refundDays}-day refund window
       closes, then released automatically. That hold is what lets us promise buyers a refund they
       control — it is why they bought.</p>
       <p><a href="${siteUrl}/app.html#/dashboard/seller">Your seller dashboard →</a></p>`
    )
  };
}

/** To the buyer, confirming their refund. */
export function buyerRefunded({ listingTitle, amountCents }) {
  const text =
`Your refund for ${listingTitle} is on its way.

${money(amountCents)} is going back to the card you paid with. Depending on your
bank it usually lands within 5-10 days.

You don't need to do anything else.`;

  return {
    subject: `Refunded: ${listingTitle}`,
    text,
    html: wrap(
      `<p>Your refund for <strong>${escapeHtml(listingTitle)}</strong> is on its way.</p>
       <p><strong>${money(amountCents)}</strong> is going back to the card you paid with.
       Depending on your bank it usually lands within 5&ndash;10 days.</p>
       <p style="color:#555">You don't need to do anything else.</p>`
    )
  };
}

/** To the seller, when a buyer refunds. Neutral on purpose — refunds are the product working. */
export function sellerRefunded({ listingTitle, amountCents }) {
  const text =
`A buyer refunded ${listingTitle} (${money(amountCents)}).

The payout for that sale was still being held, so nothing is being taken back
from you — it simply won't be released.

Refunds are part of how this marketplace sells. If several people refund the same
listing, that is worth reading as feedback about the listing rather than about
the buyers.`;

  return {
    subject: `Refunded: ${listingTitle}`,
    text,
    html: wrap(
      `<p>A buyer refunded <strong>${escapeHtml(listingTitle)}</strong> (${money(amountCents)}).</p>
       <p>The payout for that sale was still being held, so nothing is being taken back from
       you — it simply won't be released.</p>
       <p style="color:#555">Refunds are part of how this marketplace sells. If several people
       refund the same listing, that is worth reading as feedback about the listing rather than
       about the buyers.</p>`
    )
  };
}

/** To the seller, when the health checker decides their demo is actually down. */
export function demoBroken({ listingTitle, demoUrl, failures, siteUrl }) {
  const text =
`Your demo for ${listingTitle} isn't responding.

${demoUrl}
Failed ${failures} checks in a row.

Every listing here promises a working demo a buyer can try before paying. That
promise is the product, so a listing whose demo is down stops converting almost
immediately.

Fix it or update the URL: ${siteUrl}/app.html#/dashboard/seller`;

  return {
    subject: `Your demo is down: ${listingTitle}`,
    text,
    html: wrap(
      `<p>Your demo for <strong>${escapeHtml(listingTitle)}</strong> isn't responding.</p>
       <p style="font-family:monospace;font-size:13px;color:#555">${escapeHtml(demoUrl || '')}<br>
       Failed ${failures} checks in a row.</p>
       <p>Every listing here promises a working demo a buyer can try before paying. That promise
       is the product, so a listing whose demo is down stops converting almost immediately.</p>
       <p><a href="${siteUrl}/app.html#/dashboard/seller">Fix it or update the URL →</a></p>`
    )
  };
}

/* Templates interpolate seller-supplied titles into HTML, so the same rule as the
 * rest of the project applies: escape at the point of insertion. An email client
 * is a hostile-enough renderer to be worth it. */
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
