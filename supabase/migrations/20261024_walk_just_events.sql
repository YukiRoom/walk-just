-- =====================================================================
-- WALK JUST! イベント機能（Issue #1）
--
-- ■ 適用前に必ず確認してください（このSQLはまだ本番で実行していません）
--   * 追加するのは walk_just_ で始まる新規テーブル・関数・トリガーのみです。
--     public.challenge_results・okimemo 用テーブル・auth スキーマは一切変更しません。
--   * DROP TABLE / DELETE / UPDATE / TRUNCATE は含みません（DROP POLICY / DROP TRIGGER は
--     このファイルで作成するものを再作成するためだけに使います）。
--   * 何度実行しても同じ結果になるよう IF NOT EXISTS / CREATE OR REPLACE を使っています。
--   * 全体を1トランザクションで実行し、途中で失敗した場合は何も残りません。
--
-- ■ 認証・認可の設計
--   * 参加者：Supabase Anonymous Sign-ins（匿名認証）の auth.uid() を本人とみなします。
--     既存の localStorage の anonymousUserId は本人確認には使いません（参考情報として保存のみ）。
--   * 管理者：Supabase Auth のメール/パスワードユーザーのうち walk_just_admins に登録された人だけ。
--     walk_just_admins へはクライアントから書き込めません（SQL Editor から手動登録）。
--     匿名ユーザーは管理者になれません。
--   * 参加・承認・記録投稿・ランキング取得はすべて SECURITY DEFINER 関数経由で、
--     開催期間・締切・承認状態・種目・統一目標・挑戦回数・重複投稿をDB側で検証します。
--     参加者が表を直接 INSERT/UPDATE/DELETE できる RLS ポリシーはありません。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 管理者
-- ---------------------------------------------------------------------
create table if not exists public.walk_just_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  note text not null default '',
  created_at timestamptz not null default now()
);
alter table public.walk_just_admins enable row level security;
revoke all on table public.walk_just_admins from public, anon, authenticated;
grant select on table public.walk_just_admins to authenticated;
drop policy if exists "walk_just_admins: read own row" on public.walk_just_admins;
create policy "walk_just_admins: read own row" on public.walk_just_admins
  for select to authenticated using (user_id = (select auth.uid()));
-- INSERT/UPDATE/DELETE のポリシーは作らない ＝ クライアントからは管理者を追加・変更できない

create or replace function public.walk_just_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and exists (select 1 from public.walk_just_admins a where a.user_id = auth.uid())
$$;

-- ---------------------------------------------------------------------
-- イベント
-- ---------------------------------------------------------------------
create table if not exists public.walk_just_events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  entry_deadline timestamptz not null,
  modes text not null check (modes in ('time', 'steps', 'both')),
  entry_mode text not null default 'open' check (entry_mode in ('open', 'approval')),
  target_mode text not null check (target_mode in ('fixed', 'personal')),
  ranking_visibility text not null default 'realtime' check (ranking_visibility in ('realtime', 'after_end')),
  attempt_policy text not null default 'single' check (attempt_policy in ('single', 'best')),
  time_target_distance_m integer null check (time_target_distance_m between 100 and 100000),
  time_target_seconds integer null check (time_target_seconds between 1 and 86400),
  steps_target_distance_m integer null check (steps_target_distance_m between 100 and 100000),
  steps_target_steps integer null check (steps_target_steps between 1 and 1000000),
  ended_at timestamptz null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint walk_just_events_period check (starts_at < ends_at and entry_deadline <= ends_at),
  constraint walk_just_events_fixed_targets check (
    target_mode = 'personal' or (
      (modes = 'steps' or (time_target_distance_m is not null and time_target_seconds is not null))
      and (modes = 'time' or (steps_target_distance_m is not null and steps_target_steps is not null))
    )
  )
);
create index if not exists walk_just_events_period_idx on public.walk_just_events (ends_at desc, starts_at);

alter table public.walk_just_events enable row level security;
revoke all on table public.walk_just_events from public, anon, authenticated;
grant select on table public.walk_just_events to anon, authenticated;
grant insert, update on table public.walk_just_events to authenticated;

-- 閲覧：イベント情報（名称・説明・日程・ルール）は公開情報として誰でも閲覧可（URL/QRから参加するため）
drop policy if exists "walk_just_events: public read" on public.walk_just_events;
create policy "walk_just_events: public read" on public.walk_just_events
  for select to anon, authenticated using (true);
drop policy if exists "walk_just_events: admin insert" on public.walk_just_events;
create policy "walk_just_events: admin insert" on public.walk_just_events
  for insert to authenticated with check ((select public.walk_just_is_admin()));
drop policy if exists "walk_just_events: admin update" on public.walk_just_events;
create policy "walk_just_events: admin update" on public.walk_just_events
  for update to authenticated using ((select public.walk_just_is_admin())) with check ((select public.walk_just_is_admin()));
-- DELETE ポリシーなし（イベントは削除せず「終了」させる）

-- ---------------------------------------------------------------------
-- エントリー（参加者）
-- ---------------------------------------------------------------------
create table if not exists public.walk_just_event_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.walk_just_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null check (char_length(btrim(nickname)) between 1 and 20),
  legacy_anonymous_user_id uuid null,
  status text not null check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz null,
  decided_by uuid null references auth.users(id) on delete set null,
  constraint walk_just_event_entries_one_per_user unique (event_id, user_id)
);
create index if not exists walk_just_event_entries_user_idx on public.walk_just_event_entries (user_id);

alter table public.walk_just_event_entries enable row level security;
revoke all on table public.walk_just_event_entries from public, anon, authenticated;
grant select on table public.walk_just_event_entries to authenticated;
drop policy if exists "walk_just_event_entries: read own or admin" on public.walk_just_event_entries;
create policy "walk_just_event_entries: read own or admin" on public.walk_just_event_entries
  for select to authenticated using (user_id = (select auth.uid()) or (select public.walk_just_is_admin()));
-- 書き込みポリシーなし（参加は walk_just_join_event、承認は walk_just_set_entry_status のみ）

-- ---------------------------------------------------------------------
-- 挑戦（サーバー時刻での開始記録）と記録
-- ---------------------------------------------------------------------
create table if not exists public.walk_just_event_attempts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.walk_just_events(id) on delete cascade,
  entry_id uuid not null references public.walk_just_event_entries(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null check (mode in ('time', 'steps')),
  started_at timestamptz not null default now(),
  submitted_at timestamptz null
);
create index if not exists walk_just_event_attempts_user_idx on public.walk_just_event_attempts (event_id, user_id, started_at desc);
alter table public.walk_just_event_attempts enable row level security;
revoke all on table public.walk_just_event_attempts from public, anon, authenticated;
-- ポリシーなし（関数経由のみ）

create table if not exists public.walk_just_event_results (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.walk_just_events(id) on delete cascade,
  entry_id uuid not null references public.walk_just_event_entries(id) on delete cascade,
  attempt_id uuid not null unique references public.walk_just_event_attempts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null check (mode in ('time', 'steps')),
  target_distance_m integer not null check (target_distance_m between 100 and 100000),
  target_value integer not null check (target_value > 0),
  actual_value integer not null check (actual_value >= 0),
  error_value integer not null check (error_value >= 0),
  elapsed_seconds integer not null check (elapsed_seconds >= 0),
  created_at timestamptz not null default now()
);
create index if not exists walk_just_event_results_ranking_idx on public.walk_just_event_results (event_id, mode, error_value, created_at);
create index if not exists walk_just_event_results_user_idx on public.walk_just_event_results (event_id, user_id, mode);

alter table public.walk_just_event_results enable row level security;
revoke all on table public.walk_just_event_results from public, anon, authenticated;
grant select on table public.walk_just_event_results to authenticated;
drop policy if exists "walk_just_event_results: read own or admin" on public.walk_just_event_results;
create policy "walk_just_event_results: read own or admin" on public.walk_just_event_results
  for select to authenticated using (user_id = (select auth.uid()) or (select public.walk_just_is_admin()));
-- 書き込みポリシーなし（記録は walk_just_submit_event_result のみ。改ざん・削除不可）

-- ---------------------------------------------------------------------
-- イベント更新時のトリガー：作成者・更新日時の自動設定、記録がある場合のルール変更禁止
-- ---------------------------------------------------------------------
create or replace function public.walk_just_events_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
    new.ended_at := null;
    return new;
  end if;

  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_at := now();
  if old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception 'walk_just:event_already_ended' using errcode = 'P0001';
  end if;
  if new.ended_at is not null and old.ended_at is null then
    new.ended_at := now();
  end if;
  -- 記録が1件でもあるイベントは、公平性のため競技ルールを変更できない
  if exists (select 1 from public.walk_just_event_results r where r.event_id = old.id) and (
    new.modes is distinct from old.modes
    or new.target_mode is distinct from old.target_mode
    or new.attempt_policy is distinct from old.attempt_policy
    or new.time_target_distance_m is distinct from old.time_target_distance_m
    or new.time_target_seconds is distinct from old.time_target_seconds
    or new.steps_target_distance_m is distinct from old.steps_target_distance_m
    or new.steps_target_steps is distinct from old.steps_target_steps
    or new.starts_at is distinct from old.starts_at
  ) then
    raise exception 'walk_just:rules_locked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists walk_just_events_before_write on public.walk_just_events;
create trigger walk_just_events_before_write
  before insert or update on public.walk_just_events
  for each row execute function public.walk_just_events_before_write();

-- ---------------------------------------------------------------------
-- 参加者向け関数
-- ---------------------------------------------------------------------

-- エントリー（自由参加なら即承認、承認制なら承認待ち）。再実行はニックネーム更新のみ（冪等）
create or replace function public.walk_just_join_event(
  p_event_id uuid,
  p_nickname text,
  p_legacy_anonymous_user_id uuid default null
)
returns public.walk_just_event_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_nickname text := btrim(coalesce(p_nickname, ''));
  v_event public.walk_just_events;
  v_entry public.walk_just_event_entries;
begin
  if v_uid is null then
    raise exception 'walk_just:not_authenticated' using errcode = '28000';
  end if;
  if char_length(v_nickname) not between 1 and 20 then
    raise exception 'walk_just:invalid_nickname' using errcode = '22023';
  end if;
  select * into v_event from public.walk_just_events where id = p_event_id;
  if not found then
    raise exception 'walk_just:event_not_found' using errcode = 'P0002';
  end if;

  select * into v_entry from public.walk_just_event_entries where event_id = p_event_id and user_id = v_uid;
  if found then
    update public.walk_just_event_entries set nickname = v_nickname where id = v_entry.id returning * into v_entry;
    return v_entry;
  end if;

  if v_event.ended_at is not null or now() >= v_event.ends_at then
    raise exception 'walk_just:event_ended' using errcode = 'P0001';
  end if;
  if now() > v_event.entry_deadline then
    raise exception 'walk_just:entry_closed' using errcode = 'P0001';
  end if;

  insert into public.walk_just_event_entries (event_id, user_id, nickname, legacy_anonymous_user_id, status, decided_at)
  values (
    p_event_id, v_uid, v_nickname, p_legacy_anonymous_user_id,
    case when v_event.entry_mode = 'open' then 'approved' else 'pending' end,
    case when v_event.entry_mode = 'open' then now() else null end
  )
  on conflict (event_id, user_id) do update set nickname = excluded.nickname
  returning * into v_entry;
  return v_entry;
end;
$$;

-- 挑戦開始：承認済み・開催期間内・種目・挑戦回数を検証し、サーバー時刻で開始を記録する
create or replace function public.walk_just_start_event_attempt(p_event_id uuid, p_mode text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_event public.walk_just_events;
  v_entry public.walk_just_event_entries;
  v_attempt_id uuid;
begin
  if v_uid is null then
    raise exception 'walk_just:not_authenticated' using errcode = '28000';
  end if;
  if p_mode is null or p_mode not in ('time', 'steps') then
    raise exception 'walk_just:invalid_mode' using errcode = '22023';
  end if;
  select * into v_event from public.walk_just_events where id = p_event_id;
  if not found then
    raise exception 'walk_just:event_not_found' using errcode = 'P0002';
  end if;
  if v_event.modes <> 'both' and v_event.modes <> p_mode then
    raise exception 'walk_just:mode_not_allowed' using errcode = 'P0001';
  end if;
  if now() < v_event.starts_at then
    raise exception 'walk_just:event_not_started' using errcode = 'P0001';
  end if;
  if v_event.ended_at is not null or now() >= v_event.ends_at then
    raise exception 'walk_just:event_ended' using errcode = 'P0001';
  end if;

  -- 同一ユーザーの開始・投稿を直列化する
  select * into v_entry from public.walk_just_event_entries
    where event_id = p_event_id and user_id = v_uid for update;
  if not found then
    raise exception 'walk_just:not_entered' using errcode = '42501';
  end if;
  if v_entry.status <> 'approved' then
    raise exception 'walk_just:not_approved' using errcode = '42501';
  end if;
  if v_event.attempt_policy = 'single' and exists (
    select 1 from public.walk_just_event_results r
    where r.event_id = p_event_id and r.user_id = v_uid and r.mode = p_mode
  ) then
    raise exception 'walk_just:attempt_limit' using errcode = 'P0001';
  end if;
  -- 開始の乱発を防ぐ（1時間あたり30回まで）
  if (select count(*) from public.walk_just_event_attempts a
      where a.event_id = p_event_id and a.user_id = v_uid and a.started_at > now() - interval '1 hour') >= 30 then
    raise exception 'walk_just:too_many_attempts' using errcode = 'P0001';
  end if;

  insert into public.walk_just_event_attempts (event_id, entry_id, user_id, mode)
  values (p_event_id, v_entry.id, v_uid, p_mode)
  returning id into v_attempt_id;
  return v_attempt_id;
end;
$$;

-- 記録投稿：挑戦IDの本人確認・承認・期間・統一目標・挑戦回数・時間の妥当性を検証し、誤差をサーバーで計算する。
-- 同じ挑戦IDでの再投稿は最初の記録を返す（通信リトライによる重複保存を防ぐ）。
create or replace function public.walk_just_submit_event_result(
  p_attempt_id uuid,
  p_target_distance_m integer,
  p_target_value integer,
  p_actual_value integer,
  p_elapsed_seconds integer
)
returns public.walk_just_event_results
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_attempt public.walk_just_event_attempts;
  v_event public.walk_just_events;
  v_entry public.walk_just_event_entries;
  v_result public.walk_just_event_results;
  v_server_elapsed numeric;
  v_deadline timestamptz;
begin
  if v_uid is null then
    raise exception 'walk_just:not_authenticated' using errcode = '28000';
  end if;
  select * into v_attempt from public.walk_just_event_attempts where id = p_attempt_id;
  if not found or v_attempt.user_id <> v_uid then
    raise exception 'walk_just:attempt_not_found' using errcode = 'P0002';
  end if;

  select * into v_entry from public.walk_just_event_entries where id = v_attempt.entry_id for update;
  select * into v_result from public.walk_just_event_results where attempt_id = p_attempt_id;
  if found then
    return v_result;
  end if;

  if v_entry.status <> 'approved' then
    raise exception 'walk_just:not_approved' using errcode = '42501';
  end if;
  select * into v_event from public.walk_just_events where id = v_attempt.event_id;
  -- 開催終了（または管理者による終了）前に開始した挑戦のみ、終了から3時間以内まで投稿可能
  v_deadline := least(v_event.ends_at, coalesce(v_event.ended_at, v_event.ends_at)) + interval '3 hours';
  if v_attempt.started_at >= least(v_event.ends_at, coalesce(v_event.ended_at, v_event.ends_at)) or now() > v_deadline then
    raise exception 'walk_just:event_ended' using errcode = 'P0001';
  end if;
  if v_event.attempt_policy = 'single' and exists (
    select 1 from public.walk_just_event_results r
    where r.event_id = v_event.id and r.user_id = v_uid and r.mode = v_attempt.mode
  ) then
    raise exception 'walk_just:attempt_limit' using errcode = 'P0001';
  end if;

  if p_target_distance_m is null or p_target_value is null or p_actual_value is null or p_elapsed_seconds is null then
    raise exception 'walk_just:invalid_result' using errcode = '22023';
  end if;
  if v_event.target_mode = 'fixed' then
    if (v_attempt.mode = 'time' and (p_target_distance_m <> v_event.time_target_distance_m or p_target_value <> v_event.time_target_seconds))
      or (v_attempt.mode = 'steps' and (p_target_distance_m <> v_event.steps_target_distance_m or p_target_value <> v_event.steps_target_steps)) then
      raise exception 'walk_just:target_mismatch' using errcode = 'P0001';
    end if;
  elsif p_target_distance_m not between 100 and 100000
    or (v_attempt.mode = 'time' and p_target_value not between 1 and 86400)
    or (v_attempt.mode = 'steps' and p_target_value not between 1 and 1000000) then
    raise exception 'walk_just:invalid_target' using errcode = '22023';
  end if;

  -- 経過時間の妥当性：サーバーで記録した開始時刻からの経過以内、かつ毎秒6m（人が歩く・走る速さ）を超えない
  v_server_elapsed := extract(epoch from (now() - v_attempt.started_at));
  if p_elapsed_seconds < 0 or p_elapsed_seconds > v_server_elapsed + 10
    or p_elapsed_seconds * 6 < p_target_distance_m then
    raise exception 'walk_just:implausible_time' using errcode = 'P0001';
  end if;
  if v_attempt.mode = 'time' and p_actual_value <> p_elapsed_seconds then
    raise exception 'walk_just:invalid_result' using errcode = '22023';
  end if;
  if v_attempt.mode = 'steps' and p_actual_value not between 1 and 1000000 then
    raise exception 'walk_just:invalid_result' using errcode = '22023';
  end if;

  insert into public.walk_just_event_results (
    event_id, entry_id, attempt_id, user_id, mode, target_distance_m, target_value, actual_value, error_value, elapsed_seconds
  ) values (
    v_event.id, v_entry.id, v_attempt.id, v_uid, v_attempt.mode, p_target_distance_m, p_target_value,
    p_actual_value, abs(p_actual_value - p_target_value), p_elapsed_seconds
  )
  returning * into v_result;
  update public.walk_just_event_attempts set submitted_at = now() where id = v_attempt.id;
  return v_result;
end;
$$;

-- イベントランキング：承認済み参加者の記録のみ。TIME/STEP別に誤差昇順（同率は記録日時順）。
-- 複数回挑戦（best）は各参加者のベスト記録のみ。after_end は終了まで管理者以外には空を返す。
-- 閲覧権限：イベントURLを知っていれば誰でも（未ログイン含む）閲覧可。user_id は返さず、本人の記録だけ is_me で識別。
create or replace function public.walk_just_event_ranking(p_event_id uuid, p_mode text)
returns table (
  rank integer,
  nickname text,
  target_distance_m integer,
  target_value integer,
  actual_value integer,
  error_value integer,
  created_at timestamptz,
  attempts integer,
  is_me boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event public.walk_just_events;
begin
  select * into v_event from public.walk_just_events where id = p_event_id;
  if not found then
    raise exception 'walk_just:event_not_found' using errcode = 'P0002';
  end if;
  if p_mode is null or p_mode not in ('time', 'steps') then
    raise exception 'walk_just:invalid_mode' using errcode = '22023';
  end if;
  if v_event.ranking_visibility = 'after_end'
    and v_event.ended_at is null and now() < v_event.ends_at
    and not public.walk_just_is_admin() then
    return;
  end if;

  return query
  with eligible as (
    select r.*, e.nickname as entry_nickname,
      count(*) over (partition by r.user_id) as attempt_count
    from public.walk_just_event_results r
    join public.walk_just_event_entries e on e.id = r.entry_id and e.status = 'approved'
    where r.event_id = p_event_id and r.mode = p_mode
  ), best as (
    select distinct on (user_id) *
    from eligible
    order by user_id, error_value asc, created_at asc
  )
  select
    (row_number() over (order by b.error_value asc, b.created_at asc))::integer,
    b.entry_nickname,
    b.target_distance_m,
    b.target_value,
    b.actual_value,
    b.error_value,
    b.created_at,
    b.attempt_count::integer,
    coalesce(b.user_id = auth.uid(), false)
  from best b
  order by b.error_value asc, b.created_at asc
  limit 200;
end;
$$;

-- ---------------------------------------------------------------------
-- 管理者向け関数
-- ---------------------------------------------------------------------
create or replace function public.walk_just_set_entry_status(p_entry_id uuid, p_status text)
returns public.walk_just_event_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry public.walk_just_event_entries;
begin
  if not public.walk_just_is_admin() then
    raise exception 'walk_just:forbidden' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'walk_just:invalid_status' using errcode = '22023';
  end if;
  update public.walk_just_event_entries
    set status = p_status, decided_at = now(), decided_by = auth.uid()
    where id = p_entry_id
    returning * into v_entry;
  if not found then
    raise exception 'walk_just:entry_not_found' using errcode = 'P0002';
  end if;
  return v_entry;
end;
$$;

-- ---------------------------------------------------------------------
-- 関数の実行権限（Supabase の既定では public スキーマの関数は anon にも付与されるため明示的に絞る）
-- ---------------------------------------------------------------------
revoke all on function public.walk_just_is_admin() from public, anon, authenticated;
revoke all on function public.walk_just_events_before_write() from public, anon, authenticated;
revoke all on function public.walk_just_join_event(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.walk_just_start_event_attempt(uuid, text) from public, anon, authenticated;
revoke all on function public.walk_just_submit_event_result(uuid, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.walk_just_event_ranking(uuid, text) from public, anon, authenticated;
revoke all on function public.walk_just_set_entry_status(uuid, text) from public, anon, authenticated;

grant execute on function public.walk_just_is_admin() to authenticated;
grant execute on function public.walk_just_join_event(uuid, text, uuid) to authenticated;
grant execute on function public.walk_just_start_event_attempt(uuid, text) to authenticated;
grant execute on function public.walk_just_submit_event_result(uuid, integer, integer, integer, integer) to authenticated;
grant execute on function public.walk_just_event_ranking(uuid, text) to anon, authenticated;
grant execute on function public.walk_just_set_entry_status(uuid, text) to authenticated;

commit;

-- PostgREST のスキーマキャッシュを更新
notify pgrst, 'reload schema';
