#!/bin/bash
# Privacy check for the PUBLIC repo: no personal data, tokens or real receipts in tracked files or history.
# Usage: test/privacy.sh   (read-only; prints PASS/FAIL, exit 1 on any FAIL)
cd "$(dirname "$0")/.." || exit 1
fail=0
pass() { echo "PASS $1"; }
bad() { echo "FAIL $1"; [ -n "${2:-}" ] && echo "$2" | head -5 | sed 's/^/     /'; fail=1; }

# 1. Only app code, docs and FAKE fixtures are tracked.
odd="$(git ls-files | grep -vE '^(index\.html|styles\.css|sw\.js|manifest\.webmanifest|README\.md|plan\.md|\.gitignore|js/[a-z-]+\.js|icons/.*|ingest/(rema\.py|sync\.sh|README\.md|\.env\.example|launchd/(install|uninstall|run-sync)\.sh|launchd/matkassa-weekly-sync\.plist\.template)|test/(unit\.test\.mjs|e2e\.mjs|privacy\.sh|fake/[a-z-]+-FAKE\.json))$')"
[ -z "$odd" ] && pass "git ls-files: only app code, docs and FAKE fixtures" || bad "unexpected tracked files" "$odd"

# 2. Nothing sensitive is tracked, even if git-ignore rules change later.
for f in '^data/' '^ingest/\.env$' '^ingest/logs/' 'spending[^/]*\.json$' '^innsyn/' '^screenshots/' '^test/tmp/' '^test/fixtures/'; do
  git ls-files | grep -v -- '-FAKE\.json$' | grep -qE "$f" && bad "tracked: $f"
done
[ $fail = 0 ] && pass "data/, .env, spending*.json, screenshots, test/tmp not tracked"

# 3. No token-looking strings in tracked files or anywhere in history.
pat='github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|"refresh_token"\s*:\s*"[^"]{20,}|AMf-v[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{10,}'
hits="$(git grep -nIE "$pat" -- . ':!test/privacy.sh')"
[ -z "$hits" ] && pass "git grep: no tokens in tracked files" || bad "token-like strings in tracked files" "$hits"
hist="$(git log -p --all | grep -cE "$pat")"
[ "$hist" = 0 ] && pass "git history: no tokens" || bad "token-like strings in history ($hist lines)"

# 4. No Norwegian phone numbers, e-mail addresses or real EANs in tracked files (fake EANs use 2xx).
phones="$(git grep -nIE '(\+47 ?)?[49][0-9]{2} ?[0-9]{2} ?[0-9]{3}\b' -- '*.json' '*.md' '*.html' | grep -v 'FAKE' | grep -vE '\b(7[0-9]{12})\b' | head -5)"
[ -z "$phones" ] && pass "no phone-number-like strings in data/docs" || bad "phone-number-like strings" "$phones"
mails="$(git grep -nIE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}' -- . ':!*.png' | grep -vE 'noreply@anthropic\.com|users\.noreply\.github\.com' | head -5)"
[ -z "$mails" ] && pass "no e-mail addresses" || bad "e-mail addresses in tracked files" "$mails"
eans="$(git grep -nIhoE '"ean[s]?"\s*:\s*\[?\s*"[0-9]{8,14}"' -- test/fake | grep -vE '"2[0-9]{7,13}"' | head -5)"
[ -z "$eans" ] && pass "fixtures only use fake 2xx EANs" || bad "real-looking EANs in fixtures" "$eans"

# 5. No hard-wired personal defaults in shipped code.
own="$(git grep -nIi 'olecny\|/Users/' -- js sw.js index.html ingest/sync.sh ingest/rema.py ingest/launchd)"
[ -z "$own" ] && pass "no personal repo/user hard-wired in shipped code" || bad "personal defaults in code" "$own"

exit $fail
