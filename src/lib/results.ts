import { supabase } from './supabase'
import type { ChallengeMode, ChallengeResult, DistanceFilter } from '../types'

const LOCAL_KEY = 'walk-just-results'

type DbResult = {
  id: string
  player_name: string
  mode: ChallengeMode
  target_distance_m: number
  target_time_seconds: number | null
  actual_time_seconds: number | null
  error_seconds: number | null
  target_steps: number | null
  actual_steps: number | null
  error_steps: number | null
  elapsed_seconds: number
  created_at: string
}

function isChallengeResult(value: unknown): value is ChallengeResult {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.playerName === 'string' &&
    (item.mode === 'time' || item.mode === 'steps') && typeof item.targetDistanceM === 'number' &&
    typeof item.targetValue === 'number' && typeof item.actualValue === 'number' &&
    typeof item.errorValue === 'number' && typeof item.elapsedSeconds === 'number' && typeof item.createdAt === 'string'
}

function localRead(): ChallengeResult[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter(isChallengeResult) : []
  } catch {
    return []
  }
}

function localWrite(results: ChallengeResult[]): void {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(results.slice(0, 500)))
}

export async function saveResult(result: ChallengeResult): Promise<void> {
  if (!supabase) {
    const all = localRead()
    if (!all.some((item) => item.id === result.id)) localWrite([result, ...all])
    return
  }

  const timeMode = result.mode === 'time'
  const { error } = await supabase.from('challenge_results').insert({
    id: result.id,
    player_name: result.playerName,
    mode: result.mode,
    target_distance_m: result.targetDistanceM,
    target_time_seconds: timeMode ? result.targetValue : null,
    actual_time_seconds: timeMode ? result.actualValue : null,
    error_seconds: timeMode ? result.errorValue : null,
    target_steps: timeMode ? null : result.targetValue,
    actual_steps: timeMode ? null : result.actualValue,
    error_steps: timeMode ? null : result.errorValue,
    elapsed_seconds: result.elapsedSeconds,
    created_at: result.createdAt,
  })
  if (error) throw error
}

function fromDb(row: DbResult): ChallengeResult {
  const isTime = row.mode === 'time'
  return {
    id: row.id,
    playerName: row.player_name,
    mode: row.mode,
    targetDistanceM: row.target_distance_m,
    targetValue: (isTime ? row.target_time_seconds : row.target_steps) ?? 0,
    actualValue: (isTime ? row.actual_time_seconds : row.actual_steps) ?? 0,
    errorValue: (isTime ? row.error_seconds : row.error_steps) ?? 0,
    elapsedSeconds: row.elapsed_seconds,
    createdAt: row.created_at,
  }
}

export async function getRankings(mode: ChallengeMode, distance: DistanceFilter = 'all'): Promise<ChallengeResult[]> {
  if (!supabase) {
    return localRead()
      .filter((result) => result.mode === mode && (distance === 'all' || result.targetDistanceM === distance))
      .sort((a, b) => a.errorValue - b.errorValue || a.createdAt.localeCompare(b.createdAt))
      .slice(0, 100)
  }

  const errorColumn = mode === 'time' ? 'error_seconds' : 'error_steps'
  let query = supabase.from('challenge_results').select('*').eq('mode', mode)
  if (distance !== 'all') query = query.eq('target_distance_m', distance)
  const { data, error } = await query.order(errorColumn, { ascending: true }).order('created_at', { ascending: true }).limit(100)
  if (error) throw error
  return ((data ?? []) as DbResult[]).map(fromDb)
}
