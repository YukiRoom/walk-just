-- 【手動実行】WALK JUST! の管理者を登録する
-- 1. Supabase Dashboard → Authentication → Users → 「Add user」で管理者のメールアドレスとパスワードを作成
--    （既存の okimemo アカウントを使う場合は作成不要）
-- 2. 下の 'YOUR_ADMIN_EMAIL@example.com' を管理者のメールアドレスに置き換えて SQL Editor で実行
-- このテーブルはアプリからは書き込めません（RLSで拒否）。管理者の追加・削除は必ずこの方法で行います。
insert into public.walk_just_admins (user_id, note)
select id, 'WALK JUST! admin'
from auth.users
where email = 'YOUR_ADMIN_EMAIL@example.com'
  and coalesce(is_anonymous, false) = false
on conflict (user_id) do nothing;

-- 確認
select a.user_id, u.email, a.created_at
from public.walk_just_admins a join auth.users u on u.id = a.user_id;

-- 管理者を外す場合：
-- delete from public.walk_just_admins where user_id = (select id from auth.users where email = 'YOUR_ADMIN_EMAIL@example.com');
