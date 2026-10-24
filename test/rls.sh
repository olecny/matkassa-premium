#!/usr/bin/env bash
# RLS test: runs the Supabase migrations on a throwaway local Postgres (with a small Supabase stand-in for auth.uid(),
# roles and Vault) and checks that users only ever reach their own rows. Needs PostgreSQL 15+ binaries
# (e.g. `brew install postgresql@17`); skips with a note if they are missing. Nothing leaves this machine.
set -euo pipefail
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
cd "$(dirname "$0")/.."
PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  for d in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@17/bin; do
    [ -x "$d/initdb" ] && PGBIN="$d" && break
  done
  [ -z "$PGBIN" ] && command -v initdb >/dev/null && PGBIN="$(dirname "$(command -v initdb)")"
fi
if [ -z "$PGBIN" ]; then echo "SKIP rls: no PostgreSQL binaries (RLS untested here)"; exit 0; fi

TMP="$(mktemp -d /tmp/mk-rls.XXXXXX)"
PORT=$((54000 + RANDOM % 900))
cleanup() { "$PGBIN/pg_ctl" -D "$TMP/db" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$TMP/db" -U postgres -A trust --locale=C -E UTF8 >/dev/null
"$PGBIN/pg_ctl" -D "$TMP/db" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/log" -w start >/dev/null || { cat "$TMP/log"; exit 1; }
PSQL=("$PGBIN/psql" -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -f supabase/tests/stub_supabase.sql >/dev/null
for f in supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f" >/dev/null 2>&1 || { echo "FAIL migration $f"; "${PSQL[@]}" -f "$f"; exit 1; }; done
for f in supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f" >/dev/null 2>&1 || { echo "FAIL migration $f is not re-runnable"; exit 1; }; done
echo "PASS migrations apply cleanly and can be re-run"
"${PSQL[@]}" -f supabase/tests/after_migrations.sql >/dev/null
out="$("${PSQL[@]}" -f supabase/tests/rls_test.sql 2>&1)" || { echo "$out" | sed 's/^psql:[^ ]* //'; echo "FAIL rls"; exit 1; }
echo "$out" | sed -n 's/.*NOTICE:  //p'
echo "All RLS tests passed"
