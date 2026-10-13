import { useCallback, useEffect, useRef, useState } from 'react'
import { crossingElapsedMs, type GeoPoint, haversineMeters, shouldAcceptPoint } from '../lib/distance'

export type TrackerStatus = 'idle' | 'preparing' | 'tracking' | 'finished' | 'error'

/**
 * START後、計測開始前のGPS準備（ウォームアップ）状態。
 * 準備中に受信した位置は距離に加算せず、取得状態の判定だけに使う。
 */
export type GpsReadiness = {
  /** 準備開始以降に受信した位置の数 */
  fixes: number
  /** 最新のaccuracy（m） */
  accuracyM: number | null
  /** 準備完了条件を満たした連続受信数（READY_CONSECUTIVE_FIXESで準備OK） */
  stableFixes: number
  /** 準備OK（精度・安定性の条件を満たした） */
  ready: boolean
  /** 準備OKでなくても開始可能（既存フィルターで採用できる位置を受信済み） */
  canStart: boolean
}

// 準備OKの条件（GPSフィルター・距離計算の閾値とは独立。計測中の判定には使わない）
const READY_ACCURACY_M = 20
const READY_CONSECUTIVE_FIXES = 3
const READY_MAX_JUMP_M = 20
const FRESH_FIX_TOLERANCE_MS = 2000
const ANCHOR_MAX_AGE_MS = 5000

// 他アプリへの切り替え・画面ロックから戻った後の再開処理
// iOSのWebアプリ／PWAはバックグラウンドでGPSを受信できないため、戻った後に位置を再確認し、
// 離れた地点（最後の採用地点）から戻った地点までを直線距離で補完する。
const RESUME_ACCURACY_M = 20
const RESUME_CONFIRM_FIXES = 2
const RESUME_MAX_JUMP_M = 20
// 補完区間の速度上限（計測中フィルターの maxSpeedMps と同じ値）
const BRIDGE_MAX_SPEED_MPS = 4.5
const BRIDGE_MIN_SEGMENT_M = 2

/** 計測中のGPS受信状況（距離・タイムを見せずに受信状態だけを表示するため） */
export type GpsSignal = {
  /** 最後に位置を受信した時刻（Date.now基準） */
  lastFixAt: number | null
  /** 他アプリ等から戻った後、位置を再確認中 */
  resuming: boolean
  /** 一時的なGPSエラー（計測は継続） */
  warning: string | null
}

const EMPTY_SIGNAL: GpsSignal = { lastFixAt: null, resuming: false, warning: null }

const EMPTY_READINESS: GpsReadiness = { fixes: 0, accuracyM: null, stableFixes: 0, ready: false, canStart: false }

export type GpsDebugInfo = {
  accuracyM: number | null
  latitude: number | null
  longitude: number | null
  acceptedPoints: number
  rejectedPoints: number
  latestSegmentM: number
  cumulativeDistanceM: number
  speedMps: number
  timestamp: number | null
  averageAccuracyM: number | null
  maximumAccuracyM: number | null
  minimumAccuracyM: number | null
  visibilityChanges: number
  /** START（準備開始）から準備OKまでの時間。未達ならnull */
  warmupReadyMs: number | null
  /** START（準備開始）から計測開始までの時間 */
  warmupTotalMs: number | null
  /** 準備中に受信した位置の数 */
  warmupFixes: number
  /** 計測開始時のaccuracy */
  startAccuracyM: number | null
  /** 計測開始時に準備OKだったか */
  startedWhenReady: boolean | null
  /** バックグラウンド（非表示）になった回数（計測中） */
  backgroundCount: number
  /** 非表示だった合計時間 */
  backgroundTotalMs: number
  /** 直線補完した回数 / 合計距離 */
  bridgeCount: number
  bridgedDistanceM: number
  /** 速度超過などで補完せず起点を置き直した回数 */
  bridgeRejectedCount: number
  /** 最新の補完区間（距離・時間） */
  lastBridgeM: number | null
  lastBridgeGapMs: number | null
  /** 計測を止めなかったGPSエラーの回数 */
  softErrorCount: number
}

const EMPTY_DEBUG_INFO: GpsDebugInfo = {
  accuracyM: null,
  latitude: null,
  longitude: null,
  acceptedPoints: 0,
  rejectedPoints: 0,
  latestSegmentM: 0,
  cumulativeDistanceM: 0,
  speedMps: 0,
  timestamp: null,
  averageAccuracyM: null,
  maximumAccuracyM: null,
  minimumAccuracyM: null,
  visibilityChanges: 0,
  warmupReadyMs: null,
  warmupTotalMs: null,
  warmupFixes: 0,
  startAccuracyM: null,
  startedWhenReady: null,
  backgroundCount: 0,
  backgroundTotalMs: 0,
  bridgeCount: 0,
  bridgedDistanceM: 0,
  bridgeRejectedCount: 0,
  lastBridgeM: null,
  lastBridgeGapMs: null,
  softErrorCount: 0,
}

function geolocationErrorMessage(error: GeolocationPositionError): string {
  if (error.code === error.PERMISSION_DENIED) return '位置情報の利用が許可されていません。端末の設定から許可してください。'
  if (error.code === error.TIMEOUT) return 'GPSの取得がタイムアウトしました。空が見える場所で再度お試しください。'
  return 'GPS情報を取得できませんでした。通信・位置情報設定をご確認ください。'
}

export function useWalkTracker(targetDistanceM: number, debugEnabled = false) {
  const [status, setStatus] = useState<TrackerStatus>('idle')
  const [distanceM, setDistanceM] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState<GpsDebugInfo>(EMPTY_DEBUG_INFO)
  const [readiness, setReadiness] = useState<GpsReadiness>(EMPTY_READINESS)
  const [signal, setSignal] = useState<GpsSignal>(EMPTY_SIGNAL)

  const previousPoint = useRef<GeoPoint | null>(null)
  const distanceRef = useRef(0)
  const watchId = useRef<number | null>(null)
  const timerId = useRef<number | null>(null)
  const startedAt = useRef<number | null>(null)
  const finishedRef = useRef(false)
  const accuracySumRef = useRef(0)
  const accuracySamplesRef = useRef(0)
  const phaseRef = useRef<'idle' | 'preparing' | 'tracking'>('idle')
  const prepareStartedAt = useRef<number | null>(null)
  const prepareReadyAt = useRef<number | null>(null)
  const latestFix = useRef<GeoPoint | null>(null)
  const stableFixesRef = useRef(0)
  const warmupFixesRef = useRef(0)
  const hiddenAtRef = useRef<number | null>(null)
  const resumeRef = useRef<{ pending: boolean; visibleAt: number; candidate: GeoPoint | null; confirmations: number }>({
    pending: false, visibleAt: 0, candidate: null, confirmations: 0,
  })

  const stopInternals = useCallback(() => {
    if (watchId.current !== null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
    }
    if (timerId.current !== null) {
      window.clearInterval(timerId.current)
      timerId.current = null
    }
  }, [])

  const finish = useCallback((preciseElapsedMs?: number) => {
    if (finishedRef.current) return
    finishedRef.current = true
    phaseRef.current = 'idle'
    stopInternals()
    const elapsed = preciseElapsedMs ?? (startedAt.current === null ? 0 : Date.now() - startedAt.current)
    setElapsedMs(Math.max(0, elapsed))
    setDistanceM(targetDistanceM)
    setStatus('finished')
  }, [stopInternals, targetDistanceM])

  const cancel = useCallback(() => {
    finishedRef.current = true
    phaseRef.current = 'idle'
    stopInternals()
    setReadiness(EMPTY_READINESS)
    setSignal(EMPTY_SIGNAL)
    hiddenAtRef.current = null
    resumeRef.current = { pending: false, visibleAt: 0, candidate: null, confirmations: 0 }
    setStatus('idle')
    setError(null)
    previousPoint.current = null
    distanceRef.current = 0
    startedAt.current = null
    setDistanceM(0)
    setElapsedMs(0)
    setDebugInfo(EMPTY_DEBUG_INFO)
    accuracySumRef.current = 0
    accuracySamplesRef.current = 0
  }, [stopInternals])

  /** 採用した区間を距離に加算し、目標到達なら通過時刻を補間してゴールする */
  const addSegment = useCallback((previous: GeoPoint, next: GeoPoint, segmentM: number) => {
    const distanceBeforeM = distanceRef.current
    previousPoint.current = next
    const updatedM = distanceBeforeM + segmentM
    distanceRef.current = updatedM
    if (debugEnabled) setDebugInfo((current) => ({ ...current, cumulativeDistanceM: updatedM }))

    if (updatedM >= targetDistanceM) {
      const preciseMs = crossingElapsedMs(
        startedAt.current ?? next.timestamp,
        previous,
        next,
        distanceBeforeM,
        targetDistanceM,
        segmentM,
      )
      finish(preciseMs)
      return
    }
    setDistanceM(updatedM)
  }, [debugEnabled, finish, targetDistanceM])

  /** 計測中（タイマー開始後）の位置処理。既存のフィルター・距離計算・自動ゴールをそのまま使う */
  const handleTrackingPoint = useCallback((next: GeoPoint) => {
    const previous = previousPoint.current
    const segmentM = previous ? haversineMeters(previous, next) : 0
    const seconds = previous ? Math.max(0.001, (next.timestamp - previous.timestamp) / 1000) : 0
    const speedMps = seconds > 0 ? segmentM / seconds : 0
    const accepted = shouldAcceptPoint(previous, next)
    if (debugEnabled) {
      accuracySumRef.current += next.accuracy
      accuracySamplesRef.current += 1
      setDebugInfo((current) => ({
        ...current,
        accuracyM: next.accuracy,
        latitude: next.lat,
        longitude: next.lng,
        acceptedPoints: current.acceptedPoints + (accepted ? 1 : 0),
        rejectedPoints: current.rejectedPoints + (accepted ? 0 : 1),
        latestSegmentM: segmentM,
        cumulativeDistanceM: distanceRef.current,
        speedMps,
        timestamp: next.timestamp,
        averageAccuracyM: accuracySumRef.current / accuracySamplesRef.current,
        maximumAccuracyM: current.maximumAccuracyM === null ? next.accuracy : Math.max(current.maximumAccuracyM, next.accuracy),
        minimumAccuracyM: current.minimumAccuracyM === null ? next.accuracy : Math.min(current.minimumAccuracyM, next.accuracy),
        visibilityChanges: current.visibilityChanges,
      }))
    }
    if (!accepted) return
    if (!previous) {
      previousPoint.current = next
      return
    }
    addSegment(previous, next, segmentM)
  }, [addSegment, debugEnabled])

  /**
   * 他アプリ・画面ロックから戻った直後の位置処理。
   * 精度の良い位置が連続して得られたら、最後の採用地点からの直線距離を1区間として加算する。
   */
  const handleResumePoint = useCallback((next: GeoPoint) => {
    const resume = resumeRef.current
    const fresh = next.timestamp >= resume.visibleAt - FRESH_FIX_TOLERANCE_MS
    if (fresh && next.accuracy <= RESUME_ACCURACY_M) {
      const steady = resume.candidate !== null && haversineMeters(resume.candidate, next) <= RESUME_MAX_JUMP_M
      resume.confirmations = steady ? resume.confirmations + 1 : 1
      resume.candidate = next
    } else {
      resume.confirmations = 0
      resume.candidate = null
    }
    if (debugEnabled) {
      setDebugInfo((current) => ({ ...current, accuracyM: next.accuracy, latitude: next.lat, longitude: next.lng, timestamp: next.timestamp }))
    }
    if (resume.confirmations < RESUME_CONFIRM_FIXES) return

    resumeRef.current = { pending: false, visibleAt: 0, candidate: null, confirmations: 0 }
    setSignal((current) => ({ ...current, resuming: false }))
    const previous = previousPoint.current
    if (!previous) {
      previousPoint.current = next
      return
    }
    const segmentM = haversineMeters(previous, next)
    const gapMs = Math.max(1, next.timestamp - previous.timestamp)
    const speedMps = segmentM / (gapMs / 1000)
    if (segmentM < BRIDGE_MIN_SEGMENT_M) return
    if (speedMps > BRIDGE_MAX_SPEED_MPS) {
      // 徒歩では不自然な移動（乗り物など）は加算せず、戻った地点から計測を続ける
      previousPoint.current = next
      if (debugEnabled) setDebugInfo((current) => ({ ...current, bridgeRejectedCount: current.bridgeRejectedCount + 1, lastBridgeM: segmentM, lastBridgeGapMs: gapMs }))
      return
    }
    if (debugEnabled) {
      setDebugInfo((current) => ({
        ...current,
        bridgeCount: current.bridgeCount + 1,
        bridgedDistanceM: current.bridgedDistanceM + segmentM,
        lastBridgeM: segmentM,
        lastBridgeGapMs: gapMs,
        latestSegmentM: segmentM,
      }))
    }
    addSegment(previous, next, segmentM)
  }, [addSegment, debugEnabled])

  /** 準備中の位置処理。距離には加算せず、準備OKかどうかだけを判定する */
  const handlePreparingPoint = useCallback((next: GeoPoint) => {
    const previousFix = latestFix.current
    latestFix.current = next
    warmupFixesRef.current += 1
    const fresh = prepareStartedAt.current === null || next.timestamp >= prepareStartedAt.current - FRESH_FIX_TOLERANCE_MS
    const steady = previousFix === null || haversineMeters(previousFix, next) <= READY_MAX_JUMP_M
    stableFixesRef.current = fresh && next.accuracy <= READY_ACCURACY_M && steady ? stableFixesRef.current + 1 : 0
    if (stableFixesRef.current >= READY_CONSECUTIVE_FIXES && prepareReadyAt.current === null) prepareReadyAt.current = Date.now()
    // 一度準備OKになったら表示を戻さない（ボタンのちらつき防止）
    const ready = prepareReadyAt.current !== null
    setReadiness({
      fixes: warmupFixesRef.current,
      accuracyM: next.accuracy,
      stableFixes: Math.min(stableFixesRef.current, READY_CONSECUTIVE_FIXES),
      ready,
      canStart: shouldAcceptPoint(null, next),
    })
    if (debugEnabled) {
      setDebugInfo((current) => ({
        ...current,
        accuracyM: next.accuracy,
        latitude: next.lat,
        longitude: next.lng,
        timestamp: next.timestamp,
        warmupFixes: warmupFixesRef.current,
        warmupReadyMs: prepareReadyAt.current !== null && prepareStartedAt.current !== null ? prepareReadyAt.current - prepareStartedAt.current : null,
      }))
    }
  }, [debugEnabled])

  const handlePosition = useCallback((position: GeolocationPosition) => {
    if (finishedRef.current) return
    const next: GeoPoint = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      timestamp: position.timestamp || Date.now(),
    }
    setSignal((current) => ({ ...current, lastFixAt: Date.now(), warning: null }))
    if (phaseRef.current === 'preparing') handlePreparingPoint(next)
    else if (phaseRef.current === 'tracking') {
      if (resumeRef.current.pending) handleResumePoint(next)
      else handleTrackingPoint(next)
    }
  }, [handlePreparingPoint, handleResumePoint, handleTrackingPoint])

  const handlePositionError = useCallback((geoError: GeolocationPositionError) => {
    if (finishedRef.current) return
    if (geoError.code !== geoError.PERMISSION_DENIED) {
      // タイムアウト等は一時的なものとして計測を続ける（他アプリから戻った直後などに発生しうる）
      setSignal((current) => ({ ...current, warning: geolocationErrorMessage(geoError) }))
      if (debugEnabled) setDebugInfo((current) => ({ ...current, softErrorCount: current.softErrorCount + 1 }))
      return
    }
    finishedRef.current = true
    phaseRef.current = 'idle'
    setError(geolocationErrorMessage(geoError))
    stopInternals()
    setStatus('error')
  }, [debugEnabled, stopInternals])

  const handlePositionRef = useRef(handlePosition)
  const handlePositionErrorRef = useRef(handlePositionError)
  handlePositionRef.current = handlePosition
  handlePositionErrorRef.current = handlePositionError

  const startWatch = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current)
    watchId.current = navigator.geolocation.watchPosition(
      (position) => handlePositionRef.current(position),
      (geoError) => handlePositionErrorRef.current(geoError),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    )
  }, [])

  /** START：GPSの受信を開始し準備中にする。タイマーはまだ動かさない */
  const prepare = useCallback(() => {
    stopInternals()
    setError(null)

    if (!('geolocation' in navigator)) {
      setError('この端末またはブラウザではGPSを利用できません。')
      setStatus('error')
      return
    }

    finishedRef.current = false
    phaseRef.current = 'preparing'
    previousPoint.current = null
    distanceRef.current = 0
    latestFix.current = null
    stableFixesRef.current = 0
    warmupFixesRef.current = 0
    prepareStartedAt.current = Date.now()
    prepareReadyAt.current = null
    startedAt.current = null
    setDistanceM(0)
    setElapsedMs(0)
    setDebugInfo(EMPTY_DEBUG_INFO)
    setReadiness(EMPTY_READINESS)
    setSignal(EMPTY_SIGNAL)
    hiddenAtRef.current = null
    resumeRef.current = { pending: false, visibleAt: 0, candidate: null, confirmations: 0 }
    accuracySumRef.current = 0
    accuracySamplesRef.current = 0
    setStatus('preparing')

    startWatch()
  }, [startWatch, stopInternals])

  /** 準備完了後、実際のチャレンジ（タイマー・距離計測）を開始する */
  const begin = useCallback(() => {
    if (phaseRef.current !== 'preparing' || finishedRef.current) return
    const fix = latestFix.current
    if (!fix || !shouldAcceptPoint(null, fix)) return
    const now = Date.now()
    phaseRef.current = 'tracking'
    // 準備中の最新位置が新しければ起点にする（準備中の揺れは距離に含めない）
    previousPoint.current = now - fix.timestamp <= ANCHOR_MAX_AGE_MS ? fix : null
    distanceRef.current = 0
    startedAt.current = now
    accuracySumRef.current = 0
    accuracySamplesRef.current = 0
    setDistanceM(0)
    setElapsedMs(0)
    if (debugEnabled) {
      setDebugInfo((current) => ({
        ...EMPTY_DEBUG_INFO,
        accuracyM: current.accuracyM,
        latitude: current.latitude,
        longitude: current.longitude,
        timestamp: current.timestamp,
        visibilityChanges: current.visibilityChanges,
        warmupFixes: warmupFixesRef.current,
        warmupReadyMs: prepareReadyAt.current !== null && prepareStartedAt.current !== null ? prepareReadyAt.current - prepareStartedAt.current : null,
        warmupTotalMs: prepareStartedAt.current !== null ? now - prepareStartedAt.current : null,
        startAccuracyM: fix.accuracy,
        startedWhenReady: prepareReadyAt.current !== null,
      }))
    }
    setStatus('tracking')

    timerId.current = window.setInterval(() => {
      if (startedAt.current !== null && !finishedRef.current) setElapsedMs(Date.now() - startedAt.current)
    }, 200)
  }, [debugEnabled])

  useEffect(() => stopInternals, [stopInternals])

  // 他アプリへの切り替え・画面ロック（非表示）からの復帰：GPSの受信を張り直し、計測中なら位置を再確認する
  useEffect(() => {
    if (status !== 'tracking' && status !== 'preparing') return
    const handleVisibilityChange = () => {
      if (finishedRef.current) return
      const now = Date.now()
      if (document.visibilityState === 'hidden') {
        if (hiddenAtRef.current === null) hiddenAtRef.current = now
        return
      }
      const hiddenAt = hiddenAtRef.current
      hiddenAtRef.current = null
      if (hiddenAt === null) return
      if (phaseRef.current === 'tracking') {
        resumeRef.current = { pending: true, visibleAt: now, candidate: null, confirmations: 0 }
        setSignal((current) => ({ ...current, resuming: true }))
        if (debugEnabled) {
          setDebugInfo((current) => ({ ...current, backgroundCount: current.backgroundCount + 1, backgroundTotalMs: current.backgroundTotalMs + (now - hiddenAt) }))
        }
      }
      if (watchId.current !== null) startWatch()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [debugEnabled, startWatch, status])

  useEffect(() => {
    if (!debugEnabled || (status !== 'tracking' && status !== 'preparing')) return
    const handleVisibilityChange = () => {
      setDebugInfo((current) => ({ ...current, visibilityChanges: current.visibilityChanges + 1 }))
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [debugEnabled, status])

  return { status, distanceM, elapsedMs, error, debugInfo, readiness, signal, prepare, begin, cancel }
}
