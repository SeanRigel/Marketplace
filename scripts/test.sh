#!/usr/bin/env bash
# Everything that can be checked without a Supabase project or Stripe account.
#   ./scripts/test.sh
#
# Deliberately not a package.json script: adding one at the repo root can make
# Cloudflare Pages think this project needs a build step. It does not.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
run() {
  printf '\n\033[1m%s\033[0m\n' "$1"
  shift
  if "$@"; then :; else fail=1; fi
}

run "Webhook signatures + Stripe form encoding" node functions/_shared/stripe.test.mjs
run "SSRF host filter" node functions/api/check-demo.test.mjs
run "SSRF address parsing + redirect re-vetting" node functions/_shared/net-safety.test.mjs
run "GitHub URL parsing" node functions/api/import-repo.test.mjs
run "Seller URL safety (scheme + iframe origin)" node app/url-safety.test.mjs
run "Local-mode access rules (RLS parity)" node app/local-rules.test.mjs

printf '\n\033[1mSyntax\033[0m\n'
tmp=$(mktemp -d)
for f in $(find functions scripts app -name '*.js' -o -name '*.mjs' | grep -v '\.test\.'); do
  t="$tmp/$(echo "$f" | tr '/' '_' | sed 's/\.js$/.mjs/')"
  cp "$f" "$t"
  if node --check "$t" >/dev/null 2>&1; then
    echo "  PASS  $f"
  else
    echo "  FAIL  $f"; node --check "$t" 2>&1 | head -5; fail=1
  fi
done

# The landing page carries real logic inline; check it too.
node -e '
const fs=require("fs");
const h=fs.readFileSync("index.html","utf8");
const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).join("\n;\n");
fs.writeFileSync(process.argv[1]+"/index_inline.mjs",m);
' "$tmp"
if node --check "$tmp/index_inline.mjs" >/dev/null 2>&1; then
  echo "  PASS  index.html (inline)"
else
  echo "  FAIL  index.html (inline)"; node --check "$tmp/index_inline.mjs" 2>&1 | head -5; fail=1
fi
rm -rf "$tmp"

if [ $fail -eq 0 ]; then
  printf '\n\033[32mAll checks passed.\033[0m\n'
  printf 'Next: node scripts/preflight.mjs (needs a real .dev.vars)\n'
else
  printf '\n\033[31mSomething failed above.\033[0m\n'
fi
exit $fail
