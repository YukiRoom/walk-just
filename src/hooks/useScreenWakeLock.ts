import { useCallback, useEffect, useRef, useState } from 'react'

export type WakeLockState = 'unsupported' | 'idle' | 'requesting' | 'active' | 'released' | 'failed'

export type WakeLockInfo = {
  supported: boolean
  state: WakeLockState
  acquireCount: number
  releaseCount: number
  lastError: string | null
}

function wakeLockApi(): WakeLock | null {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null
  const api = navigator.wakeLock
  return api && typeof api.request === 'function' ? api : null
}

/**
 * 計測中の画面自動スリープを防ぐ。
 * - activeがtrueの間だけWake Lockを保持し、falseになったら・アンマウント時に解除する
 * - ページが再表示（visible）された時、保持していなければ再取得する
 * - 取得に失敗しても例外は投げず、stateを'failed'にするだけ（GPS計測には影響させない）
 */
export function useScreenWakeLock(active: boolean) {
  const supported = wakeLockApi() !== null
  const [info, setInfo] = useState<WakeLockInfo>(() => ({
    supported,
    state: supported ? 'idle' : 'unsupported',
    acquireCount: 0,
    releaseCount: 0,
    lastError: null,
  }))
  const [requestId, setRequestId] = useState(0)
  const sentinelRef = useRef<WakeLockSentinel | null>(null)
  const pendingRef = useRef(false)
  const wantedRef = useRef(false)

  const release = useCallback(() => {
    const sentinel = sentinelRef.current
    sentinelRef.current = null
    if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined)
  }, [])

  const acquire = useCallback(() => {
    const api = wakeLockApi()
    if (!api || !wantedRef.current || pendingRef.current) return
    if (sentinelRef.current && !sentinelRef.current.released) return
    if (document.visibilityState !== 'visible') return
    pendingRef.current = true
    setInfo((current) => ({ ...current, state: 'requesting' }))
    api.request('screen').then((sentinel) => {
      pendingRef.current = false
      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) sentinelRef.current = null
        setInfo((current) => ({ ...current, state: 'released', releaseCount: current.releaseCount + 1 }))
      }, { once: true })
      setInfo((current) => ({ ...current, state: 'active', acquireCount: current.acquireCount + 1, lastError: null }))
      if (!wantedRef.current) {
        // 取得待ちの間にゴール・中止した場合は即解除する
        void sentinel.release().catch(() => undefined)
        return
      }
      sentinelRef.current = sentinel
    }).catch((error: unknown) => {
      pendingRef.current = false
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      setInfo((current) => ({ ...current, state: 'failed', lastError: message }))
    })
  }, [])

  /** STARTボタンのタップ（ユーザー操作）内で呼び、その場でWake Lockを要求する */
  const request = useCallback(() => {
    wantedRef.current = true
    acquire()
    setRequestId((id) => id + 1)
  }, [acquire])

  useEffect(() => {
    if (active) {
      wantedRef.current = true
      acquire()
    } else {
      wantedRef.current = false
      release()
    }
  }, [active, requestId, acquire, release])

  useEffect(() => {
    if (!active) return
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') acquire()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [active, acquire])

  useEffect(() => () => {
    wantedRef.current = false
    release()
  }, [release])

  return { ...info, request }
}
