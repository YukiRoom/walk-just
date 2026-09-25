export const NICKNAME_KEY = 'walk-just-nickname'
export const ANONYMOUS_USER_ID_KEY = 'walk-just-anonymous-user-id'
// 旧バージョンでチャレンジ開始時に保存していた表示名（初回登録フォームの初期値にのみ使用）
const LEGACY_NAME_KEY = 'walk-just-name'

export const NICKNAME_MAX_LENGTH = 20

export type Profile = {
  nickname: string
  anonymousUserId: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** RFC 4122 v4形式のUUIDを返す。randomUUIDが使えない環境ではgetRandomValuesで生成する。 */
export function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function normalizeNickname(value: string): string {
  return value.trim()
}

/** サロゲートペア（絵文字など）を1文字として数える */
export function nicknameLength(value: string): number {
  return Array.from(normalizeNickname(value)).length
}

export function nicknameError(value: string): string | null {
  const length = nicknameLength(value)
  if (length === 0) return 'ニックネームを入力してください。'
  if (length > NICKNAME_MAX_LENGTH) return `ニックネームは${NICKNAME_MAX_LENGTH}文字以内で入力してください。`
  return null
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // プライベートブラウズ等で保存できない場合も、このセッション中は利用を継続できるようにする
  }
}

export function loadProfile(): Profile | null {
  const nickname = normalizeNickname(read(NICKNAME_KEY) ?? '')
  const anonymousUserId = read(ANONYMOUS_USER_ID_KEY) ?? ''
  if (nicknameError(nickname) || !UUID_PATTERN.test(anonymousUserId)) return null
  return { nickname, anonymousUserId }
}

export function legacyNickname(): string {
  const legacy = normalizeNickname(read(LEGACY_NAME_KEY) ?? '')
  return Array.from(legacy).slice(0, NICKNAME_MAX_LENGTH).join('')
}

/** 初回登録。既存の匿名IDが保存済みならそれを引き継ぐ。 */
export function registerProfile(rawNickname: string): Profile {
  const nickname = normalizeNickname(rawNickname)
  const stored = read(ANONYMOUS_USER_ID_KEY) ?? ''
  const anonymousUserId = UUID_PATTERN.test(stored) ? stored : createUuid()
  write(ANONYMOUS_USER_ID_KEY, anonymousUserId)
  write(NICKNAME_KEY, nickname)
  return { nickname, anonymousUserId }
}

/** ニックネームのみ変更する。anonymousUserIdは変更しない。 */
export function updateNickname(profile: Profile, rawNickname: string): Profile {
  const nickname = normalizeNickname(rawNickname)
  write(NICKNAME_KEY, nickname)
  return { ...profile, nickname }
}
