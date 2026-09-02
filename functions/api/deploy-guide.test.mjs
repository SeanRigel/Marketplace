/* Deploy-guide host parsing and sanitising.
 *   node functions/api/deploy-guide.test.mjs
 */
import { parseHost, sanitizeGuide, buildPrompt, HOSTS } from './deploy-guide.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else { fail++; console.log(`  FAIL  ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${name}`); }
}

check('cloudflare', parseHost('cloudflare'), 'cloudflare');
check('Vercel case', parseHost('Vercel'), 'vercel');
check('other', parseHost('other'), 'other');
check('reject empty', parseHost(''), null);
check('reject aws', parseHost('aws'), null);
ok('three hosts', HOSTS.length === 3);

const g = sanitizeGuide({
  summary: '  Run it.  ',
  accounts: ['Supabase', '', 12],
  env_vars: ['ANTHROPIC_API_KEY — from console'],
  steps: ['Clone the repo', 'Set env vars'],
  warnings: 'No Dockerfile mentioned.'
});
check('summary trimmed', g.summary, 'Run it.');
ok('drops empty accounts', g.accounts.length === 1 && g.accounts[0] === 'Supabase');
ok('keeps steps', g.steps.length === 2);
ok('warnings kept', g.warnings.indexOf('Dockerfile') >= 0);

const prompt = buildPrompt({
  title: 'Shift Scheduler',
  category: 'scheduling',
  tech_stack_tags: ['Vanilla JS'],
  short_description: 'Paste the group chat.',
  setup_instructions: 'Deploy to any static host.'
}, 'cloudflare');
ok('prompt names host', /Cloudflare Pages/.test(prompt));
ok('prompt includes title', /Shift Scheduler/.test(prompt));
ok('prompt includes seller notes', /static host/.test(prompt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
