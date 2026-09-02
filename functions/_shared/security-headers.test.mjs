/* Security headers helper.
 *   node functions/_shared/security-headers.test.mjs
 */
import { applySecurityHeaders } from './security-headers.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  if (actual === expected) pass++;
  else { fail++; console.log(`  FAIL  ${name} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function ok(name, cond) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const h = applySecurityHeaders(new Headers());
check('nosniff', h.get('X-Content-Type-Options'), 'nosniff');
check('frame same-origin', h.get('X-Frame-Options'), 'SAMEORIGIN');
check('referrer', h.get('Referrer-Policy'), 'strict-origin-when-cross-origin');
ok('CSP present', /frame-ancestors 'self'/.test(h.get('Content-Security-Policy') || ''));
ok('CSP blocks object', /object-src 'none'/.test(h.get('Content-Security-Policy') || ''));
ok('CSP no * script hosts', !/script-src[^;]*\*/.test(h.get('Content-Security-Policy') || ''));

const embed = applySecurityHeaders(new Headers(), { embeddable: true });
check('embeddable demos are SAMEORIGIN', embed.get('X-Frame-Options'), 'SAMEORIGIN');
const denied = new Headers({ 'X-Frame-Options': 'DENY' });
applySecurityHeaders(denied, { embeddable: true });
check('embeddable overwrites DENY', denied.get('X-Frame-Options'), 'SAMEORIGIN');

const existing = new Headers({ 'X-Frame-Options': 'SAMEORIGIN' });
applySecurityHeaders(existing);
check('does not overwrite existing', existing.get('X-Frame-Options'), 'SAMEORIGIN');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
