create table if not exists public.challenge_results (
  id uuid primary key,
  user_id uuid null references auth.users(id) on delete set null,
  player_name text not null check (char_length(player_name) between 1 and 40),
  mode text not null check (mode in ('time', 'steps')),
  target_distance_m integer not null check (target_distance_m between 100 and 100000),
  target_time_seconds integer null check (target_time_seconds > 0),
  actual_time_seconds integer null check (actual_time_seconds >= 0),
  error_seconds integer null check (error_seconds >= 0),
  target_steps integer null check (target_steps > 0),
  actual_steps integer null check (actual_steps > 0),
  error_steps integer null check (error_steps >= 0),
  elapsed_seconds integer not null check (elapsed_seconds >= 0),
  created_at timestamptz not null default now(),
  constraint challenge_mode_values check (
    (mode = 'time' and target_time_seconds is not null and actual_time_seconds is not null and error_seconds is not null
      and target_steps is null and actual_steps is null and error_steps is null)
    or
    (mode = 'steps' and target_steps is not null and actual_steps is not null and error_steps is not null
      and target_time_seconds is null and actual_time_seconds is null and error_seconds is null)
  )
);

-- 旧MVPスキーマを適用済みでも、このファイルの再実行だけで移行できるようにする。
alter table public.challenge_results add column if not exists user_id uuid null references auth.users(id) on delete set null;
alter table public.challenge_results add column if not exists target_time_seconds integer null check (target_time_seconds > 0);
alter table public.challenge_results add column if not exists actual_time_seconds integer null check (actual_time_seconds >= 0);
alter table public.challenge_results add column if not exists error_seconds integer null check (error_seconds >= 0);
alter table public.challenge_results add column if not exists target_steps integer null check (target_steps > 0);
alter table public.challenge_results add column if not exists actual_steps integer null check (actual_steps > 0);
alter table public.challenge_results add column if not exists error_steps integer null check (error_steps >= 0);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'challenge_results' and column_name = 'target_value'
  ) then
    execute 'update public.challenge_results set
      target_time_seconds = case when mode = ''time'' then coalesce(target_time_seconds, target_value) else null end,
      actual_time_seconds = case when mode = ''time'' then coalesce(actual_time_seconds, actual_value) else null end,
      error_seconds = case when mode = ''time'' then coalesce(error_seconds, error_value) else null end,
      target_steps = case when mode = ''steps'' then coalesce(target_steps, target_value) else null end,
      actual_steps = case when mode = ''steps'' then coalesce(actual_steps, actual_value) else null end,
      error_steps = case when mode = ''steps'' then coalesce(error_steps, error_value) else null end';
    execute 'alter table public.challenge_results alter column target_value drop not null';
    execute 'alter table public.challenge_results alter column actual_value drop not null';
    execute 'alter table public.challenge_results alter column error_value drop not null';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'challenge_mode_values'
      and conrelid = 'public.challenge_results'::regclass
  ) then
    alter table public.challenge_results add constraint challenge_mode_values check (
      (mode = 'time' and target_time_seconds is not null and actual_time_seconds is not null and error_seconds is not null
        and target_steps is null and actual_steps is null and error_steps is null)
      or
      (mode = 'steps' and target_steps is not null and actual_steps is not null and error_steps is not null
        and target_time_seconds is null and actual_time_seconds is null and error_seconds is null)
    );
  end if;
end $$;

create index if not exists challenge_results_time_ranking_idx
on public.challenge_results(mode, error_seconds asc, created_at asc) where mode = 'time';

create index if not exists challenge_results_steps_ranking_idx
on public.challenge_results(mode, error_steps asc, created_at asc) where mode = 'steps';

create index if not exists challenge_results_distance_idx
on public.challenge_results(mode, target_distance_m);

alter table public.challenge_results enable row level security;

drop policy if exists "public can read challenge results" on public.challenge_results;
create policy "public can read challenge results" on public.challenge_results
for select to anon, authenticated using (true);

drop policy if exists "public can insert challenge results" on public.challenge_results;
create policy "public can insert challenge results" on public.challenge_results
for insert to anon, authenticated with check (user_id is null or user_id = auth.uid());
