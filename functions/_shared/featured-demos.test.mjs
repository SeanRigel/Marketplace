/* Featured demo allowlist + first-party path checks.
 *   node functions/_shared/featured-demos.test.mjs
 */
import {
  FEATURED_DEMOS,
  featuredDemoKey,
  resolveFeaturedPath,
  isFirstPartyDemoPath,
  firstPartyDemoPath
} from './featured-demos.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  if (actual === expected) { pass++; }
  else { fail++; console.log(`  FAIL  ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

check('three featured demos', Object.keys(FEATURED_DEMOS).length, 3);
check('guard path', resolveFeaturedPath('guard-scheduler'), '/demos/guard-scheduler/index.html');
check('unknown featured', resolveFeaturedPath('nope'), null);
check('demo key shape', featuredDemoKey('lead-scout'), 'featured:lead-scout');

check('relative demos/ ok', isFirstPartyDemoPath('demos/guard-scheduler/index.html'), true);
check('rooted /demos/ ok', isFirstPartyDemoPath('/demos/lead-scout/'), true);
check('traversal blocked', isFirstPartyDemoPath('demos/../app.html'), false);
check('rooted traversal blocked', isFirstPartyDemoPath('/demos/../../etc/passwd'), false);
check('other path blocked', isFirstPartyDemoPath('/app.html'), false);
check('external url not first-party', isFirstPartyDemoPath('https://evil.example/demos/x'), false);

check('normalize relative', firstPartyDemoPath('demos/reconsole/index.html'), '/demos/reconsole/index.html');
check('normalize absolute path', firstPartyDemoPath('/demos/reconsole/index.html'), '/demos/reconsole/index.html');
check('normalize rejects traversal', firstPartyDemoPath('demos/../secrets'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
