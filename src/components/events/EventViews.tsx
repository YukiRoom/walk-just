import { useCallback, useEffect, useState } from 'react'
import { formatTime } from '../../lib/format'
import {
  eventAllowsMode, eventErrorMessage, eventModes, eventPhase, fixedTarget, getEvent, getEventRanking, getMyEntry, getMyResults,
  joinEvent, listEvents, rankingHidden,
  type EventEntry, type EventRankingRow, type EventResult, type WalkEvent,
} from '../../lib/events'
import type { ChallengeMode } from '../../types'

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

const PHASE_LABEL = { upcoming: '開催前', open: '開催中', ended: '終了' } as const
const MODE_LABEL: Record<ChallengeMode, string> = { time: 'TIME', steps: 'STEP' }

function targetText(mode: ChallengeMode, distanceM: number, value: number): string {
  return `${(distanceM / 1000).toFixed(2)}km ／ ${mode === 'time' ? formatTime(value * 1000) : `${value.toLocaleString()}歩`}`
}

export function PhaseBadge({ event }: { event: WalkEvent }) {
  const phase = eventPhase(event)
  return <span className={`phase-badge ${phase}`}>{PHASE_LABEL[phase]}</span>
}

export function EventRules({ event }: { event: WalkEvent }) {
  return (
    <dl className="event-rules">
      <div><dt>開催</dt><dd>{formatDateTime(event.starts_at)} 〜 {formatDateTime(event.ends_at)}</dd></div>
      <div><dt>エントリー締切</dt><dd>{formatDateTime(event.entry_deadline)}</dd></div>
      <div><dt>種目</dt><dd>{eventModes(event).map((mode) => MODE_LABEL[mode]).join(' / ')}</dd></div>
      <div><dt>目標</dt><dd>{event.target_mode === 'fixed'
        ? eventModes(event).map((mode) => {
          const target = fixedTarget(event, mode)
          return target ? <span key={mode} className="block">{MODE_LABEL[mode]}：{targetText(mode, target.distanceM, target.value)}</span> : null
        })
        : '参加者が自分で設定'}</dd></div>
      <div><dt>参加方式</dt><dd>{event.entry_mode === 'open' ? '自由参加' : '承認制'}</dd></div>
      <div><dt>挑戦回数</dt><dd>{event.attempt_policy === 'single' ? '1回のみ' : '複数回（ベスト記録を採用）'}</dd></div>
      <div><dt>ランキング</dt><dd>{event.ranking_visibility === 'realtime' ? 'リアルタイム公開' : '終了後に公開'}</dd></div>
    </dl>
  )
}

export function EventList({ onOpen, onBack }: { onOpen: (event: WalkEvent) => void; onBack: () => void }) {
  const [events, setEvents] = useState<WalkEvent[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    listEvents().then(setEvents).catch((error: unknown) => { setEvents([]); setMessage(eventErrorMessage(error)) })
  }, [])

  const visible = (events ?? []).filter((event) => eventPhase(event) !== 'ended')
  const ended = (events ?? []).filter((event) => eventPhase(event) === 'ended').slice(0, 10)

  return (
    <section className="panel">
      <button className="text-button" onClick={onBack}>← 戻る</button>
      <div className="eyebrow">EVENTS</div>
      <h2>イベント</h2>
      {message && <p className="error" role="alert">{message}</p>}
      {events === null && <p className="empty">読み込み中…</p>}
      {events !== null && visible.length === 0 && !message && <p className="empty">開催中・開催予定のイベントはありません。</p>}
      <div className="event-list">
        {visible.map((event) => (
          <button key={event.id} className="event-card" onClick={() => onOpen(event)}>
            <PhaseBadge event={event} />
            <strong>{event.name}</strong>
            <small>{formatDateTime(event.starts_at)} 〜 {formatDateTime(event.ends_at)}</small>
          </button>
        ))}
      </div>
      {ended.length > 0 && (
        <>
          <h3 className="section-title">終了したイベント</h3>
          <div className="event-list">
            {ended.map((event) => (
              <button key={event.id} className="event-card ended" onClick={() => onOpen(event)}>
                <PhaseBadge event={event} />
                <strong>{event.name}</strong>
                <small>{formatDateTime(event.ends_at)} 終了</small>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

type DetailProps = {
  eventId: string
  nickname: string
  anonymousUserId: string
  onChallenge: (event: WalkEvent, mode: ChallengeMode) => void
  onRanking: (event: WalkEvent) => void
  onBack: () => void
}

export function EventDetail({ eventId, nickname, anonymousUserId, onChallenge, onRanking, onBack }: DetailProps) {
  const [event, setEvent] = useState<WalkEvent | null | undefined>(undefined)
  const [entry, setEntry] = useState<EventEntry | null>(null)
  const [results, setResults] = useState<EventResult[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const loaded = await getEvent(eventId)
      setEvent(loaded)
      if (!loaded) return
      const [myEntry, myResults] = await Promise.all([getMyEntry(eventId), getMyResults(eventId)])
      setEntry(myEntry)
      setResults(myResults)
    } catch (error) {
      setEvent((current) => current ?? null)
      setMessage(eventErrorMessage(error))
    }
  }, [eventId])

  useEffect(() => { void reload() }, [reload])

  async function enter(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      setEntry(await joinEvent(eventId, nickname, anonymousUserId))
    } catch (error) {
      setMessage(eventErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  if (event === undefined) return <section className="panel"><p className="empty">読み込み中…</p></section>
  if (event === null) {
    return (
      <section className="panel">
        <button className="text-button" onClick={onBack}>← 戻る</button>
        <h2>イベントが見つかりません</h2>
        {message && <p className="error" role="alert">{message}</p>}
      </section>
    )
  }

  const phase = eventPhase(event)
  const entryOpen = phase !== 'ended' && Date.now() <= Date.parse(event.entry_deadline)

  return (
    <section className="panel event-detail">
      <button className="text-button" onClick={onBack}>← 戻る</button>
      <div className="eyebrow">EVENT</div>
      <div className="event-title"><h2>{event.name}</h2><PhaseBadge event={event} /></div>
      {event.description && <p className="event-description">{event.description}</p>}
      <EventRules event={event} />

      <div className="entry-box" aria-live="polite">
        {!entry && (entryOpen ? (
          <>
            <p>「<strong>{nickname}</strong>」でエントリーします。</p>
            <button className="primary" disabled={busy} onClick={() => void enter()}>{busy ? 'エントリー中…' : 'エントリーする'}</button>
            <small className="note">この端末で参加者として登録されます（メールアドレス等は不要）。</small>
          </>
        ) : <p className="muted">エントリーの受付は終了しました。</p>)}
        {entry?.status === 'pending' && <p className="entry-status pending">⏳ 承認待ちです。主催者の承認後に挑戦できます。</p>}
        {entry?.status === 'rejected' && <p className="entry-status rejected">参加が承認されませんでした。</p>}
        {entry?.status === 'approved' && (
          <>
            <p className="entry-status approved">✅ エントリー済み（{entry.nickname}）</p>
            {entry.nickname !== nickname && (
              <button className="text-button small-link" disabled={busy} onClick={() => void enter()}>表示名を「{nickname}」に更新</button>
            )}
            {phase === 'upcoming' && <p className="muted">開始（{formatDateTime(event.starts_at)}）までお待ちください。</p>}
            {phase === 'open' && (
              <div className="grid event-challenges">
                {eventModes(event).map((mode) => {
                  const done = event.attempt_policy === 'single' && results.some((result) => result.mode === mode)
                  return (
                    <button key={mode} className="mode-card" disabled={done || !eventAllowsMode(event, mode)} onClick={() => onChallenge(event, mode)}>
                      <strong>{mode === 'time' ? '⏱ TIME' : '👟 STEP'}で挑戦</strong>
                      <span>{done ? '挑戦済み' : event.attempt_policy === 'best' ? '何度でも挑戦できます（ベスト採用）' : '1回だけ挑戦できます'}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>

      {results.length > 0 && (
        <div className="my-results">
          <h3 className="section-title">あなたの記録</h3>
          <ul>{results.map((result) => (
            <li key={result.id}>
              <span>{MODE_LABEL[result.mode]}</span>
              <span>誤差 {result.error_value}{result.mode === 'time' ? '秒' : '歩'}</span>
              <small>{formatDateTime(result.created_at)}</small>
            </li>
          ))}</ul>
        </div>
      )}
      {message && <p className="error" role="alert">{message}</p>}
      <button className="secondary full" onClick={() => onRanking(event)}>イベントランキングを見る</button>
    </section>
  )
}

export function EventRanking({ event, isAdmin, initialMode, onBack }: { event: WalkEvent; isAdmin: boolean; initialMode?: ChallengeMode; onBack: () => void }) {
  const modes = eventModes(event)
  const [mode, setMode] = useState<ChallengeMode>(initialMode && modes.includes(initialMode) ? initialMode : modes[0])
  const [rows, setRows] = useState<EventRankingRow[] | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const hidden = rankingHidden(event, isAdmin)

  useEffect(() => {
    if (hidden) return
    setRows(null)
    setMessage(null)
    getEventRanking(event.id, mode).then(setRows).catch((error: unknown) => { setRows([]); setMessage(eventErrorMessage(error)) })
  }, [event.id, mode, hidden])

  return (
    <section className="panel ranking-panel">
      <button className="text-button" onClick={onBack}>← 戻る</button>
      <div className="eyebrow">EVENT RANKING</div>
      <h2>{event.name}</h2>
      {modes.length > 1 && (
        <div className="tabs">
          {modes.map((item) => <button key={item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>{item === 'time' ? 'TIME' : 'STEPS'}</button>)}
        </div>
      )}
      <p className="muted ranking-caption">{mode === 'time' ? '目標タイムとの誤差' : '目標歩数との誤差'}が小さい順{event.attempt_policy === 'best' ? '（各参加者のベスト記録）' : ''}</p>
      {hidden ? <p className="empty">ランキングはイベント終了後に公開されます。</p> : (
        <>
          {message && <p className="error" role="alert">{message}</p>}
          <ol className="ranking-list">{(rows ?? []).map((row) => (
            <li key={`${row.rank}-${row.nickname}`} className={row.is_me ? 'mine' : undefined}>
              <b>#{row.rank}</b>
              <div>
                <strong>{row.nickname}{row.is_me && <em className="you-badge">YOU</em>}</strong>
                <small>目標 {targetText(mode, row.target_distance_m, row.target_value)}</small>
                <small>実績 {mode === 'time' ? formatTime(row.actual_value * 1000) : `${row.actual_value.toLocaleString()}歩`}{row.attempts > 1 ? `（${row.attempts}回挑戦）` : ''}</small>
              </div>
              <span className="rank-error">±{row.error_value}{mode === 'time' ? '秒' : '歩'}</span>
            </li>
          ))}</ol>
          {rows === null && <p className="empty">読み込み中…</p>}
          {rows !== null && rows.length === 0 && !message && <p className="empty">まだ記録がありません。</p>}
        </>
      )}
    </section>
  )
}
