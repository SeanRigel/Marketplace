/* POST /api/import-repo  { repo_url } -> a draft listing
 *
 * Paste a GitHub URL, get a filled-in listing. Writing a listing by hand is
 * fifteen minutes of typing, and supply-side friction is what kills marketplaces
 * — this turns it into about a minute of editing.
 *
 * Private repos are the point of selling: the demo is public, the code is not.
 * The seller may send a GitHub token in this one request so we can read the
 * README. We never write that token to a database, a log, or the draft.
 *
 * Uses raw fetch rather than the Anthropic SDK for the same reason as Stripe:
 * the SDK needs a bundler and this project has no build step.
 */
import { json, fail, requireEnv, failSetup } from '../_shared/http.js';
import { requireUser, sbAdmin } from '../_shared/supabase.js';

const MODEL = 'claude-opus-5';
const MAX_README_CHARS = 24000;   // ~6k tokens; plenty for a README
const TIMEOUT_MS = 45000;

/* Structured outputs: the response is constrained to this schema, so there is no
 * "sometimes it wraps the JSON in prose" failure mode to parse around. Note the
 * schema restrictions — no minLength/maxLength, additionalProperties must be
 * false, every property required. */
const LISTING_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Product-style name, under 60 characters. Not the bare repo slug.' },
    short_description: { type: 'string', description: 'One sentence a buyer skims in a grid. Under 140 characters.' },
    long_description: { type: 'string', description: 'Two or three short paragraphs: what it does, who it is for, why buying beats rebuilding.' },
    category: {
      type: 'string',
      enum: ['ai_agents', 'trading_bots', 'scheduling', 'dashboard', 'intake_form', 'payroll', 'ai_integration', 'other'],
      description: 'Best fit. Use ai_agents for multi-agent crews, trading_bots for crypto/stock bots. Use "other" rather than forcing a bad match.'
    },
    tech_stack_tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Between 2 and 6 concrete technologies, e.g. "React", "Supabase", "Stripe".'
    },
    setup_instructions: {
      type: 'string',
      description: 'Markdown. Numbered deploy steps, env vars to set, accounts needed. Only steps the README actually supports — never invent one.'
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How well the README supported this draft. "low" when the README was thin and much was inferred.'
    },
    notes: {
      type: 'string',
      description: 'What a human should check before publishing. Empty string if nothing.'
    }
  },
  required: ['title', 'short_description', 'long_description', 'category',
             'tech_stack_tags', 'setup_instructions', 'confidence', 'notes'],
  additionalProperties: false
};

const SYSTEM = `You write marketplace listings for a builder-to-builder marketplace where
developers sell working operational tools to other developers.

You are given a repository's README and manifest. Draft the listing fields from them.

The buyer is a technical person deciding whether this saves them a weekend. Write for
that reader: concrete about what the tool does and what it's built on, no marketing
adjectives, no "revolutionary" or "seamless". Prefer the specific over the general —
"parses group-chat messages into shift constraints" beats "smart scheduling".

Ground every claim in the source material. If the README doesn't say how to deploy it,
write the setup steps you can actually support and say what's missing in notes rather
than inventing plausible-sounding ones. Set confidence to "low" when you had to infer
a lot; the seller is going to edit this and needs to know where to look.`;

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env, ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  } catch (e) {
    return failSetup(e);
  }

  // Signed-in only: this endpoint spends money on every call.
  const { user, error } = await requireUser(request, env);
  if (error) return fail(error, 401);

  const body = await request.json().catch(() => ({}));
  const repo = parseRepoUrl(body.repo_url || '');
  if (!repo) return fail('That does not look like a GitHub repository URL.', 400);

  let token = null;
  if (body.github_token) {
    token = parseGithubToken(body.github_token);
    if (!token) {
      return fail(
        'That does not look like a GitHub token. Create one at GitHub → Settings → Developer settings → Personal access tokens. We use it once and never save it.',
        400
      );
    }
  }

  let source;
  try {
    source = await fetchRepoContext(repo, token);
  } catch (e) {
    return fail(e.message, 502);
  }
  if (!source.readme) {
    return fail('That repository has no README we can read, so there is nothing to draft from.', 422);
  }

  // Spend cap AFTER GitHub succeeds. A bad token or private-repo miss must not
  // burn a Claude slot — that call is the one that costs money.
  //
  // "Requires a signed-in user" is not a spend limit when signup is free: one
  // account can loop this, and several accounts can each sit politely under a
  // per-user cap. claim_import_quota enforces a per-user and a global daily
  // ceiling in one atomic statement, so firing many requests at once cannot
  // race past it. See supabase/import_quota.sql.
  try {
    const claim = await sbAdmin(env, '/rpc/claim_import_quota', {
      method: 'POST',
      body: { p_user: user.id }
    });
    const verdict = Array.isArray(claim) ? claim[0] : claim;

    if (verdict && verdict.allowed === false) {
      if (verdict.reason === 'global') {
        return fail(
          'Auto-drafting has hit its daily limit across the whole site. ' +
          'Try again tomorrow, or fill the listing in by hand.', 429);
      }
      return fail(
        `You have used all ${verdict.per_user_limit} auto-drafts for today. ` +
        'Fill this one in by hand, or try again tomorrow.', 429);
    }
  } catch (e) {
    // If the cap cannot be evaluated, refuse. The alternative is to fail open on
    // the one route that spends real money, which is how a key gets drained.
    console.error('[import-repo] quota check failed: ' + (e && e.message ? e.message : e));
    return fail('Could not verify your daily draft limit. Try again shortly.', 503);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        // Opus 5 safety classifiers can decline a request; this re-runs a decline
        // on Anthropic's recommended fallback instead of handing us a refusal.
        'anthropic-beta': 'server-side-fallback-2026-07-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: SYSTEM,
        fallbacks: 'default',
        // Drafting from a README is not a reasoning-heavy task; low effort keeps
        // it fast and cheap. Structured output removes all response parsing.
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: LISTING_SCHEMA }
        },
        messages: [{
          role: 'user',
          content:
            `Repository: ${repo.owner}/${repo.name}\n` +
            (source.description ? `GitHub description: ${source.description}\n` : '') +
            (source.topics.length ? `GitHub topics: ${source.topics.join(', ')}\n` : '') +
            (source.language ? `Primary language: ${source.language}\n` : '') +
            (source.manifest ? `\n--- manifest ---\n${source.manifest}\n` : '') +
            `\n--- README ---\n${source.readme}`
        }]
      })
    });

    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = payload?.error?.message || `Claude returned ${res.status}`;
      // 401/403 here means the key is wrong — say so plainly rather than
      // surfacing it as a generic upstream failure.
      return fail(res.status === 401 || res.status === 403
        ? 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.'
        : msg, 502);
    }

    // Always check stop_reason before reading content — a refusal returns HTTP 200
    // with empty or partial content, and indexing content[0] would throw.
    if (payload.stop_reason === 'refusal') {
      return fail('Claude declined to draft from that repository. Fill the listing in by hand.', 422);
    }

    var text = (payload.content || []).filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; }).join('');
    if (!text) return fail('Claude returned an empty draft. Try again.', 502);

    let draft;
    try {
      draft = JSON.parse(text);
    } catch {
      return fail('Could not read the draft Claude returned.', 502);
    }

    return json({
      draft: {
        title: draft.title,
        short_description: draft.short_description,
        long_description: draft.long_description,
        category: draft.category,
        tech_stack_tags: draft.tech_stack_tags,
        setup_instructions: draft.setup_instructions,
        repo_url: `https://github.com/${repo.owner}/${repo.name}`
      },
      confidence: draft.confidence,
      notes: draft.notes,
      // Surfaced so the seller sees what a draft costs, and so it's greppable in
      // logs if the bill ever looks wrong.
      usage: {
        input_tokens: payload.usage?.input_tokens,
        output_tokens: payload.usage?.output_tokens
      }
    });
  } catch (e) {
    return fail(e.name === 'AbortError'
      ? 'Claude took too long. Try again, or fill the listing in by hand.'
      : `Draft failed: ${e.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/* Accepts the forms people actually paste. Returns null for anything that
   isn't a GitHub repo — including other hosts. */
export function parseRepoUrl(raw) {
  const s = String(raw).trim().replace(/\.git$/, '');

  // new URL() silently collapses ".." segments, so "github.com/../../etc/passwd"
  // would resolve to owner "etc", repo "passwd" — a different repo than anything
  // the user typed. Reject rather than reinterpret.
  if (/(^|\/)\.\.(\/|$)/.test(s)) return null;

  let u;
  try {
    u = new URL(s.startsWith('http') ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;

  const owner = parts[0];
  const name = parts[1];
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return { owner, name };
}

/* Classic (ghp_) or fine-grained (github_pat_) personal access tokens.
 * Reject anything else so we never send a random secret to GitHub. */
export function parseGithubToken(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/^\uFEFF/, '').trim();
  s = s.replace(/^(Bearer|token)\s+/i, '');
  s = s.replace(/\s+/g, '');
  if (!s) return null;
  if (s.length < 20 || s.length > 400) return null;
  if (!/^(ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_.=+-]+$/.test(s)) return null;
  return s;
}

function githubHeaders(token, scheme) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Forkable-Importer/1.0',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = (scheme === 'token' ? 'token ' : 'Bearer ') + token;
  return headers;
}

async function githubRepoMeta(repo, token) {
  const url = `https://api.github.com/repos/${repo.owner}/${repo.name}`;
  const schemes = token ? ['Bearer', 'token'] : [null];
  let last = null;
  for (const scheme of schemes) {
    const res = await fetch(url, { headers: githubHeaders(token, scheme) });
    last = { res, scheme };
    if (res.ok) return last;
    // 401/404: this scheme didn't count as access. Try the other before giving up.
    if (token && (res.status === 401 || res.status === 404) && scheme === 'Bearer') continue;
    return last;
  }
  return last;
}

async function fetchRepoContext(repo, token) {
  // Never log Authorization. A private repo without a working token looks like 404.
  const { res: meta, scheme } = await githubRepoMeta(repo, token);
  if (meta.status === 401) {
    throw new Error('That GitHub token was rejected. Check it and try again. We did not save it.');
  }
  if (meta.status === 404) {
    throw new Error(token
      ? 'GitHub still cannot see that private repo with this token. On the token: Repository access must include this repo, and Contents must be Read-only. If the repo is under an organization, click Enable SSO on the token. The URL must be github.com/owner/repo.'
      : 'That repository is private or missing. Paste a GitHub token — we read the README once and never save the token.');
  }
  if (meta.status === 403) {
    const body = await meta.json().catch(() => ({}));
    const msg = String(body.message || '');
    if (/SSO|organization/i.test(msg)) {
      throw new Error('This token needs SSO authorization for the organization. Open GitHub → the token → Authorize (SSO), then try again.');
    }
    throw new Error('GitHub refused the request (rate limit or permissions). Wait a few minutes, or give the token Contents: Read on that repo.');
  }
  if (!meta.ok) throw new Error(`GitHub returned ${meta.status}.`);
  const info = await meta.json();

  const readmeRes = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/readme`,
    { headers: { ...githubHeaders(token, scheme || 'Bearer'), Accept: 'application/vnd.github.raw' } }
  );
  const readme = readmeRes.ok ? (await readmeRes.text()).slice(0, MAX_README_CHARS) : '';

  return {
    readme,
    description: info.description || '',
    topics: Array.isArray(info.topics) ? info.topics.slice(0, 12) : [],
    language: info.language || '',
    manifest: ''
  };
}
