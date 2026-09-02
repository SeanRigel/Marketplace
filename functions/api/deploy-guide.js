/* POST /api/deploy-guide  { listing_id, host }
 *   host = cloudflare | vercel | other
 *
 * After a purchase (or for the seller), generate a short deploy walkthrough
 * for the tool they just bought. Cached per listing+host so the second buyer
 * does not pay for another model call. Spend-capped like /api/import-repo.
 *
 * We never ask for or store the buyer's API keys. This is a guide, not a deploy.
 */
import { json, fail, requireEnv, failSetup } from '../_shared/http.js';
import { requireUser, sbAdmin } from '../_shared/supabase.js';

const MODEL = 'claude-opus-5';
const TIMEOUT_MS = 45000;
export const HOSTS = ['cloudflare', 'vercel', 'other'];

const HOST_LABEL = {
  cloudflare: 'Cloudflare Pages',
  vercel: 'Vercel',
  other: 'the buyer\'s own host'
};

const GUIDE_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'Two or three sentences: what they just bought and what "deployed" looks like.'
    },
    accounts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Accounts or services they likely need to create. Empty if none.'
    },
    env_vars: {
      type: 'array',
      items: { type: 'string' },
      description: 'Environment variable names to set, with a short hint each. Empty if none. Never invent fake secret values.'
    },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Numbered-feeling deploy steps for the chosen host, 4 to 10 items. Concrete commands or clicks. Do not invent files the listing does not mention.'
    },
    warnings: {
      type: 'string',
      description: 'What is missing or uncertain. Empty string if the listing was enough.'
    }
  },
  required: ['summary', 'accounts', 'env_vars', 'steps', 'warnings'],
  additionalProperties: false
};

const SYSTEM = `You write a deploy walkthrough for a developer who just bought a working
operational tool on Forkable (a builder-to-builder marketplace). They have the repo.
They picked a host. You explain how to get it running there.

Rules:
- Ground every step in the listing text. If setup instructions are thin, say so in
  warnings and only write steps you can support. Never invent a file, env var, or
  API that is not mentioned.
- Do not ask them to paste API keys into Forkable. Keys stay in their host dashboard
  or a local .dev.vars / .env file.
- No marketing language. Short sentences. Assume they can use a terminal.
- Tailor commands to the chosen host (Cloudflare Pages + wrangler, Vercel, or generic
  static/Node hosting).
- If the tool is mostly static files, say that plainly.
- If the listing is an agent team or trading bot: list the model/exchange API keys
  as env vars on their host, never on Forkable. Prefer paper-trading or sandbox
  endpoints first. Do not invent exchange APIs the listing did not name.`;

export function parseHost(raw) {
  const h = String(raw || '').trim().toLowerCase();
  return HOSTS.includes(h) ? h : null;
}

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
  } catch (e) {
    return failSetup(e);
  }

  const { user, error } = await requireUser(request, env);
  if (error) return fail(error, 401);

  const body = await request.json().catch(() => ({}));
  const listingId = body.listing_id ? String(body.listing_id) : '';
  const host = parseHost(body.host);
  if (!listingId) return fail('listing_id is required.');
  if (!host) return fail('Pick where you will host it: Cloudflare, Vercel, or other.');

  let listing;
  try {
    const rows = await sbAdmin(
      env,
      `/listings?select=id,seller_id,title,short_description,long_description,category,tech_stack_tags,setup_instructions,updated_at,status&id=eq.${encodeURIComponent(listingId)}&limit=1`
    );
    listing = rows?.[0];
  } catch (e) {
    console.error('[deploy-guide] listing', e.message || e);
    return fail("Couldn't load that listing.", 503);
  }
  if (!listing) return fail('Listing not found.', 404);

  const isSeller = listing.seller_id === user.id;
  if (!isSeller) {
    let purchased = false;
    try {
      const buys = await sbAdmin(
        env,
        `/purchases?select=id&listing_id=eq.${encodeURIComponent(listingId)}` +
          `&buyer_id=eq.${encodeURIComponent(user.id)}&status=eq.complete&limit=1`
      );
      purchased = !!(buys && buys.length);
    } catch (e) {
      console.error('[deploy-guide] purchase check', e.message || e);
      return fail("Couldn't verify the purchase.", 503);
    }
    if (!purchased) return fail('Buy this tool first — the walkthrough is for owners.', 403);
  }

  // Cache: free for everyone once one generation exists and the listing hasn't changed.
  try {
    const cached = await sbAdmin(
      env,
      `/deploy_guides?select=guide,listing_updated_at&listing_id=eq.${encodeURIComponent(listingId)}` +
        `&host=eq.${encodeURIComponent(host)}&limit=1`
    );
    const row = cached?.[0];
    if (row && row.listing_updated_at && listing.updated_at
        && new Date(row.listing_updated_at).getTime() >= new Date(listing.updated_at).getTime()) {
      return json({ ok: true, cached: true, host, guide: row.guide });
    }
  } catch (e) {
    console.error('[deploy-guide] cache read', e.message || e);
    // Fall through and generate — a cache miss must not block a paying buyer.
  }

  try {
    const claim = await sbAdmin(env, '/rpc/claim_deploy_guide_quota', {
      method: 'POST',
      body: { p_user: user.id }
    });
    const verdict = Array.isArray(claim) ? claim[0] : claim;
    if (verdict && verdict.allowed === false) {
      if (verdict.reason === 'global') {
        return fail(
          'Deploy walkthroughs have hit the daily limit across the whole site. Try again tomorrow.',
          429
        );
      }
      return fail(
        `You have used all ${verdict.per_user_limit} deploy walkthroughs for today. Try again tomorrow.`,
        429
      );
    }
  } catch (e) {
    console.error('[deploy-guide] quota', e.message || e);
    return fail('Could not verify the daily walkthrough limit. Try again shortly.', 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let guide;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2500,
        system: SYSTEM,
        fallbacks: 'default',
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: GUIDE_SCHEMA }
        },
        messages: [{
          role: 'user',
          content: buildPrompt(listing, host)
        }]
      })
    });

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = payload?.error?.message || `Claude returned ${res.status}`;
      return fail(res.status === 401 || res.status === 403
        ? 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.'
        : msg, 502);
    }
    if (payload.stop_reason === 'refusal') {
      return fail('Claude declined to write a walkthrough for this listing. Use the seller\'s setup notes.', 422);
    }

    const text = (payload.content || []).filter((b) => b.type === 'text')
      .map((b) => b.text).join('');
    if (!text) return fail('Claude returned an empty walkthrough. Try again.', 502);
    try {
      guide = JSON.parse(text);
    } catch {
      return fail('Could not read the walkthrough Claude returned.', 502);
    }
    guide = sanitizeGuide(guide);
  } catch (e) {
    return fail(e.name === 'AbortError'
      ? 'Claude took too long. Try again, or follow the seller\'s setup notes.'
      : ('Walkthrough failed: ' + e.message), 502);
  } finally {
    clearTimeout(timer);
  }

  try {
    await sbAdmin(env, '/deploy_guides?on_conflict=listing_id,host', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: {
        listing_id: listingId,
        host,
        listing_updated_at: listing.updated_at,
        guide
      }
    });
  } catch (e) {
    console.error('[deploy-guide] cache write', e.message || e);
  }

  return json({ ok: true, cached: false, host, guide });
}

export function buildPrompt(listing, host) {
  const tags = Array.isArray(listing.tech_stack_tags)
    ? listing.tech_stack_tags.join(', ')
    : '';
  return (
    `Host the buyer chose: ${HOST_LABEL[host] || host}\n` +
    `Title: ${listing.title || ''}\n` +
    `Category: ${listing.category || ''}\n` +
    (tags ? `Stack: ${tags}\n` : '') +
    (listing.short_description ? `Short: ${listing.short_description}\n` : '') +
    (listing.long_description ? `\n--- description ---\n${listing.long_description}\n` : '') +
    (listing.setup_instructions
      ? `\n--- seller setup notes ---\n${listing.setup_instructions}\n`
      : '\n(The seller did not write setup notes.)\n')
  );
}

export function sanitizeGuide(raw) {
  const arr = (v) => Array.isArray(v)
    ? v.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    summary: String(raw.summary || '').trim().slice(0, 800),
    accounts: arr(raw.accounts),
    env_vars: arr(raw.env_vars),
    steps: arr(raw.steps),
    warnings: String(raw.warnings || '').trim().slice(0, 800)
  };
}
