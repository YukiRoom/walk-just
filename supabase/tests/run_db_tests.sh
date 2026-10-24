#!/usr/bin/env bash
# ローカルPostgreSQLで WALK JUST! のDBテストを実行する（本番Supabaseには接続しない）
# 使い方: PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres supabase/tests/run_db_tests.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${WALK_JUST_TEST_DB:-walk_just_test}"
case "$DB" in *test*) ;; *) echo "テスト用DB名には test を含めてください: $DB" >&2; exit 1 ;; esac
psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists \"$DB\"" -c "create database \"$DB\""
run() { psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$1" 2>&1 | grep -v 'NOTICE' || true; }
run supabase/tests/supabase_stub.sql
run supabase/schema.sql
for f in supabase/migrations/*.sql; do run "$f"; done
# 2回目の適用でもエラーにならないこと（冪等性）
for f in supabase/migrations/*.sql; do run "$f"; done
psql -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/walk_just_events.test.sql
