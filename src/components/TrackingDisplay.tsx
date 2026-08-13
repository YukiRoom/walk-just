import { formatTime } from '../lib/format'
import type { GpsDebugInfo } from '../hooks/useWalkTracker'
import { GpsTestTools } from './GpsTestTools'
import type { ChallengeMode } from '../types'

type Props = {
  mode: ChallengeMode
  distanceM: number
  targetDistanceM: number
  elapsedMs: number
  error: string | null
  debugInfo?: GpsDebugInfo
  onCancel: () => void
}

function value(value: number | null, digits: number, suffix = ''): string {
  return value === null ? '—' : `${value.toFixed(digits)}${suffix}`
}

function GpsDebugPanel({ info }: { info: GpsDebugInfo }) {
  return (
    <aside className="gps-debug" aria-label="GPSデバッグ情報">
      <strong>GPS DEBUG</strong>
      <dl>
        <div><dt>accuracy</dt><dd>{value(info.accuracyM, 1, ' m')}</dd></div>
        <div><dt>緯度 / 経度</dt><dd>{value(info.latitude, 6)} / {value(info.longitude, 6)}</dd></div>
        <div><dt>採用 / 除外</dt><dd>{info.acceptedPoints} / {info.rejectedPoints}</dd></div>
        <div><dt>最新区間</dt><dd>{value(info.latestSegmentM, 2, ' m')}</dd></div>
        <div><dt>累積距離</dt><dd>{value(info.cumulativeDistanceM, 2, ' m')}</dd></div>
        <div><dt>現在速度</dt><dd>{value(info.speedMps, 2, ' m/s')}</dd></div>
        <div><dt>取得時刻</dt><dd>{info.timestamp === null ? '—' : new Date(info.timestamp).toLocaleTimeString('ja-JP')}</dd></div>
        <div><dt>精度 平/最大/最小</dt><dd>{value(info.averageAccuracyM, 1)} / {value(info.maximumAccuracyM, 1)} / {value(info.minimumAccuracyM, 1)} m</dd></div>
        <div><dt>表示状態変化</dt><dd>{info.visibilityChanges}</dd></div>
      </dl>
    </aside>
  )
}

export function TrackingDisplay({ mode, distanceM, targetDistanceM, elapsedMs, error, debugInfo, onCancel }: Props) {
  return (
    <section className="panel tracking" aria-live="polite">
      <div className="eyebrow">{mode === 'time' ? 'TIME CHALLENGE' : 'STEP CHALLENGE'}</div>
      <h2>チャレンジ中</h2>
      <div className="metric">
        <span>現在距離</span>
        <strong>{(distanceM / 1000).toFixed(3)} km</strong>
        <small>目標 {(targetDistanceM / 1000).toFixed(2)} km</small>
      </div>
      <progress value={distanceM} max={targetDistanceM} aria-label="距離の進捗" />
      <div className="metric subtle">
        <span>経過時間</span>
        <strong>{formatTime(elapsedMs)}</strong>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {debugInfo && <><GpsDebugPanel info={debugInfo} /><GpsTestTools mode={mode} targetDistanceM={targetDistanceM} measuredDistanceM={distanceM} elapsedMs={elapsedMs} debugInfo={debugInfo} /></>}
      <button className="danger" onClick={onCancel}>チャレンジを中止</button>
    </section>
  )
}
