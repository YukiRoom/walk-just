import { formatTime } from '../lib/format'
import type { GpsDebugInfo } from '../hooks/useWalkTracker'
import type { WakeLockInfo } from '../hooks/useScreenWakeLock'
import { GpsTestTools } from './GpsTestTools'
import type { ChallengeMode } from '../types'

type Props = {
  mode: ChallengeMode
  distanceM: number
  targetDistanceM: number
  elapsedMs: number
  error: string | null
  debugInfo?: GpsDebugInfo
  wakeLock: WakeLockInfo
  onCancel: () => void
}

function value(value: number | null, digits: number, suffix = ''): string {
  return value === null ? '—' : `${value.toFixed(digits)}${suffix}`
}

const WAKE_LOCK_STATE_LABEL: Record<WakeLockInfo['state'], string> = {
  unsupported: '非対応', idle: '未取得', requesting: '取得中…', active: '取得中（有効）', released: '解除済み', failed: '取得失敗',
}

function GpsDebugPanel({ info, wakeLock }: { info: GpsDebugInfo; wakeLock: WakeLockInfo }) {
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
        <div><dt>WakeLock対応</dt><dd>{wakeLock.supported ? 'あり' : 'なし'}</dd></div>
        <div><dt>WakeLock状態</dt><dd>{WAKE_LOCK_STATE_LABEL[wakeLock.state]}</dd></div>
        <div><dt>WakeLock取得/解除</dt><dd>{wakeLock.acquireCount} / {wakeLock.releaseCount}</dd></div>
        {wakeLock.lastError && <div><dt>WakeLockエラー</dt><dd>{wakeLock.lastError}</dd></div>}
      </dl>
    </aside>
  )
}

export function TrackingDisplay({ mode, distanceM, targetDistanceM, elapsedMs, error, debugInfo, wakeLock, onCancel }: Props) {
  const wakeLockUnavailable = !wakeLock.supported || wakeLock.state === 'failed'
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
      {wakeLockUnavailable ? (
        <p className="screen-warning" role="alert">計測中は画面を消さないでください。<br />画面がロックされるとGPS計測が停止する場合があります。</p>
      ) : wakeLock.state === 'active' && (
        <p className="screen-note">画面の自動スリープを防止しています。電源ボタンで画面をロックしないでください。</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {debugInfo && <><GpsDebugPanel info={debugInfo} wakeLock={wakeLock} /><GpsTestTools mode={mode} targetDistanceM={targetDistanceM} measuredDistanceM={distanceM} elapsedMs={elapsedMs} debugInfo={debugInfo} wakeLock={wakeLock} /></>}
      <button className="danger" onClick={onCancel}>チャレンジを中止</button>
    </section>
  )
}
