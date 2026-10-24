#!/usr/bin/env bash
# setup-local.sh で起動したプロセスを止める
OUT="${E2E_OUT:-/tmp/walk-just-e2e}"
for name in preview local-supabase postgrest; do
  [ -f "$OUT/$name.pid" ] && kill "$(cat "$OUT/$name.pid")" 2>/dev/null; rm -f "$OUT/$name.pid"
done
exit 0
