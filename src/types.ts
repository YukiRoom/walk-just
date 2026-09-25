export type ChallengeMode = 'time' | 'steps'

export type ChallengeResult = {
  id: string
  playerName: string
  /** 端末ごとの匿名ユーザーID。旧データやスキーマ未移行時は未設定 */
  anonymousUserId?: string | null
  mode: ChallengeMode
  targetDistanceM: number
  targetValue: number
  actualValue: number
  errorValue: number
  elapsedSeconds: number
  createdAt: string
}

export type DistanceFilter = 'all' | 500 | 1000 | 2000 | 3000 | 5000
