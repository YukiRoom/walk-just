import type { ChallengeMode } from '../types'

export type GpsTestLog = {
  id: string
  challengeMode: ChallengeMode
  targetDistanceM: number
  measuredDistanceM: number
  elapsedMs: number
  gpsAccuracyM: number | null
  acceptedGpsPoints: number
  rejectedGpsPoints: number
  latestSegmentDistanceM: number
  averageAccuracyM: number | null
  maximumAccuracyM: number | null
  minimumAccuracyM: number | null
  testDateTime: string
  userAgent: string
  displayMode: 'browser' | 'PWA'
  visibilityChangesCount: number
  /** 以下は Wake Lock 対応後に追加（旧ログでは未定義） */
  wakeLockSupported?: boolean | null
  wakeLockState?: string | null
  wakeLockAcquireCount?: number | null
  wakeLockReleaseCount?: number | null
  /** 以下は GPS準備（ウォームアップ）対応後に追加（旧ログでは未定義） */
  warmupReadyMs?: number | null
  warmupTotalMs?: number | null
  warmupFixes?: number | null
  startAccuracyM?: number | null
  startedWhenReady?: boolean | null
  referenceDistanceM: number | null
  goalErrorM: number | null
  deviceMemo: string
  screenLockUsed: boolean
  comment: string
}

const STORAGE_KEY = 'walk-just-gps-test-logs-v1'

function isGpsTestLog(value: unknown): value is GpsTestLog {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && (item.challengeMode === 'time' || item.challengeMode === 'steps') &&
    typeof item.targetDistanceM === 'number' && typeof item.measuredDistanceM === 'number' &&
    typeof item.testDateTime === 'string'
}

export function readGpsTestLogs(): GpsTestLog[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isGpsTestLog) : []
  } catch {
    return []
  }
}

export function saveGpsTestLog(log: GpsTestLog): GpsTestLog[] {
  const logs = [log, ...readGpsTestLogs()].slice(0, 200)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(logs))
  return logs
}

function csvCell(value: string | number | boolean | null): string {
  if (value === null) return ''
  let text = String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function gpsTestLogsToCsv(logs: GpsTestLog[]): string {
  const headers = [
    'challenge_mode', 'target_distance_m', 'measured_distance_m', 'elapsed_ms', 'gps_accuracy_m',
    'accepted_gps_points', 'rejected_gps_points', 'latest_segment_distance_m', 'average_accuracy_m',
    'maximum_accuracy_m', 'minimum_accuracy_m', 'test_date_time', 'user_agent', 'display_mode',
    'visibility_changes_count', 'reference_distance_m', 'goal_error_m', 'device_memo', 'screen_lock_used', 'comment',
    'wake_lock_supported', 'wake_lock_state', 'wake_lock_acquire_count', 'wake_lock_release_count',
    'warmup_ready_ms', 'warmup_total_ms', 'warmup_fixes', 'start_accuracy_m', 'started_when_ready',
  ]
  const rows = logs.map((log) => [
    log.challengeMode, log.targetDistanceM, log.measuredDistanceM, log.elapsedMs, log.gpsAccuracyM,
    log.acceptedGpsPoints, log.rejectedGpsPoints, log.latestSegmentDistanceM, log.averageAccuracyM,
    log.maximumAccuracyM, log.minimumAccuracyM, log.testDateTime, log.userAgent, log.displayMode,
    log.visibilityChangesCount, log.referenceDistanceM, log.goalErrorM, log.deviceMemo, log.screenLockUsed, log.comment,
    log.wakeLockSupported ?? null, log.wakeLockState ?? null, log.wakeLockAcquireCount ?? null, log.wakeLockReleaseCount ?? null,
    log.warmupReadyMs ?? null, log.warmupTotalMs ?? null, log.warmupFixes ?? null, log.startAccuracyM ?? null, log.startedWhenReady ?? null,
  ].map(csvCell).join(','))
  return `\uFEFF${headers.map(csvCell).join(',')}\r\n${rows.join('\r\n')}\r\n`
}
