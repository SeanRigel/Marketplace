/* GET /api/feed        -> JSON Feed 1.1 of live listings
 * GET /api/feed?fmt=rss -> the same as RSS 2.0
 *
 * The audience is developers, and developers still read feeds. This also gives the
 * catalog a surface that other sites, bots, and newsletters can consume without
 * scraping a hash-routed SPA.
 *
 * Public and read-only: it returns exactly what /browse already shows anonymously.
 * It goes through the anon key rather than service_role, so RLS is the thing
 * deciding what's public — not a hand-maintained column list that could drift.
 */
import { fail, requireEnv, failSetup } from '../_shared/http.js';

const LIMIT = 50;

export async function onRequestGet({ request, env }) {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  } catch (e) {
    return failSetup(e);
  }

  const site = (env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const wantsRss = new URL(request.url).searchParams.get('fmt') === 'rss';

  let rows;
  try {
    const res = await fetch(
      `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/listings_with_seller` +
      `?select=id,title,short_description,price_cents,category,tech_stack_tags,seller_name,created_at` +
      `&status=eq.live&order=created_at.desc&limit=${LIMIT}`,
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    rows = await res.json();
  } catch (e) {
    return fail(`Could not load listings: ${e.message}`, 502);
  }

  const price = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
  const link = (id) => `${site}/app.html#/listing/${id}`;

  const headers = {
    'Cache-Control': 'public, max-age=600',
    'Access-Control-Allow-Origin': '*'
  };

  if (wantsRss) {
    const esc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

    const items = rows.map((l) => `    <item>
      <title>${esc(l.title)} — ${esc(price(l.price_cents))}</title>
      <link>${esc(link(l.id))}</link>
      <guid isPermaLink="false">${esc(l.id)}</guid>
      <pubDate>${new Date(l.created_at).toUTCString()}</pubDate>
      <description>${esc(l.short_description)}</description>
      <category>${esc(l.category)}</category>
    </item>`).join('\n');

    return new Response(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Forkable — new tools</title>
    <link>${esc(site)}</link>
    <description>Working operational tools for builders. Every listing has a live demo.</description>
${items}
  </channel>
</rss>`, { headers: { ...headers, 'Content-Type': 'application/rss+xml; charset=utf-8' } });
  }

  return new Response(JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Forkable — new tools',
    home_page_url: site,
    feed_url: `${site}/api/feed`,
    description: 'Working operational tools for builders. Every listing has a live demo.',
    items: rows.map((l) => ({
      id: l.id,
      url: link(l.id),
      title: `${l.title} — ${price(l.price_cents)}`,
      content_text: l.short_description,
      date_published: l.created_at,
      authors: l.seller_name ? [{ name: l.seller_name }] : undefined,
      tags: [l.category, ...(l.tech_stack_tags || [])]
    }))
  }, null, 2), { headers: { ...headers, 'Content-Type': 'application/feed+json; charset=utf-8' } });
}
