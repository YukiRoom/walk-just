import { useState } from 'react'
import { isIos, isStandalone } from '../lib/platform'

/** iPhoneのSafari等で開いている場合だけ、ホーム画面への追加を案内する（PWA起動時は表示しない） */
export function InstallGuide() {
  // URLのクエリ（?debug=1等）や過去の「×」操作に左右されず、iOSの非PWA表示なら毎回表示する
  const [visible, setVisible] = useState(() => isIos() && !isStandalone())
  if (!visible) return null

  function dismiss(): void {
    setVisible(false)
  }

  return (
    <aside className="install-guide" aria-label="ホーム画面への追加のご案内">
      <div className="install-guide-head">
        <strong>📲 ホーム画面に追加して使うのがおすすめです</strong>
        <button type="button" className="install-guide-close" onClick={dismiss} aria-label="案内を閉じる">×</button>
      </div>
      <ol>
        <li>Safariの<b>共有ボタン</b>（□に↑のアイコン）をタップ</li>
        <li><b>「ホーム画面に追加」</b>を選んで「追加」をタップ</li>
        <li>ホーム画面の <b>WALK JUST!</b> アイコンから起動</li>
      </ol>
      <p>計測中は画面の自動スリープを防ぎます。電源ボタンなどで画面をロックすると、GPS計測が停止・制限される場合があります。</p>
    </aside>
  )
}
