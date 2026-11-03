import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import {
  adminSignIn, adminSignOut, checkIsAdmin, createEvent, currentUserEmail, endEvent, eventErrorMessage, eventUrl, listEntries, listEvents,
  setEntryStatus, updateEvent,
  type EntryStatus, type EventEntry, type EventInput, type WalkEvent,
} from '../../lib/events'
import { EventRanking, EventRules, PhaseBadge, formatDateTime } from './EventViews'

type Draft = {
  name: string
  description: string
  startsAt: string
  endsAt: string
  entryDeadline: string
  modes: EventInput['modes']
  entryMode: EventInput['entry_mode']
  targetMode: EventInput['target_mode']
  rankingVisibility: EventInput['ranking_visibility']
  attemptPolicy: EventInput['attempt_policy']
  timeDistanceKm: string
  timeMin: string
  timeSec: string
  stepsDistanceKm: string
  steps: string
}

function toLocalInput(iso: string): string {
  const date = new Date(iso)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

function defaultDraft(): Draft {
  const start = new Date()
  start.setMinutes(0, 0, 0)
  start.setHours(start.getHours() + 1)
  const end = new Date(start.getTime() + 3 * 3600_000)
  return {
    name: '', description: '', startsAt: toLocalInput(start.toISOString()), endsAt: toLocalInput(end.toISOString()), entryDeadline: toLocalInput(end.toISOString()),
    modes: 'both', entryMode: 'open', targetMode: 'personal', rankingVisibility: 'realtime', attemptPolicy: 'single',
    timeDistanceKm: '1', timeMin: '12', timeSec: '0', stepsDistanceKm: '1', steps: '1300',
  }
}

function draftFromEvent(event: WalkEvent): Draft {
  return {
    name: event.name, description: event.description,
    startsAt: toLocalInput(event.starts_at), endsAt: toLocalInput(event.ends_at), entryDeadline: toLocalInput(event.entry_deadline),
    modes: event.modes, entryMode: event.entry_mode, targetMode: event.target_mode, rankingVisibility: event.ranking_visibility, attemptPolicy: event.attempt_policy,
    timeDistanceKm: event.time_target_distance_m === null ? '1' : String(event.time_target_distance_m / 1000),
    timeMin: event.time_target_seconds === null ? '12' : String(Math.floor(event.time_target_seconds / 60)),
    timeSec: event.time_target_seconds === null ? '0' : String(event.time_target_seconds % 60),
    stepsDistanceKm: event.steps_target_distance_m === null ? '1' : String(event.steps_target_distance_m / 1000),
    steps: event.steps_target_steps === null ? '1300' : String(event.steps_target_steps),
  }
}

/** 入力を検証してDBへ送る形に変換する（最終的な検証はDBの制約が行う） */
function draftToInput(draft: Draft): EventInput | string {
  const name = draft.name.trim()
  if (!name || name.length > 80) return 'イベント名は1〜80文字で入力してください。'
  if (draft.description.length > 2000) return '説明は2000文字以内で入力してください。'
  const startsAt = new Date(draft.startsAt)
  const endsAt = new Date(draft.endsAt)
  const deadline = new Date(draft.entryDeadline)
  if ([startsAt, endsAt, deadline].some((date) => Number.isNaN(date.getTime()))) return '日時を入力してください。'
  if (startsAt >= endsAt) return '終了日時は開始日時より後にしてください。'
  if (deadline > endsAt) return 'エントリー締切は終了日時以前にしてください。'
  const fixed = draft.targetMode === 'fixed'
  const useTime = fixed && draft.modes !== 'steps'
  const useSteps = fixed && draft.modes !== 'time'
  const timeDistance = Math.round(Number(draft.timeDistanceKm) * 1000)
  const timeSeconds = Number(draft.timeMin) * 60 + Number(draft.timeSec)
  const stepsDistance = Math.round(Number(draft.stepsDistanceKm) * 1000)
  const steps = Number(draft.steps)
  if (useTime && (!Number.isFinite(timeDistance) || timeDistance < 100 || timeDistance > 100000)) return 'TIMEの目標距離は0.1〜100kmで入力してください。'
  if (useTime && (!Number.isInteger(timeSeconds) || timeSeconds < 1 || timeSeconds > 86400 || Number(draft.timeSec) > 59)) return 'TIMEの目標タイムを正しく入力してください。'
  if (useSteps && (!Number.isFinite(stepsDistance) || stepsDistance < 100 || stepsDistance > 100000)) return 'STEPの目標距離は0.1〜100kmで入力してください。'
  if (useSteps && (!Number.isInteger(steps) || steps < 1 || steps > 1000000)) return 'STEPの目標歩数を正しく入力してください。'
  return {
    name, description: draft.description.trim(),
    starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), entry_deadline: deadline.toISOString(),
    modes: draft.modes, entry_mode: draft.entryMode, target_mode: draft.targetMode,
    ranking_visibility: draft.rankingVisibility, attempt_policy: draft.attemptPolicy,
    time_target_distance_m: useTime ? timeDistance : null,
    time_target_seconds: useTime ? timeSeconds : null,
    steps_target_distance_m: useSteps ? stepsDistance : null,
    steps_target_steps: useSteps ? steps : null,
  }
}

/** 変更された項目だけを送る（記録があるイベントでは競技ルールの変更がDBで拒否されるため） */
function changedFields(event: WalkEvent, input: EventInput): Partial<EventInput> {
  const changed: Partial<EventInput> = {}
  for (const key of Object.keys(input) as (keyof EventInput)[]) {
    const before = event[key]
    const after = input[key]
    const same = key.endsWith('_at') || key === 'entry_deadline'
      ? Date.parse(String(before)) === Date.parse(String(after))
      : before === after
    if (!same) Object.assign(changed, { [key]: after })
  }
  return changed
}

function EventForm({ initial, submitLabel, onSubmit, onCancel }: { initial: Draft; submitLabel: string; onSubmit: (input: EventInput) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }))

  async function submit(): Promise<void> {
    const input = draftToInput(draft)
    if (typeof input === 'string') {
      setMessage(input)
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await onSubmit(input)
    } catch (error) {
      setMessage(eventErrorMessage(error, '保存できませんでした。'))
    } finally {
      setBusy(false)
    }
  }

  const fixed = draft.targetMode === 'fixed'
  return (
    <form className="event-form" onSubmit={(event) => { event.preventDefault(); void submit() }} noValidate>
      <label>イベント名<input value={draft.name} maxLength={80} onChange={(event) => set('name', event.target.value)} /></label>
      <label>説明<textarea value={draft.description} maxLength={2000} rows={3} onChange={(event) => set('description', event.target.value)} /></label>
      <label>開始日時<input type="datetime-local" value={draft.startsAt} onChange={(event) => set('startsAt', event.target.value)} /></label>
      <label>終了日時<input type="datetime-local" value={draft.endsAt} onChange={(event) => set('endsAt', event.target.value)} /></label>
      <label>エントリー締切<input type="datetime-local" value={draft.entryDeadline} onChange={(event) => set('entryDeadline', event.target.value)} /></label>
      <label>種目<select value={draft.modes} onChange={(event) => set('modes', event.target.value as Draft['modes'])}>
        <option value="both">TIME / STEP 両方</option><option value="time">TIMEのみ</option><option value="steps">STEPのみ</option>
      </select></label>
      <label>参加方式<select value={draft.entryMode} onChange={(event) => set('entryMode', event.target.value as Draft['entryMode'])}>
        <option value="open">自由参加（エントリーで即参加）</option><option value="approval">承認制（主催者が承認）</option>
      </select></label>
      <label>目標方式<select value={draft.targetMode} onChange={(event) => set('targetMode', event.target.value as Draft['targetMode'])}>
        <option value="personal">個人目標（参加者が設定）</option><option value="fixed">統一目標（主催者が設定）</option>
      </select></label>
      {fixed && draft.modes !== 'steps' && (
        <fieldset className="target-fieldset"><legend>TIME の統一目標</legend>
          <label>目標距離（km）<input type="number" inputMode="decimal" min="0.1" step="0.1" value={draft.timeDistanceKm} onChange={(event) => set('timeDistanceKm', event.target.value)} /></label>
          <div className="row">
            <label className="grow">分<input type="number" inputMode="numeric" min="0" value={draft.timeMin} onChange={(event) => set('timeMin', event.target.value)} /></label>
            <label className="grow">秒<input type="number" inputMode="numeric" min="0" max="59" value={draft.timeSec} onChange={(event) => set('timeSec', event.target.value)} /></label>
          </div>
        </fieldset>
      )}
      {fixed && draft.modes !== 'time' && (
        <fieldset className="target-fieldset"><legend>STEP の統一目標</legend>
          <label>目標距離（km）<input type="number" inputMode="decimal" min="0.1" step="0.1" value={draft.stepsDistanceKm} onChange={(event) => set('stepsDistanceKm', event.target.value)} /></label>
          <label>目標歩数<input type="number" inputMode="numeric" min="1" value={draft.steps} onChange={(event) => set('steps', event.target.value)} /></label>
        </fieldset>
      )}
      <label>ランキング公開<select value={draft.rankingVisibility} onChange={(event) => set('rankingVisibility', event.target.value as Draft['rankingVisibility'])}>
        <option value="realtime">リアルタイム</option><option value="after_end">終了後</option>
      </select></label>
      <label>挑戦回数<select value={draft.attemptPolicy} onChange={(event) => set('attemptPolicy', event.target.value as Draft['attemptPolicy'])}>
        <option value="single">1回のみ</option><option value="best">複数回（ベスト採用）</option>
      </select></label>
      {message && <p className="error" role="alert">{message}</p>}
      <button className="primary" type="submit" disabled={busy}>{busy ? '保存中…' : submitLabel}</button>
      <button className="secondary full" type="button" onClick={onCancel}>キャンセル</button>
    </form>
  )
}

function ShareBox({ event }: { event: WalkEvent }) {
  const url = eventUrl(event.id)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 240 }).then(setQr).catch(() => setQr(null))
  }, [url])
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="share-box">
      <h3 className="section-title">参加用URL / QR</h3>
      {qr && <img className="event-qr" src={qr} alt={`${event.name} の参加用QRコード`} width={200} height={200} />}
      <input className="share-url" readOnly value={url} onFocus={(focusEvent) => focusEvent.target.select()} aria-label="参加用URL" />
      <div className="row">
        <button className="secondary grow" type="button" onClick={() => void copy()}>{copied ? 'コピーしました' : 'URLをコピー'}</button>
        {qr && <a className="secondary grow download-link" href={qr} download={`walk-just-event-qr.png`}>QR画像を保存</a>}
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<EntryStatus, string> = { pending: '承認待ち', approved: '承認済み', rejected: '却下' }

function EntriesBox({ event }: { event: WalkEvent }) {
  const [entries, setEntries] = useState<EventEntry[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const load = useCallback(() => {
    listEntries(event.id).then(setEntries).catch((error: unknown) => { setEntries([]); setMessage(eventErrorMessage(error)) })
  }, [event.id])
  useEffect(load, [load])

  async function decide(entry: EventEntry, status: EntryStatus): Promise<void> {
    setMessage(null)
    try {
      const updated = await setEntryStatus(entry.id, status)
      setEntries((current) => (current ?? []).map((item) => (item.id === updated.id ? updated : item)))
    } catch (error) {
      setMessage(eventErrorMessage(error))
    }
  }

  const pending = (entries ?? []).filter((entry) => entry.status === 'pending').length
  return (
    <div className="entries-box">
      <h3 className="section-title">エントリー（{entries?.length ?? 0}人{pending ? `・承認待ち ${pending}人` : ''}）</h3>
      {message && <p className="error" role="alert">{message}</p>}
      <ul className="entry-list">
        {(entries ?? []).map((entry) => (
          <li key={entry.id}>
            <div><strong>{entry.nickname}</strong><small>{formatDateTime(entry.created_at)} ・ <span className={`entry-chip ${entry.status}`}>{STATUS_LABEL[entry.status]}</span></small></div>
            <div className="entry-actions">
              {entry.status !== 'approved' && <button type="button" onClick={() => void decide(entry, 'approved')}>承認</button>}
              {entry.status !== 'rejected' && <button type="button" className="reject" onClick={() => void decide(entry, 'rejected')}>却下</button>}
            </div>
          </li>
        ))}
      </ul>
      {entries !== null && entries.length === 0 && <p className="empty">まだエントリーはありません。</p>}
      <button className="text-button small-link" type="button" onClick={load}>再読み込み</button>
    </div>
  )
}

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'manage'; event: WalkEvent } | { kind: 'edit'; event: WalkEvent } | { kind: 'ranking'; event: WalkEvent }

export function AdminPanel({ onExit }: { onExit: () => void }) {
  const [auth, setAuth] = useState<{ email: string | null; isAdmin: boolean } | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [events, setEvents] = useState<WalkEvent[]>([])
  const [view, setView] = useState<View>({ kind: 'list' })

  const refreshAuth = useCallback(async () => {
    const [signedInEmail, isAdmin] = await Promise.all([currentUserEmail(), checkIsAdmin()])
    setAuth({ email: signedInEmail, isAdmin })
    if (isAdmin) setEvents(await listEvents())
  }, [])

  useEffect(() => { refreshAuth().catch(() => setAuth({ email: null, isAdmin: false })) }, [refreshAuth])

  async function signIn(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      await adminSignIn(email, password)
      setPassword('')
      await refreshAuth()
    } catch (error) {
      setMessage(eventErrorMessage(error, 'ログインできませんでした。'))
    } finally {
      setBusy(false)
    }
  }

  async function signOut(): Promise<void> {
    await adminSignOut().catch(() => undefined)
    setView({ kind: 'list' })
    await refreshAuth()
  }

  function replaceEvent(updated: WalkEvent): void {
    setEvents((current) => [updated, ...current.filter((item) => item.id !== updated.id)])
    setView({ kind: 'manage', event: updated })
  }

  async function finish(event: WalkEvent): Promise<void> {
    if (!window.confirm(`「${event.name}」を終了しますか？終了後は新しい挑戦・エントリーができなくなり、再開できません。`)) return
    setMessage(null)
    try {
      replaceEvent(await endEvent(event.id))
    } catch (error) {
      setMessage(eventErrorMessage(error))
    }
  }

  if (auth === null) return <section className="panel"><p className="empty">読み込み中…</p></section>

  if (!auth.isAdmin) {
    return (
      <section className="panel">
        <button className="text-button" onClick={onExit}>← アプリに戻る</button>
        <div className="eyebrow">ADMIN</div>
        <h2>管理者ログイン</h2>
        {auth.email ? (
          <>
            <p>{auth.email} は WALK JUST! の管理者として登録されていません。</p>
            <button className="secondary full" onClick={() => void signOut()}>ログアウト</button>
          </>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void signIn() }} noValidate>
            <label>メールアドレス<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            <label>パスワード<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            {message && <p className="error" role="alert">{message}</p>}
            <button className="primary" type="submit" disabled={busy || !email || !password}>{busy ? 'ログイン中…' : 'ログイン'}</button>
            <p className="note">管理者用です。この端末で参加者としてエントリーしていた場合、ログイン中はその参加情報は使われません。</p>
          </form>
        )}
      </section>
    )
  }

  if (view.kind === 'create' || view.kind === 'edit') {
    return (
      <section className="panel">
        <div className="eyebrow">ADMIN</div>
        <h2>{view.kind === 'create' ? 'イベントを作成' : 'イベントを編集'}</h2>
        <EventForm
          initial={view.kind === 'edit' ? draftFromEvent(view.event) : defaultDraft()}
          submitLabel={view.kind === 'create' ? '作成する' : '保存する'}
          onSubmit={async (input) => replaceEvent(view.kind === 'edit' ? await updateEvent(view.event.id, changedFields(view.event, input)) : await createEvent(input))}
          onCancel={() => setView(view.kind === 'edit' ? { kind: 'manage', event: view.event } : { kind: 'list' })}
        />
      </section>
    )
  }

  if (view.kind === 'ranking') {
    return <EventRanking event={view.event} isAdmin onBack={() => setView({ kind: 'manage', event: view.event })} />
  }

  if (view.kind === 'manage') {
    const event = view.event
    return (
      <section className="panel event-detail">
        <button className="text-button" onClick={() => setView({ kind: 'list' })}>← イベント一覧</button>
        <div className="eyebrow">ADMIN</div>
        <div className="event-title"><h2>{event.name}</h2><PhaseBadge event={event} /></div>
        {event.description && <p className="event-description">{event.description}</p>}
        <EventRules event={event} />
        <ShareBox event={event} />
        <EntriesBox event={event} />
        {message && <p className="error" role="alert">{message}</p>}
        <button className="secondary full" onClick={() => setView({ kind: 'ranking', event })}>ランキング（管理者は終了前も閲覧可）</button>
        {!event.ended_at && <button className="secondary full" onClick={() => setView({ kind: 'edit', event })}>編集</button>}
        {!event.ended_at && <button className="danger" onClick={() => void finish(event)}>イベントを終了する</button>}
      </section>
    )
  }

  return (
    <section className="panel">
      <button className="text-button" onClick={onExit}>← アプリに戻る</button>
      <div className="eyebrow">ADMIN</div>
      <h2>イベント管理</h2>
      <p className="muted">{auth.email} でログイン中</p>
      <button className="primary" onClick={() => setView({ kind: 'create' })}>＋ 新しいイベント</button>
      <div className="event-list admin-event-list">
        {events.map((event) => (
          <button key={event.id} className="event-card" onClick={() => setView({ kind: 'manage', event })}>
            <PhaseBadge event={event} />
            <strong>{event.name}</strong>
            <small>{formatDateTime(event.starts_at)} 〜 {formatDateTime(event.ends_at)}</small>
          </button>
        ))}
      </div>
      {events.length === 0 && <p className="empty">イベントはまだありません。</p>}
      <button className="secondary full" onClick={() => void signOut()}>ログアウト</button>
    </section>
  )
}
