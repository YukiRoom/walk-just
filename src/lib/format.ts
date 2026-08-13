export function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60

  if (h > 0) {
    return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
  }

  return [m, s].map((v) => String(v).padStart(2, '0')).join(':')
}

export function secondsFromMinutesSeconds(minutes: number, seconds: number) {
  return minutes * 60 + seconds
}
