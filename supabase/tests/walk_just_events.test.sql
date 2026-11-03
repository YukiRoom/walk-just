-- WALK JUST! イベント機能 DBテスト（ローカル検証専用。本番では実行しないこと）
-- 前提：supabase_stub.sql → schema.sql → migrations/*.sql を適用済みのローカルPostgreSQL
-- 実行：psql -v ON_ERROR_STOP=1 -f supabase/tests/walk_just_events.test.sql
\set QUIET on
\set ON_ERROR_STOP on
set client_min_messages = warning;

drop schema if exists wjt cascade;
create schema wjt;
grant usage on schema wjt to anon, authenticated;
create table wjt.results (n serial, name text, ok boolean, detail text);
grant all on wjt.results to anon, authenticated;
grant usage on sequence wjt.results_n_seq to anon, authenticated;

-- テスト用ログイン：role と JWT claims をトランザクション内で設定する
create function wjt.login(p_uid uuid, p_anonymous boolean) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated', 'is_anonymous', p_anonymous)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function wjt.logout_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;
create function wjt.ok(p_name text, p_cond boolean, p_detail text default null) returns void language plpgsql as $$
begin insert into wjt.results(name, ok, detail) values (p_name, coalesce(p_cond, false), p_detail); end $$;
-- SQLを実行し、エラーメッセージに p_pattern を含むことを確認
create function wjt.throws(p_name text, p_sql text, p_pattern text) returns void language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
    v_msg := '(no error)';
  exception when others then
    v_msg := sqlerrm;
  end;
  perform wjt.ok(p_name, position(p_pattern in v_msg) > 0, v_msg);
end $$;
grant execute on all functions in schema wjt to anon, authenticated;

-- 利用者
insert into auth.users (id, email, is_anonymous) values
  ('a0000000-0000-4000-8000-000000000001', 'admin@example.com', false),
  ('b0000000-0000-4000-8000-000000000001', null, true),   -- U1 匿名参加者
  ('b0000000-0000-4000-8000-000000000002', null, true),   -- U2 匿名参加者
  ('b0000000-0000-4000-8000-000000000003', null, true),   -- U3 匿名参加者
  ('c0000000-0000-4000-8000-000000000001', 'okimemo-user@example.com', false) -- 管理者でないメールユーザー
on conflict do nothing;
insert into public.walk_just_admins (user_id, note) values ('a0000000-0000-4000-8000-000000000001', 'test admin') on conflict do nothing;

\set ADMIN 'a0000000-0000-4000-8000-000000000001'
\set U1 'b0000000-0000-4000-8000-000000000001'
\set U2 'b0000000-0000-4000-8000-000000000002'
\set U3 'b0000000-0000-4000-8000-000000000003'
\set NONADMIN 'c0000000-0000-4000-8000-000000000001'

-- ---------------------------------------------------------------- 管理者権限
begin;
select wjt.login(:'U1', true);
select wjt.ok('匿名参加者は管理者ではない', not public.walk_just_is_admin());
select wjt.throws('参加者は管理者テーブルに自分を追加できない',
  format('insert into public.walk_just_admins(user_id) values (%L)', :'U1'), 'permission denied');
select wjt.throws('参加者はイベントを作成できない（RLS）',
  $q$insert into public.walk_just_events(name, starts_at, ends_at, entry_deadline, modes, target_mode) values ('x', now(), now() + interval '1 day', now(), 'time', 'personal')$q$,
  'row-level security');
commit;

begin;
select wjt.login(:'NONADMIN', false);
select wjt.ok('管理者未登録のメールユーザーは管理者ではない', not public.walk_just_is_admin());
commit;

-- 匿名ユーザーが（誤って）管理者テーブルに登録されていても管理者扱いにしない
insert into public.walk_just_admins (user_id) values (:'U3');
begin;
select wjt.login(:'U3', true);
select wjt.ok('匿名ユーザーは管理者テーブルにいても管理者にならない', not public.walk_just_is_admin());
commit;
delete from public.walk_just_admins where user_id = :'U3';

begin;
select wjt.login(:'ADMIN', false);
select wjt.ok('登録済み管理者は管理者', public.walk_just_is_admin());
select wjt.throws('統一目標で目標未設定のイベントは作成不可',
  $q$insert into public.walk_just_events(name, starts_at, ends_at, entry_deadline, modes, target_mode) values ('x', now(), now() + interval '1 day', now(), 'time', 'fixed')$q$,
  'walk_just_events_fixed_targets');
select wjt.throws('締切が終了より後のイベントは作成不可',
  $q$insert into public.walk_just_events(name, starts_at, ends_at, entry_deadline, modes, target_mode) values ('x', now(), now() + interval '1 day', now() + interval '2 days', 'time', 'personal')$q$,
  'walk_just_events_period');
-- E1: 自由参加・統一目標・両種目・1回のみ・リアルタイム
insert into public.walk_just_events (id, name, starts_at, ends_at, entry_deadline, modes, entry_mode, target_mode, ranking_visibility, attempt_policy,
  time_target_distance_m, time_target_seconds, steps_target_distance_m, steps_target_steps, created_by)
values ('e1000000-0000-4000-8000-000000000001', '自由参加・統一', now() - interval '1 hour', now() + interval '1 day', now() + interval '12 hours',
  'both', 'open', 'fixed', 'realtime', 'single', 1000, 600, 500, 700, :'U1');
-- E2: 承認制・個人目標・TIMEのみ・複数回ベスト・終了後公開
insert into public.walk_just_events (id, name, starts_at, ends_at, entry_deadline, modes, entry_mode, target_mode, ranking_visibility, attempt_policy)
values ('e2000000-0000-4000-8000-000000000002', '承認制・個人', now() - interval '1 hour', now() + interval '1 day', now() + interval '12 hours',
  'time', 'approval', 'personal', 'after_end', 'best');
-- E3: 未開始 / E4: 締切済み
insert into public.walk_just_events (id, name, starts_at, ends_at, entry_deadline, modes, target_mode)
values ('e3000000-0000-4000-8000-000000000003', '未開始', now() + interval '1 day', now() + interval '2 days', now() + interval '1 day', 'steps', 'personal');
insert into public.walk_just_events (id, name, starts_at, ends_at, entry_deadline, modes, target_mode)
values ('e4000000-0000-4000-8000-000000000004', '締切済み', now() - interval '2 hours', now() + interval '1 day', now() - interval '1 hour', 'time', 'personal');
select wjt.ok('created_by は申告値ではなく auth.uid() になる',
  (select created_by from public.walk_just_events where id = 'e1000000-0000-4000-8000-000000000001') = :'ADMIN'::uuid);
commit;

-- ---------------------------------------------------------------- 未ログイン（anon）
begin;
select wjt.logout_anon();
select wjt.ok('未ログインでもイベント一覧を閲覧できる', (select count(*) from public.walk_just_events) = 4);
select wjt.throws('未ログインはエントリー表を読めない', 'select * from public.walk_just_event_entries', 'permission denied');
select wjt.throws('未ログインは記録表を読めない', 'select * from public.walk_just_event_results', 'permission denied');
select wjt.throws('未ログインはエントリーできない',
  $q$select public.walk_just_join_event('e1000000-0000-4000-8000-000000000001', 'x')$q$, 'permission denied');
select wjt.ok('未ログインでもランキング関数は呼べる',
  (select count(*) from public.walk_just_event_ranking('e1000000-0000-4000-8000-000000000001', 'time')) = 0);
commit;

-- ---------------------------------------------------------------- エントリー
begin;
select wjt.login(:'U1', true);
select wjt.ok('自由参加は即承認',
  (public.walk_just_join_event('e1000000-0000-4000-8000-000000000001', '  ユーザー1  ', 'aaaaaaaa-0000-4000-8000-000000000001')).status = 'approved');
select wjt.ok('ニックネームは前後空白を除去',
  (select nickname from public.walk_just_event_entries where event_id = 'e1000000-0000-4000-8000-000000000001') = 'ユーザー1');
select wjt.ok('再エントリーは重複せずニックネーム更新',
  (public.walk_just_join_event('e1000000-0000-4000-8000-000000000001', 'ユーザー1改')).nickname = 'ユーザー1改'
  and (select count(*) from public.walk_just_event_entries) = 1);
select wjt.throws('21文字のニックネームは不可',
  $q$select public.walk_just_join_event('e1000000-0000-4000-8000-000000000001', repeat('あ', 21))$q$, 'invalid_nickname');
select wjt.throws('締切後はエントリー不可',
  $q$select public.walk_just_join_event('e4000000-0000-4000-8000-000000000004', 'x')$q$, 'entry_closed');
select wjt.ok('開始前のイベントにはエントリーできる',
  (public.walk_just_join_event('e3000000-0000-4000-8000-000000000003', 'ユーザー1')).status = 'approved');
select wjt.throws('開始前は挑戦できない',
  $q$select public.walk_just_start_event_attempt('e3000000-0000-4000-8000-000000000003', 'steps')$q$, 'event_not_started');
select wjt.throws('存在しないイベント',
  $q$select public.walk_just_join_event('e9999999-0000-4000-8000-000000000009', 'x')$q$, 'event_not_found');
commit;

begin;
select wjt.login(:'U2', true);
select wjt.ok('承認制は承認待ち',
  (public.walk_just_join_event('e2000000-0000-4000-8000-000000000002', 'ユーザー2')).status = 'pending');
select wjt.throws('承認前は挑戦できない',
  $q$select public.walk_just_start_event_attempt('e2000000-0000-4000-8000-000000000002', 'time')$q$, 'not_approved');
select wjt.throws('参加者は自分のエントリーを直接承認できない',
  $q$update public.walk_just_event_entries set status = 'approved'$q$, 'permission denied');
select wjt.throws('参加者は承認関数を使えない',
  format('select public.walk_just_set_entry_status(%L, %L)', (select id from public.walk_just_event_entries limit 1), 'approved'), 'forbidden');
select wjt.throws('未エントリーのイベントでは挑戦できない',
  $q$select public.walk_just_start_event_attempt('e1000000-0000-4000-8000-000000000001', 'time')$q$, 'not_entered');
select wjt.ok('参加者には自分のエントリーだけが見える', (select count(*) from public.walk_just_event_entries) = 1);
commit;

begin;
select wjt.login(:'U1', true);
select wjt.throws('他人のエントリーは承認できない（参加者）',
  format('select public.walk_just_set_entry_status(%L, %L)',
    'ffffffff-0000-4000-8000-000000000000', 'approved'), 'forbidden');
commit;

begin;
select wjt.login(:'ADMIN', false);
select wjt.ok('管理者は全エントリーを閲覧', (select count(*) from public.walk_just_event_entries) = 3);
select wjt.ok('管理者が承認',
  (public.walk_just_set_entry_status((select id from public.walk_just_event_entries where user_id = :'U2'::uuid), 'approved')).status = 'approved');
commit;

-- ---------------------------------------------------------------- 挑戦・記録（E1: 統一目標・1回のみ）
begin;
select wjt.login(:'U1', true);
select set_config('wjt.a1', public.walk_just_start_event_attempt('e1000000-0000-4000-8000-000000000001', 'time')::text, false);
commit;
-- 開始から200秒経過したことにする
update public.walk_just_event_attempts set started_at = now() - interval '200 seconds' where id = current_setting('wjt.a1')::uuid;

begin;
select wjt.login(:'U1', true);
select wjt.throws('統一目標と異なる目標は不可',
  format('select public.walk_just_submit_event_result(%L, 900, 600, 190, 190)', current_setting('wjt.a1')), 'target_mismatch');
select wjt.throws('サーバー経過時間を超えるタイムは不可',
  format('select public.walk_just_submit_event_result(%L, 1000, 600, 400, 400)', current_setting('wjt.a1')), 'implausible_time');
select wjt.throws('人の速さを超えるタイムは不可（1000mを100秒）',
  format('select public.walk_just_submit_event_result(%L, 1000, 600, 100, 100)', current_setting('wjt.a1')), 'implausible_time');
select wjt.throws('TIMEで実タイムと経過時間の不一致は不可',
  format('select public.walk_just_submit_event_result(%L, 1000, 600, 150, 190)', current_setting('wjt.a1')), 'invalid_result');
select wjt.throws('参加者は記録を直接INSERTできない',
  format($q$insert into public.walk_just_event_results(event_id, entry_id, attempt_id, user_id, mode, target_distance_m, target_value, actual_value, error_value, elapsed_seconds)
    select event_id, entry_id, id, user_id, mode, 1000, 600, 600, 0, 600 from public.walk_just_event_attempts where id = %L$q$, current_setting('wjt.a1')),
  'permission denied');
select wjt.ok('正しい記録は保存され、誤差はサーバーで計算',
  (public.walk_just_submit_event_result(current_setting('wjt.a1')::uuid, 1000, 600, 190, 190)).error_value = 410);
select wjt.ok('同じ挑戦の再投稿は重複保存されず同じ記録を返す',
  (public.walk_just_submit_event_result(current_setting('wjt.a1')::uuid, 1000, 600, 195, 195)).actual_value = 190
  and (select count(*) from public.walk_just_event_results) = 1);
select wjt.throws('1回のみのイベントで2回目の挑戦は開始できない',
  $q$select public.walk_just_start_event_attempt('e1000000-0000-4000-8000-000000000001', 'time')$q$, 'attempt_limit');
select wjt.throws('記録は改ざんできない',
  'update public.walk_just_event_results set error_value = 0', 'permission denied');
select wjt.throws('記録は削除できない',
  'delete from public.walk_just_event_results', 'permission denied');
select set_config('wjt.a1s', public.walk_just_start_event_attempt('e1000000-0000-4000-8000-000000000001', 'steps')::text, false);
commit;
update public.walk_just_event_attempts set started_at = now() - interval '400 seconds' where id = current_setting('wjt.a1s')::uuid;

begin;
select wjt.login(:'U2', true);
select wjt.throws('他人の挑戦IDでは投稿できない',
  format('select public.walk_just_submit_event_result(%L, 500, 700, 650, 300)', current_setting('wjt.a1s')), 'attempt_not_found');
select wjt.ok('参加者には他人の記録が見えない', (select count(*) from public.walk_just_event_results) = 0);
commit;

begin;
select wjt.login(:'U1', true);
select wjt.ok('両種目イベントはSTEPも別に挑戦できる（誤差50歩）',
  (public.walk_just_submit_event_result(current_setting('wjt.a1s')::uuid, 500, 700, 650, 300)).error_value = 50);
commit;

-- 同じ1回のみイベントに、開始済みの挑戦を2つ用意して同時に投稿しても2件目は拒否
begin;
select wjt.login(:'U3', true);
select public.walk_just_join_event('e1000000-0000-4000-8000-000000000001', 'ユーザー3');
select set_config('wjt.a3a', public.walk_just_start_event_attempt('e1000000-0000-4000-8000-000000000001', 'time')::text, false);
select set_config('wjt.a3b', public.walk_just_start_event_attempt('e1000000-0000-4000-8000-000000000001', 'time')::text, false);
commit;
update public.walk_just_event_attempts set started_at = now() - interval '700 seconds' where id in (current_setting('wjt.a3a')::uuid, current_setting('wjt.a3b')::uuid);
begin;
select wjt.login(:'U3', true);
select wjt.ok('U3の1回目（誤差5秒）',
  (public.walk_just_submit_event_result(current_setting('wjt.a3a')::uuid, 1000, 600, 605, 605)).error_value = 5);
select wjt.throws('開始済みでも2回目の投稿は拒否（1回のみ）',
  format('select public.walk_just_submit_event_result(%L, 1000, 600, 600, 600)', current_setting('wjt.a3b')), 'attempt_limit');
commit;

-- ---------------------------------------------------------------- ランキング（E1: リアルタイム）
begin;
select wjt.login(:'U1', true);
select wjt.ok('TIMEランキングは誤差昇順（U3:5秒 → U1:410秒）',
  (select string_agg(nickname || ':' || error_value, ',' order by rank) from public.walk_just_event_ranking('e1000000-0000-4000-8000-000000000001', 'time'))
  = 'ユーザー3:5,ユーザー1改:410');
select wjt.ok('自分の記録だけ is_me',
  (select string_agg(nickname || ':' || is_me, ',' order by rank) from public.walk_just_event_ranking('e1000000-0000-4000-8000-000000000001', 'time'))
  = 'ユーザー3:false,ユーザー1改:true');
select wjt.ok('STEPランキングは別集計',
  (select string_agg(nickname || ':' || error_value, ',') from public.walk_just_event_ranking('e1000000-0000-4000-8000-000000000001', 'steps')) = 'ユーザー1改:50');
commit;
begin;
select wjt.logout_anon();
select wjt.ok('未ログインでもランキング閲覧可（is_meは全てfalse）',
  (select count(*) filter (where not is_me) from public.walk_just_event_ranking('e1000000-0000-4000-8000-000000000001', 'time')) = 2);
commit;

-- ---------------------------------------------------------------- E2: 個人目標・複数回ベスト・終了後公開
do $$ begin perform 1; end $$;
begin;
select wjt.login(:'U2', true);
select set_config('wjt.b1', public.walk_just_start_event_attempt('e2000000-0000-4000-8000-000000000002', 'time')::text, false);
select set_config('wjt.b2', public.walk_just_start_event_attempt('e2000000-0000-4000-8000-000000000002', 'time')::text, false);
select wjt.throws('TIMEのみのイベントでSTEPは不可',
  $q$select public.walk_just_start_event_attempt('e2000000-0000-4000-8000-000000000002', 'steps')$q$, 'mode_not_allowed');
commit;
update public.walk_just_event_attempts set started_at = now() - interval '900 seconds' where id in (current_setting('wjt.b1')::uuid, current_setting('wjt.b2')::uuid);
begin;
select wjt.login(:'U2', true);
select wjt.throws('個人目標でも範囲外（50m）は不可',
  format('select public.walk_just_submit_event_result(%L, 50, 300, 300, 300)', current_setting('wjt.b1')), 'invalid_target');
select wjt.ok('個人目標1回目（誤差30秒）',
  (public.walk_just_submit_event_result(current_setting('wjt.b1')::uuid, 2000, 800, 830, 830)).error_value = 30);
select wjt.ok('個人目標2回目（誤差3秒）',
  (public.walk_just_submit_event_result(current_setting('wjt.b2')::uuid, 1500, 700, 697, 697)).error_value = 3);
select wjt.ok('終了後公開：開催中は参加者にランキングを返さない',
  (select count(*) from public.walk_just_event_ranking('e2000000-0000-4000-8000-000000000002', 'time')) = 0);
commit;
begin;
select wjt.login(:'ADMIN', false);
select wjt.ok('終了後公開でも管理者は開催中に閲覧可・ベスト記録のみ・挑戦回数2',
  (select string_agg(nickname || ':' || error_value || ':' || attempts, ',') from public.walk_just_event_ranking('e2000000-0000-4000-8000-000000000002', 'time')) = 'ユーザー2:3:2');
select wjt.throws('記録があるイベントの競技ルールは変更不可',
  $q$update public.walk_just_events set time_target_seconds = 601 where id = 'e1000000-0000-4000-8000-000000000001'$q$, 'rules_locked');
update public.walk_just_events set description = '説明を更新' where id = 'e1000000-0000-4000-8000-000000000001';
select wjt.ok('記録があっても説明は更新可', (select description from public.walk_just_events where id = 'e1000000-0000-4000-8000-000000000001') = '説明を更新');
commit;

-- 承認後に挑戦を開始し、管理者が終了させた後でも（3時間以内なら）投稿できる
begin;
select wjt.login(:'U2', true);
select set_config('wjt.b3', public.walk_just_start_event_attempt('e2000000-0000-4000-8000-000000000002', 'time')::text, false);
commit;
update public.walk_just_event_attempts set started_at = now() - interval '300 seconds' where id = current_setting('wjt.b3')::uuid;
begin;
select wjt.login(:'ADMIN', false);
update public.walk_just_events set ended_at = '2000-01-01' where id = 'e2000000-0000-4000-8000-000000000002';
select wjt.ok('終了日時は申告値ではなく now() になる',
  (select ended_at > now() - interval '1 minute' from public.walk_just_events where id = 'e2000000-0000-4000-8000-000000000002'));
select wjt.throws('終了したイベントは再開できない',
  $q$update public.walk_just_events set ended_at = null where id = 'e2000000-0000-4000-8000-000000000002'$q$, 'event_already_ended');
commit;
begin;
select wjt.login(:'U2', true);
select wjt.ok('終了前に開始した挑戦は終了後も投稿できる',
  (public.walk_just_submit_event_result(current_setting('wjt.b3')::uuid, 1000, 280, 280, 280)).error_value = 0);
select wjt.throws('終了後は新しい挑戦を開始できない',
  $q$select public.walk_just_start_event_attempt('e2000000-0000-4000-8000-000000000002', 'time')$q$, 'event_ended');
select wjt.ok('終了後は参加者にもランキングを公開（ベスト=誤差0、3回）',
  (select string_agg(nickname || ':' || error_value || ':' || attempts || ':' || is_me, ',') from public.walk_just_event_ranking('e2000000-0000-4000-8000-000000000002', 'time')) = 'ユーザー2:0:3:true');
commit;
begin;
select wjt.login(:'U3', true);
select wjt.throws('終了後はエントリーできない',
  $q$select public.walk_just_join_event('e2000000-0000-4000-8000-000000000002', 'x')$q$, 'event_ended');
commit;

-- 承認を取り消した参加者の記録はランキングから除外
begin;
select wjt.login(:'ADMIN', false);
select public.walk_just_set_entry_status((select id from public.walk_just_event_entries where user_id = :'U3'::uuid and event_id = 'e1000000-0000-4000-8000-000000000001'), 'rejected');
select wjt.ok('却下した参加者はランキングから除外',
  (select string_agg(nickname, ',') from public.walk_just_event_ranking('e1000000-0000-4000-8000-000000000001', 'time')) = 'ユーザー1改');
commit;

-- 参加者はイベントを更新できない
begin;
select wjt.login(:'U1', true);
update public.walk_just_events set name = '乗っ取り';
select wjt.ok('参加者のイベント更新はRLSで0件', not exists (select 1 from public.walk_just_events where name = '乗っ取り'));
commit;

-- ---------------------------------------------------------------- 既存の通常モード
begin;
select wjt.logout_anon();
insert into public.challenge_results (id, player_name, mode, target_distance_m, target_time_seconds, actual_time_seconds, error_seconds, elapsed_seconds)
values (gen_random_uuid(), '通常', 'time', 1000, 600, 610, 10, 610);
select wjt.ok('通常モード：未ログインで保存・閲覧できる（従来どおり）', (select count(*) from public.challenge_results where player_name = '通常') = 1);
commit;
begin;
select wjt.login(:'U1', true);
insert into public.challenge_results (id, player_name, mode, target_distance_m, target_steps, actual_steps, error_steps, elapsed_seconds)
values (gen_random_uuid(), '通常2', 'steps', 1000, 1300, 1290, 10, 610);
select wjt.ok('通常モード：匿名ログイン中でも保存できる', (select count(*) from public.challenge_results where player_name = '通常2') = 1);
commit;

-- ---------------------------------------------------------------- 結果
reset role;
\set QUIET off
select n, case when ok then 'PASS' else 'FAIL' end as result, name, case when ok then '' else detail end as detail from wjt.results order by n;
select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from wjt.results;
do $$ begin
  if exists (select 1 from wjt.results where not ok) then raise exception 'DB tests failed'; end if;
end $$;
