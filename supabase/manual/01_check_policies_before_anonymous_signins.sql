-- 【読み取り専用・変更なし】匿名ログイン（Anonymous Sign-ins）を有効にする前の確認用
--
-- Supabaseの匿名ログインで作られたユーザーは、DB上は authenticated ロールになります。
-- 同じプロジェクトの okimemo 側に「authenticated なら誰でも読める/書ける」ポリシーがあると、
-- WALK JUST! の匿名参加者がそれを満たしてしまう可能性があります。
-- このSQLは public スキーマ（walk_just_* と challenge_results 以外）で、
-- authenticated に適用され、かつ is_anonymous を確認していないポリシーを一覧にします。
-- 結果が0行なら問題ありません。行が出た場合は、匿名ログインを有効にする前にご相談ください
-- （okimemo のポリシーは変更せず、対応方法を検討します）。
select
  schemaname,
  tablename,
  policyname,
  cmd,
  roles,
  coalesce(qual, '') as using_expression,
  coalesce(with_check, '') as with_check_expression
from pg_policies
where schemaname = 'public'
  and tablename not like 'walk\_just\_%'
  and tablename <> 'challenge_results'
  and ('authenticated' = any (roles) or 'public' = any (roles))
  and coalesce(qual, '') || coalesce(with_check, '') not ilike '%is_anonymous%'
order by tablename, policyname;

-- 参考：RLS が無効な public テーブル（匿名ユーザーに限らず要注意）
select relname as table_without_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
order by relname;
