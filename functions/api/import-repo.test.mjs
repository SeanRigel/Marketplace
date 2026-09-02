/* GitHub URL parsing for /api/import-repo.
 *
 * This is the gate that decides which host the server will fetch on a caller's
 * behalf. Anything that isn't a github.com repo path must be rejected, so it gets
 * tested rather than eyeballed.
 *
 *   node functions/api/import-repo.test.mjs
 */
import { parseRepoUrl, parseGithubToken } from './import-repo.js';

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
};

const REPO = { owner: 'rigel', name: 'lead-scout' };

console.log('\nForms people actually paste:');
eq('https URL',            parseRepoUrl('https://github.com/rigel/lead-scout'), REPO);
eq('http URL',             parseRepoUrl('http://github.com/rigel/lead-scout'), REPO);
eq('no protocol',          parseRepoUrl('github.com/rigel/lead-scout'), REPO);
eq('www subdomain',        parseRepoUrl('https://www.github.com/rigel/lead-scout'), REPO);
eq('trailing slash',       parseRepoUrl('https://github.com/rigel/lead-scout/'), REPO);
eq('.git suffix',          parseRepoUrl('https://github.com/rigel/lead-scout.git'), REPO);
eq('deep link (tree)',     parseRepoUrl('https://github.com/rigel/lead-scout/tree/main/src'), REPO);
eq('surrounding spaces',   parseRepoUrl('  https://github.com/rigel/lead-scout  '), REPO);
eq('query string',         parseRepoUrl('https://github.com/rigel/lead-scout?tab=readme'), REPO);
eq('dots in repo name',    parseRepoUrl('https://github.com/rigel/my.tool'), { owner: 'rigel', name: 'my.tool' });

console.log('\nMust be rejected:');
for (const [name, input] of [
  ['another host',         'https://gitlab.com/rigel/lead-scout'],
  ['lookalike host',       'https://github.com.evil.tld/rigel/lead-scout'],
  ['github subdomain',     'https://gist.github.com/rigel/abc123'],
  ['owner only',           'https://github.com/rigel'],
  ['bare domain',          'https://github.com'],
  ['file protocol',        'file:///etc/passwd'],
  ['loopback',             'http://127.0.0.1/rigel/lead-scout'],
  ['empty string',         ''],
  ['not a URL',            'just some words'],
  ['path traversal',       'https://github.com/../../etc/passwd'],
]) eq(name, parseRepoUrl(input), null);

console.log('\nGitHub tokens (shape only — never a real key):');
eq('classic prefix', parseGithubToken('ghp_' + 'a'.repeat(36)) ? 'ok' : null, 'ok');
eq('fine-grained prefix', parseGithubToken('github_pat_' + 'a'.repeat(40)) ? 'ok' : null, 'ok');
eq('empty is optional', parseGithubToken(''), null);
eq('strips Bearer prefix', parseGithubToken('Bearer ghp_' + 'b'.repeat(36)) ? 'ok' : null, 'ok');
eq('strips whitespace', parseGithubToken('  ghp_' + 'c'.repeat(36) + '  ') ? 'ok' : null, 'ok');
eq('whitespace only', parseGithubToken('   '), null);
eq('random string', parseGithubToken('sk-ant-not-github'), null);
eq('too short', parseGithubToken('ghp_short'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
