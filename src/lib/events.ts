import { supabase } from './supabase'
import type { ChallengeMode } from '../types'

export type EventModes = 'time' | 'steps' | 'both'
export type EntryMode = 'open' | 'approval'
export type TargetMode = 'fixed' | 'personal'
export type RankingVisibility = 'realtime' | 'after_end'
export type AttemptPolicy = 'single' | 'best'
export type EntryStatus = 'pending' | 'approved' | 'rejected'

export type WalkEvent = {
  id: string
  name: string
  description: string
  starts_at: string
  ends_at: string
  entry_deadline: string
  modes: EventModes
  entry_mode: EntryMode
  target_mode: TargetMode
  ranking_visibility: RankingVisibility
  attempt_policy: AttemptPolicy
  time_target_distance_m: number | null
  time_target_seconds: number | null
  steps_target_distance_m: number | null
  steps_target_steps: number | null
  ended_at: string | null
  created_at: string
}

export type EventInput = Omit<WalkEvent, 'id' | 'ended_at' | 'created_at'>

export type EventEntry = {
  id: string
  event_id: string
  user_id: string
  nickname: string
  status: EntryStatus
  created_at: string
  decided_at: string | null
}

export type EventResult = {
  id: string
  event_id: string
  attempt_id: string
  mode: ChallengeMode
  target_distance_m: number
  target_value: number
  actual_value: number
  error_value: number
  elapsed_seconds: number
  created_at: string
}

export type EventRankingRow = {
  rank: number
  nickname: string
  target_distance_m: number
  target_value: number
  actual_value: number
  error_value: number
  created_at: string
  attempts: number
  is_me: boolean
}

export type EventPhase = 'upcoming' | 'open' | 'ended'

export function eventPhase(event: WalkEvent, now = Date.now()): EventPhase {
  if (event.ended_at || now >= Date.parse(event.ends_at)) return 'ended'
  if (now < Date.parse(event.starts_at)) return 'upcoming'
  return 'open'
}

export function eventAllowsMode(event: WalkEvent, mode: ChallengeMode): boolean {
  return event.modes === 'both' || event.modes === mode
}

export function eventModes(event: WalkEvent): ChallengeMode[] {
  return event.modes === 'both' ? ['time', 'steps'] : [event.modes]
}

export function fixedTarget(event: WalkEvent, mode: ChallengeMode): { distanceM: number; value: number } | null {
  if (event.target_mode !== 'fixed') return null
  const distanceM = mode === 'time' ? event.time_target_distance_m : event.steps_target_distance_m
  const value = mode === 'time' ? event.time_target_seconds : event.steps_target_steps
  return distanceM !== null && value !== null ? { distanceM, value } : null
}

export function rankingHidden(event: WalkEvent, isAdmin: boolean): boolean {
  return event.ranking_visibility === 'after_end' && eventPhase(event) !== 'ended' && !isAdmin
}

export function eventUrl(eventId: string): string {
  return `${window.location.origin}/?event=${encodeURIComponent(eventId)}`
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isEventId(value: string | null): value is string {
  return value !== null && UUID_PATTERN.test(value)
}

// ---------------------------------------------------------------- エラー表示

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: '参加者の認証に失敗しました。通信状態を確認して、もう一度お試しください。',
  invalid_nickname: 'ニックネームは1〜20文字で設定してください。',
  event_not_found: 'イベントが見つかりません。URLを確認してください。',
  event_ended: 'このイベントは終了しました。',
  entry_closed: 'エントリーの受付は締め切られました。',
  invalid_mode: 'この種目では参加できません。',
  mode_not_allowed: 'このイベントでは選択した種目に挑戦できません。',
  event_not_started: 'イベントはまだ始まっていません。',
  not_entered: 'このイベントにエントリーしていません。',
  not_approved: '参加が承認されるまで記録できません。',
  attempt_limit: 'このイベントでは1回だけ挑戦できます（挑戦済み）。',
  too_many_attempts: '短時間に挑戦を開始しすぎています。しばらく待ってからお試しください。',
  attempt_not_found: '挑戦情報が見つかりません。もう一度チャレンジしてください。',
  target_mismatch: 'イベントの統一目標と異なるため記録できません。',
  invalid_target: '目標の値が範囲外です。',
  implausible_time: '記録時間が不自然なため保存できませんでした。',
  invalid_result: '記録の値が不正です。',
  forbidden: '管理者権限がありません。',
  invalid_status: '承認状態が不正です。',
  entry_not_found: 'エントリーが見つかりません。',
  rules_locked: '記録があるイベントは、種目・目標・開始日時・挑戦回数を変更できません。',
  event_already_ended: '終了したイベントは再開できません。',
}

export function eventErrorMessage(error: unknown, fallback = '通信に失敗しました。通信状態を確認して、もう一度お試しください。'): string {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error ?? '')
  const match = message.match(/walk_just:([a-z_]+)/)
  if (match && ERROR_MESSAGES[match[1]]) return ERROR_MESSAGES[match[1]]
  if (/row-level security|permission denied/i.test(message)) return '権限がありません。'
  if (/anonymous sign-ins are disabled/i.test(message)) return 'イベント参加用の匿名ログインが無効になっています（管理者向け：SupabaseでAnonymous Sign-insを有効にしてください）。'
  if (/invalid login credentials/i.test(message)) return 'メールアドレスまたはパスワードが違います。'
  return fallback
}

function client() {
  if (!supabase) throw new Error('walk_just:events_unavailable')
  return supabase
}

// ---------------------------------------------------------------- 機能の有無

let availability: Promise<boolean> | null = null

/** イベント用テーブルが存在するか（migration 未実行・Supabase未設定なら false。通常モードには影響しない） */
export function eventsAvailable(): Promise<boolean> {
  if (!supabase) return Promise.resolve(false)
  availability ??= Promise.resolve(
    supabase.from('walk_just_events').select('id', { head: true, count: 'exact' }).limit(1),
  ).then(({ error }) => !error).catch(() => false)
  return availability
}

// ---------------------------------------------------------------- 認証

/** 参加者のセッション（なければSupabase匿名ログイン）。返り値は auth.uid() */
export async function ensureParticipantSession(): Promise<string> {
  const sb = client()
  const { data } = await sb.auth.getSession()
  if (data.session?.user) return data.session.user.id
  const { data: signedIn, error } = await sb.auth.signInAnonymously()
  if (error || !signedIn.user) throw error ?? new Error('walk_just:not_authenticated')
  return signedIn.user.id
}

export async function currentUserId(): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  return data.session?.user.id ?? null
}

export async function currentUserEmail(): Promise<string | null> {
  if (!supabase) return null
  const { data } = await supabase.auth.getSession()
  const user = data.session?.user
  return user && !user.is_anonymous ? user.email ?? null : null
}

export async function adminSignIn(email: string, password: string): Promise<void> {
  const { error } = await client().auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw error
}

export async function adminSignOut(): Promise<void> {
  const { error } = await client().auth.signOut()
  if (error) throw error
}

/** サーバー側（walk_just_admins + RLS）で管理者かどうかを確認する。表示の切り替えにのみ使い、権限はDBが判定する */
export async function checkIsAdmin(): Promise<boolean> {
  if (!supabase) return false
  const { data: session } = await supabase.auth.getSession()
  if (!session.session || session.session.user.is_anonymous) return false
  const { data, error } = await supabase.rpc('walk_just_is_admin')
  if (error) return false
  return data === true
}

// ---------------------------------------------------------------- 参加者

export async function listEvents(): Promise<WalkEvent[]> {
  const { data, error } = await client().from('walk_just_events').select('*').order('starts_at', { ascending: false }).limit(100)
  if (error) throw error
  return (data ?? []) as WalkEvent[]
}

export async function getEvent(eventId: string): Promise<WalkEvent | null> {
  const { data, error } = await client().from('walk_just_events').select('*').eq('id', eventId).maybeSingle()
  if (error) throw error
  return (data as WalkEvent | null) ?? null
}

/** 自分のエントリー（未ログインなら null。匿名ログインはしない） */
export async function getMyEntry(eventId: string): Promise<EventEntry | null> {
  const uid = await currentUserId()
  if (!uid) return null
  const { data, error } = await client().from('walk_just_event_entries').select('*').eq('event_id', eventId).eq('user_id', uid).maybeSingle()
  if (error) throw error
  return (data as EventEntry | null) ?? null
}

export async function getMyResults(eventId: string): Promise<EventResult[]> {
  const uid = await currentUserId()
  if (!uid) return []
  const { data, error } = await client().from('walk_just_event_results').select('*').eq('event_id', eventId).eq('user_id', uid).order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as EventResult[]
}

export async function joinEvent(eventId: string, nickname: string, legacyAnonymousUserId: string): Promise<EventEntry> {
  await ensureParticipantSession()
  const { data, error } = await client().rpc('walk_just_join_event', {
    p_event_id: eventId,
    p_nickname: nickname,
    p_legacy_anonymous_user_id: legacyAnonymousUserId,
  })
  if (error) throw error
  return data as EventEntry
}

export async function startEventAttempt(eventId: string, mode: ChallengeMode): Promise<string> {
  await ensureParticipantSession()
  const { data, error } = await client().rpc('walk_just_start_event_attempt', { p_event_id: eventId, p_mode: mode })
  if (error) throw error
  return data as string
}

export async function submitEventResult(params: {
  attemptId: string
  targetDistanceM: number
  targetValue: number
  actualValue: number
  elapsedSeconds: number
}): Promise<EventResult> {
  const { data, error } = await client().rpc('walk_just_submit_event_result', {
    p_attempt_id: params.attemptId,
    p_target_distance_m: params.targetDistanceM,
    p_target_value: params.targetValue,
    p_actual_value: params.actualValue,
    p_elapsed_seconds: params.elapsedSeconds,
  })
  if (error) throw error
  return data as EventResult
}

export async function getEventRanking(eventId: string, mode: ChallengeMode): Promise<EventRankingRow[]> {
  const { data, error } = await client().rpc('walk_just_event_ranking', { p_event_id: eventId, p_mode: mode })
  if (error) throw error
  return (data ?? []) as EventRankingRow[]
}

// ---------------------------------------------------------------- 管理者（権限はDBのRLS・関数で判定）

export async function createEvent(input: EventInput): Promise<WalkEvent> {
  const { data, error } = await client().from('walk_just_events').insert(input).select('*').single()
  if (error) throw error
  return data as WalkEvent
}

export async function updateEvent(eventId: string, input: Partial<EventInput>): Promise<WalkEvent> {
  const { data, error } = await client().from('walk_just_events').update(input).eq('id', eventId).select('*').single()
  if (error) throw error
  return data as WalkEvent
}

export async function endEvent(eventId: string): Promise<WalkEvent> {
  // 終了日時はDBのトリガーがサーバー時刻で設定する
  const { data, error } = await client().from('walk_just_events').update({ ended_at: new Date().toISOString() }).eq('id', eventId).select('*').single()
  if (error) throw error
  return data as WalkEvent
}

export async function listEntries(eventId: string): Promise<EventEntry[]> {
  const { data, error } = await client().from('walk_just_event_entries').select('*').eq('event_id', eventId).order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as EventEntry[]
}

export async function setEntryStatus(entryId: string, status: EntryStatus): Promise<EventEntry> {
  const { data, error } = await client().rpc('walk_just_set_entry_status', { p_entry_id: entryId, p_status: status })
  if (error) throw error
  return data as EventEntry
}
