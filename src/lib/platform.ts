type NavigatorWithStandalone = Navigator & { standalone?: boolean }

/** ホーム画面から起動したPWAか（display-mode: standalone / iOS Safariの navigator.standalone） */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as NavigatorWithStandalone).standalone === true
  const displayStandalone = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
  return iosStandalone || displayStandalone
}

/** iPhone / iPad（iPadOSのデスクトップ表示UAを含む） */
export function isIos(): boolean {
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}
