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
    accuracySumRef.current = 0
    accuracySamplesRef.current = 0
    setStatus('preparing')

    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        if (finishedRef.current) return
        const next: GeoPoint = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp || Date.now(),
        }
        if (phaseRef.current === 'preparing') handlePreparingPoint(next)
        else if (phaseRef.current === 'tracking') handleTrackingPoint(next)
      },
      (geoError) => {
        if (finishedRef.current) return
        finishedRef.current = true
        phaseRef.current = 'idle'
        setError(geolocationErrorMessage(geoError))
        stopInternals()
        setStatus('error')
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    )
  }, [handlePreparingPoint, handleTrackingPoint, stopInternals])

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

  useEffect(() => {
    if (!debugEnabled || (status !== 'tracking' && status !== 'preparing')) return
    const handleVisibilityChange = () => {
      setDebugInfo((current) => ({ ...current, visibilityChanges: current.visibilityChanges + 1 }))
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [debugEnabled, status])

  return { status, distanceM, elapsedMs, error, debugInfo, readiness, prepare, begin, cancel }
}
