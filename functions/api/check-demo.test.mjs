/* SSRF host filter for /api/check-demo.
 *
 * This endpoint makes the server fetch a URL the caller chose. The filter is the
 * only thing stopping a signed-in seller from using the worker to probe addresses
 * that aren't the public internet, so it gets tested rather than eyeballed.
 *
 *   node functions/api/check-demo.test.mjs
 */
import { isPrivateHost } from './check-demo.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  if (actual === expected) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} — got ${actual}, expected ${expected}`); }
};

console.log('\nMust be BLOCKED:');
for (const h of [
  'localhost', 'LOCALHOST', 'app.localhost',
  '127.0.0.1', '127.1.2.3', '0.0.0.0',
  '10.0.0.1', '10.255.255.255',
  '192.168.1.1', '192.168.0.254',
  '172.16.0.1', '172.20.10.5', '172.31.255.255',
  '169.254.169.254',                       // cloud instance metadata
  'metadata.google.internal',
  'db.internal', 'printer.local',
  '::1', '[::1]', '::',
  'fc00::1', 'fd12:3456::1', 'fe80::1'
]) check(h, isPrivateHost(h), true);

console.log('\nMust be ALLOWED:');
for (const h of [
  'example.com', 'demo.pages.dev', 'my-app.vercel.app',
  '8.8.8.8', '1.1.1.1',
  '172.32.0.1',        // just outside the 172.16/12 private range
  '172.15.255.255',    // just below it
  '11.0.0.1',          // adjacent to 10/8 but public
  '192.169.0.1',       // adjacent to 192.168/16 but public
  '169.253.0.1',       // adjacent to link-local but public
  'internal-tools.example.com',   // "internal" in the label, not the TLD
  '2606:4700::1111'    // public IPv6
]) check(h, isPrivateHost(h), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
