# WALK JUST! MVP

速さや歩数の多さではなく、**自分で決めた目標にどれだけ正確に合わせられるか**を競うスマートフォン向けウォーキングPWAです。

## 機能

- TIME CHALLENGE: 任意の距離・目標タイムを設定し、到達時のタイム誤差で競う
- STEP CHALLENGE: 任意の距離・目標歩数を設定し、到達後に入力した歩数の誤差で競う
- ニックネーム登録（初回起動時に1〜20文字で登録。メール・パスワード不要。ホームの「○○さん」から変更可能）
- TIME / STEPランキング（誤差昇順、同率は記録日時昇順、距離フィルタ付き。登録ニックネームで表示）
- Supabase未設定時のlocalStorage保存
- インストール可能なPWAとオフライン用Service Worker
- `?debug=1` で有効になる実機テスト用GPSデバッグ表示
- 計測中の画面自動スリープ防止（Screen Wake Lock API）
- iPhoneのSafariで開いた場合の「ホーム画面に追加」案内（PWAとして起動中は非表示）

## 計測中の画面スリープ防止（Wake Lock）

推奨運用は **iPhoneのSafariでWALK JUST!を開き、ホーム画面に追加してPWAとして使用する** ことです。

- TIME / STEPチャレンジのSTART時に `navigator.wakeLock.request('screen')` で画面の自動スリープを防ぎます。
- ゴール、チャレンジ中止、計測画面からの離脱、アンマウント時に解除します。
- 計測中にページが再表示（`visibilityState === 'visible'`）された場合、Wake Lockが解除されていれば再取得します（取得済み・取得中は再要求しません）。
- Wake Lock非対応端末や取得失敗時もチャレンジはそのまま利用でき、計測画面に「計測中は画面を消さないでください。」の注意を表示します。

**注意:** ホーム画面に追加したPWAでも、画面ロック後にバックグラウンドでGPS計測を継続できるわけではありません。Wake Lockが防ぐのは自動スリープのみです。電源ボタンなどで意図的に画面をロックすると、GPS計測が停止・制限される場合があります。

GPSは `watchPosition()` の高精度モードを使用します。精度50m超、2m未満の移動、100m超のジャンプ、4.5m/sを超える移動を除外し、採用地点間をHaversine式で加算します。目標線を越えた区間ではGPS時刻を線形補間してゴール時刻を決めます。

## ニックネームと匿名ユーザーID

初回起動時にニックネームを登録すると、端末ごとの匿名ユーザーID（`crypto.randomUUID()`、非対応環境では `crypto.getRandomValues()` によるUUID v4）を生成し、localStorageへ保存します。

| localStorageキー | 内容 |
| --- | --- |
| `walk-just-nickname` | 登録ニックネーム（前後の空白を除去、1〜20文字） |
| `walk-just-anonymous-user-id` | 匿名ユーザーID。ニックネームを変更しても変わりません |

記録には保存時点のニックネーム（`player_name`）と匿名ユーザーID（`anonymous_user_id`）を保存します。同じニックネームでも匿名ユーザーIDが異なれば別ユーザーとして扱い、ランキングでは自分の記録に `YOU` を表示します。匿名ユーザーIDは認証情報ではありません。ブラウザデータを消去すると新しいユーザーとして再登録になります。

## ローカルセットアップ

```bash
npm install
copy .env.example .env
npm run dev
```

位置情報APIは原則としてHTTPSまたはlocalhostでのみ利用できます。スマートフォンでの実地テストには、後述のNetlifyなどHTTPSで配信される環境を使用してください。

## Supabase設定

1. Supabaseでプロジェクトを作成します。
2. SQL Editorで `supabase/schema.sql` を実行します。既存の旧MVPテーブルがある場合も、このSQLが必要な列を追加して移行します。
   - すでに `challenge_results` を作成済みの環境では、`supabase/migrations/20260925_add_anonymous_user_id.sql` だけを実行すれば `anonymous_user_id` 列（NULL許可）が追加されます。未実行でもアプリは列なしで保存を続けます。
3. Supabase Dashboardのプロジェクト「Connect」、または「Settings > API Keys」からProject URLとPublishable keyを取得します。既存プロジェクトではlegacy anon keyも利用できます。
4. ローカルでは `.env`、Netlifyでは「Project configuration > Environment variables」に次の値を設定します。Netlify側ではBuildsスコープを含めてください。
5. 環境変数の追加・変更後は再ビルド／再デプロイします。

### 本番環境変数

| 変数 | 必須 | 内容 |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Supabase利用時 | `https://<project-ref>.supabase.co` 形式のProject URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | 推奨 | ブラウザ用の `sb_publishable_...` キー |
| `VITE_SUPABASE_ANON_KEY` | 既存環境のみ | legacy anon key。Publishable keyが未設定の場合だけ使用 |

Supabaseを使わない場合、上記をすべて未設定にすると記録は各端末のlocalStorageへ保存されます。`VITE_` で始まる値はビルド済みJavaScriptから参照できる公開値です。RLSを有効にしたPublishable key／anon keyだけを使用し、Secret keyやlegacy `service_role` keyは絶対に設定しないでください。

## Netlifyへの公開

リポジトリ直下の `netlify.toml` に以下を設定済みです。

- Build command: `npm run build`
- Publish directory: `dist`
- Node.js: 20
- SPA rewrite: `/*` → `/index.html`（HTTP 200）
- Service Worker: キャッシュ無効化ヘッダー
- Geolocation: 同一オリジンで許可

GitリポジトリをNetlifyへ接続し、環境変数を登録してDeployを実行します。デプロイ後は発行された `https://...netlify.app` URLをスマートフォンで開きます。手動アップロードする場合も、`npm run build` 後の `dist` ディレクトリが公開対象です。

## GPSデバッグモード

公開URLの末尾に `?debug=1` を付けます。

```text
https://your-site.netlify.app/?debug=1
```

チャレンジ開始後、計測画面に小さな `GPS DEBUG` パネルが表示されます。accuracy、現在の緯度経度、採用／除外ポイント数、最新区間距離、累積距離、現在速度、GPS取得時刻、精度の平均／最大／最小、表示状態の変化回数を確認できます。Wake Lockの対応可否、取得状態、取得回数、解除回数も表示します。通常URLではパネル、GPS統計集計、visibilityイベント回数の集計、テストログのlocalStorage読み込みを行いません。緯度経度は画面表示だけに使用し、結果やテストログには保存しません。

### GPSテストログ

デバッグパネルの「テストログ保存」から、計測中またはゴール後のGPS統計を端末のlocalStorageへ最大200件保存できます。実際の基準距離、ゴール地点の誤差、端末メモ、画面ロックの有無、コメントは任意入力です。「過去ログ」で履歴を確認し、「CSV出力」で全件をUTF-8 CSVとしてダウンロードできます。

保存項目はchallenge mode、目標／計測距離、経過時間、最新GPS精度、採用／除外ポイント数、最新区間距離、GPS精度の平均／最大／最小、テスト日時、User-Agent、browser／PWA表示モード、表示状態変化回数、Wake Lock対応可否／状態／取得回数／解除回数、および任意入力項目です。テストログはランキングやSupabaseへ送信されません。ブラウザデータを消去するとログも消えるため、屋外テスト後はCSVを保存してください。

## 実機テストチェックリスト

安全で見通しのよいコースで、最初は0.1kmなど短い目標を使用してください。同じ条件で通常URLと `?debug=1` を比較します。

### TIME CHALLENGE

- [ ] 任意の目標距離を設定できる
- [ ] 任意の目標タイムを設定できる
- [ ] STARTでGPS計測が開始する
- [ ] 実際の歩行に合わせて距離が加算される
- [ ] 目標距離到達時に自動ゴールする
- [ ] ゴール画面への遷移と保存が一度だけ行われる
- [ ] 実タイムが保存される
- [ ] 目標タイムとの差が正しく計算される
- [ ] TIMEランキングへ正しく反映される

### STEP CHALLENGE

- [ ] 任意の目標距離を設定できる
- [ ] 任意の目標歩数を設定できる
- [ ] STARTでGPS計測が開始する
- [ ] 目標距離到達時に自動ゴールする
- [ ] ゴール後に実歩数を入力できる
- [ ] 目標歩数との差が正しく計算される
- [ ] STEPランキングへ正しく反映される

### GPS・ブラウザ

- [ ] 位置情報を拒否すると、権限設定を案内するエラーが表示される
- [ ] accuracyが50mを超えるポイントは除外数だけ増え、距離へ加算されない
- [ ] 停止中に距離が大きく増えない
- [ ] 歩行中に100m超のジャンプや4.5m/s超の地点が加算されない
- [ ] 2m未満の揺れが加算されない
- [ ] 計測中に画面が自動スリープしない（Wake Lock）
- [ ] ゴール・中止後は通常どおり自動スリープする
- [ ] 計測中にアプリ切替→復帰すると `?debug=1` のWakeLock取得回数が増え、状態が「取得中（有効）」に戻る
- [ ] 電源ボタンで画面をロックした場合の更新停止・再開状況を記録する
- [ ] iOS SafariとAndroid Chromeで、権限、画面ロック、PWA起動時の挙動差を確認する
- [ ] ホーム画面へ追加し、standalone表示で起動できる
- [ ] 更新をデプロイ後、Service Worker経由でも最新版へ更新される

画面ロックやバックグラウンド中の位置情報更新はOS・ブラウザの省電力制御で停止する場合があります（PWAでも同様です）。チャレンジ中はWake Lockで自動スリープを防ぎ、画面を前面に保ったまま使用してください。

## 公開前確認

```bash
npm run build
npm run preview
```

`dist/index.html`、`dist/manifest.webmanifest`、`dist/sw.js`、`dist/icon-192.png`、`dist/icon-512.png` が生成されていることを確認します。Supabase利用時はTIME／STEPの記録を各1件保存し、別端末またはプライベートブラウズでもランキングから読めることを確認してください。
