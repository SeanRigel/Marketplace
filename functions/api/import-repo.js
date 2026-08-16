/* POST /api/import-repo  { repo_url } -> a draft listing
 *
 * Paste a GitHub URL, get a filled-in listing. Writing a listing by hand is
 * fifteen minutes of typing, and supply-side friction is what kills marketplaces
 * — this turns it into about a minute of editing.
 *
 * Reads the repo's README and package manifest through GitHub's public API, then
 * asks Claude to draft the listing fields. The seller edits and saves; nothing is
 * published automatically, and the model never sees anything the public can't.
 *
 * Uses raw fetch rather than the Anthropic SDK for the same reason as Stripe:
 * the SDK needs a bundler and this project has no build step.
 */
import { json, fail, requireEnv, failSetup } from '../_shared/http.js';
import { requireUser } from '../_shared/supabase.js';

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
      enum: ['scheduling', 'dashboard', 'intake_form', 'payroll', 'ai_integration', 'other'],
      description: 'Best fit. Use "other" rather than forcing a bad match.'
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
  const { error } = await requireUser(request, env);
  if (error) return fail(error, 401);

  const body = await request.json().catch(() => ({}));
  const repo = parseRepoUrl(body.repo_url || '');
  if (!repo) return fail('That does not look like a GitHub repository URL.', 400);

  let source;
  try {
    source = await fetchRepoContext(repo);
  } catch (e) {
    return fail(e.message, 502);
  }
  if (!source.readme) {
    return fail('That repository has no README we can read, so there is nothing to draft from.', 422);
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

async function fetchRepoContext(repo) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Forkable-Importer/1.0'
  };

  // Unauthenticated GitHub API: 60 requests/hour per IP. Two calls per import,
  // so ~30 imports an hour across all users before it starts 403ing.
  const meta = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`, { headers });
  if (meta.status === 404) throw new Error('That repository does not exist, or it is private.');
  if (meta.status === 403) throw new Error('GitHub rate-limited us. Wait a few minutes and try again.');
  if (!meta.ok) throw new Error(`GitHub returned ${meta.status}.`);
  const info = await meta.json();

  const readmeRes = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/readme`,
    { headers: { ...headers, Accept: 'application/vnd.github.raw' } }
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
