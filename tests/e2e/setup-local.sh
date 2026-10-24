#!/usr/bin/env bash
# ローカルE2E環境を起動する（本番Supabaseには一切接続しない）
#   PostgreSQL（起動済み）に e2e 用DBを作成 → stub / schema / migrations を適用 → テスト用管理者を登録
#   PostgREST と local-supabase.mjs を起動し、アプリを e2e 用設定でビルドして preview する
# 必要なもの: psql, postgrest（PATH または POSTGREST_BIN）, node, npm
set -euo pipefail
cd "$(dirname "$0")/../.."
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-54329}" PGUSER="${PGUSER:-postgres}"
DB="${PGDATABASE:-walk_just_e2e_test}"
export PGDATABASE="$DB"
JWT_SECRET="${JWT_SECRET:-local-e2e-secret-local-e2e-secret-0123456789}"
OUT="${E2E_OUT:-/tmp/walk-just-e2e}"
mkdir -p "$OUT"

psql -q -d postgres -c "drop database if exists \"$DB\"" -c "create database \"$DB\""
for f in supabase/tests/supabase_stub.sql supabase/schema.sql supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1 | grep -v NOTICE || true
done
psql -q -v ON_ERROR_STOP=1 -d "$DB" <<'SQL'
insert into auth.users (id, email, is_anonymous) values
  ('a0000000-0000-4000-8000-0000000000a1', 'admin@example.com', false),
  ('a0000000-0000-4000-8000-0000000000a2', 'member@example.com', false);
insert into public.walk_just_admins (user_id, note) values ('a0000000-0000-4000-8000-0000000000a1', 'e2e admin');
SQL

cat > "$OUT/postgrest.conf" <<CONF
db-uri = "postgres://authenticator:authenticator@${PGHOST}:${PGPORT}/${DB}"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "${JWT_SECRET}"
server-host = "127.0.0.1"
server-port = 54322
CONF
"${POSTGREST_BIN:-postgrest}" "$OUT/postgrest.conf" > "$OUT/postgrest.log" 2>&1 &
echo $! > "$OUT/postgrest.pid"
JWT_SECRET="$JWT_SECRET" node tests/e2e/local-supabase.mjs > "$OUT/local-supabase.log" 2>&1 &
echo $! > "$OUT/local-supabase.pid"

ANON_KEY=$(JWT_SECRET="$JWT_SECRET" node -e "import('./tests/e2e/local-supabase-jwt.mjs').then(m => console.log(m.anonKey()))")
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY="$ANON_KEY" \
  npx vite build --configLoader runner --outDir "$OUT/dist" > "$OUT/build.log" 2>&1
npx vite preview --configLoader runner --port 4180 --strictPort --outDir "$OUT/dist" > "$OUT/preview.log" 2>&1 &
echo $! > "$OUT/preview.pid"
for url in http://127.0.0.1:54322/ http://127.0.0.1:4180/; do
  for _ in $(seq 1 50); do curl -s -o /dev/null "$url" && break; sleep 0.2; done
done
echo "ready: app http://127.0.0.1:4180  supabase http://127.0.0.1:54321  logs $OUT"
