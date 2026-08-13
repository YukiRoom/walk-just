export type GeoPoint = {
  lat: number
  lng: number
  accuracy: number
  timestamp: number
}

const EARTH_RADIUS_M = 6371000

const toRad = (degrees: number) => (degrees * Math.PI) / 180

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2

  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

export function shouldAcceptPoint(
  previous: GeoPoint | null,
  next: GeoPoint,
  options = {
    maxAccuracyM: 50,
    minSegmentM: 2,
    maxSegmentM: 100,
    maxSpeedMps: 4.5,
  },
): boolean {
  if (next.accuracy > options.maxAccuracyM) return false
  if (!previous) return true

  const distance = haversineMeters(previous, next)
  if (distance < options.minSegmentM) return false
  if (distance > options.maxSegmentM) return false

  const seconds = Math.max(0.001, (next.timestamp - previous.timestamp) / 1000)
  const speed = distance / seconds
  if (speed > options.maxSpeedMps) return false

  return true
}

export function crossingElapsedMs(
  startedAtMs: number,
  previous: GeoPoint,
  next: GeoPoint,
  distanceBeforeM: number,
  targetDistanceM: number,
  segmentM: number,
): number {
  const remainingM = Math.max(0, targetDistanceM - distanceBeforeM)
  const ratio = segmentM > 0 ? Math.min(1, remainingM / segmentM) : 1
  const crossingTimestamp = previous.timestamp + (next.timestamp - previous.timestamp) * ratio
  return Math.max(0, crossingTimestamp - startedAtMs)
}
