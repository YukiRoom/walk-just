import { useState } from 'react'
import type { GpsDebugInfo } from '../hooks/useWalkTracker'
import type { WakeLockInfo } from '../hooks/useScreenWakeLock'
import { isStandalone } from '../lib/platform'
import { gpsTestLogsToCsv, readGpsTestLogs, saveGpsTestLog, type GpsTestLog } from '../lib/gpsTestLogs'
import type { ChallengeMode } from '../types'

type Props = {
  mode: ChallengeMode
  targetDistanceM: number
  measuredDistanceM: number
  elapsedMs: number
  debugInfo: GpsDebugInfo
  wakeLock?: WakeLockInfo
}

type Draft = {
  referenceDistanceM: string
  goalErrorM: string
  deviceMemo: string
  screenLockUsed: boolean
  comment: string
}

const EMPTY_DRAFT: Draft = {
  referenceDistanceM: '',
  goalErrorM: '',
  deviceMemo: '',
  screenLockUsed: false,
  comment: '',
}

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function displayMode(): 'browser' | 'PWA' {
  return isStandalone() ? 'PWA' : 'browser'
}

function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function GpsTestTools({ mode, targetDistanceM, measuredDistanceM, elapsedMs, debugInfo, wakeLock }: Props) {
  const [formOpen, setFormOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [logs, setLogs] = useState<GpsTestLog[]>(() => readGpsTestLogs())
  const [notice, setNotice] = useState<string | null>(null)

  function save(): void {
    const referenceDistanceM = optionalNumber(draft.referenceDistanceM)
    const goalErrorM = optionalNumber(draft.goalErrorM)
    if ((draft.referenceDistanceM && referenceDistanceM === null) || (referenceDistanceM !== null && referenceDistanceM < 0) ||
      (draft.goalErrorM && goalErrorM === null)) {
      setNotice('距離と誤差は数値で入力してください。')
      return
    }

    const log: GpsTestLog = {
      id: newId(),
      challengeMode: mode,
      targetDistanceM,
      measuredDistanceM,
      elapsedMs,
      gpsAccuracyM: debugInfo.accuracyM,
      acceptedGpsPoints: debugInfo.acceptedPoints,
      rejectedGpsPoints: debugInfo.rejectedPoints,
      latestSegmentDistanceM: debugInfo.latestSegmentM,
      averageAccuracyM: debugInfo.averageAccuracyM,
      maximumAccuracyM: debugInfo.maximumAccuracyM,
      minimumAccuracyM: debugInfo.minimumAccuracyM,
      testDateTime: new Date().toISOString(),
      userAgent: navigator.userAgent,
      displayMode: displayMode(),
      visibilityChangesCount: debugInfo.visibilityChanges,
      wakeLockSupported: wakeLock?.supported ?? null,
      wakeLockState: wakeLock?.state ?? null,
      wakeLockAcquireCount: wakeLock?.acquireCount ?? null,
      wakeLockReleaseCount: wakeLock?.releaseCount ?? null,
      referenceDistanceM,
      goalErrorM,
      deviceMemo: draft.deviceMemo.trim(),
      screenLockUsed: draft.screenLockUsed,
      comment: draft.comment.trim(),
    }
    setLogs(saveGpsTestLog(log))
    setDraft(EMPTY_DRAFT)
    setFormOpen(false)
    setNotice('テストログを保存しました。')
  }

  const csvHref = logs.length > 0 ? `data:text/csv;charset=utf-8,${encodeURIComponent(gpsTestLogsToCsv(logs))}` : null
  const csvFilename = `walk-just-gps-tests-${new Date().toISOString().slice(0, 10)}.csv`

  return (
    <div className="gps-test-tools">
      <div className="gps-test-actions">
        <button type="button" onClick={() => { setFormOpen((open) => !open); setNotice(null) }}>テストログ保存</button>
        <button type="button" onClick={() => setHistoryOpen((open) => !open)}>過去ログ ({logs.length})</button>
        {csvHref ? <a href={csvHref} download={csvFilename}>CSV出力</a> : <button type="button" disabled>CSV出力</button>}
      </div>

      {notice && <p className="gps-test-notice" role="status">{notice}</p>}

      {formOpen && (
        <div className="gps-test-form">
          <label>実際の基準距離（m）<input type="number" min="0" step="0.1" inputMode="decimal" value={draft.referenceDistanceM} onChange={(event) => setDraft({ ...draft, referenceDistanceM: event.target.value })} /></label>
          <label>ゴール地点の誤差（m）<input type="number" step="0.1" inputMode="decimal" value={draft.goalErrorM} onChange={(event) => setDraft({ ...draft, goalErrorM: event.target.value })} /></label>
          <label>端末メモ<input maxLength={120} placeholder="例：iPhone 15 / iOS 18" value={draft.deviceMemo} onChange={(event) => setDraft({ ...draft, deviceMemo: event.target.value })} /></label>
          <label className="gps-test-checkbox"><input type="checkbox" checked={draft.screenLockUsed} onChange={(event) => setDraft({ ...draft, screenLockUsed: event.target.checked })} />画面ロックあり</label>
          <label>コメント<textarea maxLength={500} value={draft.comment} onChange={(event) => setDraft({ ...draft, comment: event.target.value })} /></label>
          <button type="button" className="gps-test-save" onClick={save}>この内容で保存</button>
        </div>
      )}

      {historyOpen && (
        <div className="gps-test-history">
          {logs.length === 0 ? <p>保存済みログはありません。</p> : logs.map((log) => (
            <article key={log.id}>
              <strong>{new Date(log.testDateTime).toLocaleString('ja-JP')} · {log.challengeMode.toUpperCase()}</strong>
              <span>計測 {log.measuredDistanceM.toFixed(1)}m / 目標 {log.targetDistanceM.toFixed(1)}m</span>
              <span>accuracy 平均 {log.averageAccuracyM?.toFixed(1) ?? '—'}m · 採用/除外 {log.acceptedGpsPoints}/{log.rejectedGpsPoints}</span>
              {log.wakeLockState != null && <span>WakeLock {log.wakeLockSupported ? '対応' : '非対応'} · {log.wakeLockState} · 取得/解除 {log.wakeLockAcquireCount ?? 0}/{log.wakeLockReleaseCount ?? 0} · 表示変化 {log.visibilityChangesCount}</span>}
              <span>基準距離 {log.referenceDistanceM?.toFixed(1) ?? '—'}m · ゴール誤差 {log.goalErrorM?.toFixed(1) ?? '—'}m</span>
              {(log.deviceMemo || log.comment) && <small>{[log.deviceMemo, log.comment].filter(Boolean).join(' / ')}</small>}
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
