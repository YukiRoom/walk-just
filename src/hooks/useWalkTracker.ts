import { useCallback, useEffect, useRef, useState } from 'react'
import { crossingElapsedMs, type GeoPoint, haversineMeters, shouldAcceptPoint } from '../lib/distance'

export type TrackerStatus = 'idle' | 'tracking' | 'finished' | 'error'

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

  const previousPoint = useRef<GeoPoint | null>(null)
  const distanceRef = useRef(0)
  const watchId = useRef<number | null>(null)
  const timerId = useRef<number | null>(null)
  const startedAt = useRef<number | null>(null)
  const finishedRef = useRef(false)
  const accuracySumRef = useRef(0)
  const accuracySamplesRef = useRef(0)

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
    stopInternals()
    const elapsed = preciseElapsedMs ?? (startedAt.current === null ? 0 : Date.now() - startedAt.current)
    setElapsedMs(Math.max(0, elapsed))
    setDistanceM(targetDistanceM)
    setStatus('finished')
  }, [stopInternals, targetDistanceM])

  const cancel = useCallback(() => {
    finishedRef.current = true
    stopInternals()
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

  const start = useCallback(() => {
    stopInternals()
    setError(null)

    if (!('geolocation' in navigator)) {
      setError('この端末またはブラウザではGPSを利用できません。')
      setStatus('error')
      return
    }

    finishedRef.current = false
    previousPoint.current = null
    distanceRef.current = 0
    setDistanceM(0)
    setElapsedMs(0)
    setDebugInfo(EMPTY_DEBUG_INFO)
    accuracySumRef.current = 0
    accuracySamplesRef.current = 0
    startedAt.current = Date.now()
    setStatus('tracking')

    timerId.current = window.setInterval(() => {
      if (startedAt.current !== null && !finishedRef.current) setElapsedMs(Date.now() - startedAt.current)
    }, 200)

    watchId.current = navigator.geolocation.watchPosition(
      (position) => {
        if (finishedRef.current) return
        const next: GeoPoint = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp || Date.now(),
        }
        const previous = previousPoint.current
        const segmentM = previous ? haversineMeters(previous, next) : 0
        const seconds = previous ? Math.max(0.001, (next.timestamp - previous.timestamp) / 1000) : 0
        const speedMps = seconds > 0 ? segmentM / seconds : 0
        const accepted = shouldAcceptPoint(previous, next)
        if (debugEnabled) {
          accuracySumRef.current += next.accuracy
          accuracySamplesRef.current += 1
          setDebugInfo((current) => ({
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
      },
      (geoError) => {
        if (finishedRef.current) return
        finishedRef.current = true
        setError(geolocationErrorMessage(geoError))
        stopInternals()
        setStatus('error')
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    )
  }, [debugEnabled, finish, stopInternals, targetDistanceM])

  useEffect(() => stopInternals, [stopInternals])

  useEffect(() => {
    if (!debugEnabled || status !== 'tracking') return
    const handleVisibilityChange = () => {
      setDebugInfo((current) => ({ ...current, visibilityChanges: current.visibilityChanges + 1 }))
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [debugEnabled, status])

  return { status, distanceM, elapsedMs, error, debugInfo, start, cancel }
}
