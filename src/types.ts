export type ChallengeMode = 'time' | 'steps'

export type ChallengeResult = {
  id: string
  playerName: string
  mode: ChallengeMode
  targetDistanceM: number
  targetValue: number
  actualValue: number
  errorValue: number
  elapsedSeconds: number
  createdAt: string
}

export type DistanceFilter = 'all' | 500 | 1000 | 2000 | 3000 | 5000
