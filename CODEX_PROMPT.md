# Codex実装指示：WALK JUST! MVP

このリポジトリを引き継いで、スマートフォン向けウォーキングPWA「WALK JUST!」のMVPを完成させてください。

## アプリのコンセプト

速さや歩数の多さを競うのではなく、
**各参加者が自分で設定した目標にどれだけ正確に合わせられるか**を競う。

## 必須仕様

### 1. TIME CHALLENGE

ユーザー自身が以下を自由に設定できること。

- 表示名
- 目標距離（km）
- 目標タイム（分・秒）

START押下でGPS追跡とタイマーを同時開始。

GPSの累積移動距離が目標距離以上になった瞬間に自動ゴール。

結果として保存する値：

- target_distance_m
- target_time_seconds
- actual_time_seconds
- error_seconds = abs(actual_time_seconds - target_time_seconds)

ランキングは `error_seconds` の昇順。

### 2. STEP CHALLENGE

ユーザー自身が以下を自由に設定できること。

- 表示名
- 目標距離（km）
- 目標歩数

START押下でGPS追跡。

GPSの累積移動距離が目標距離以上になった瞬間に自動ゴール。

ゴール後にユーザーが実際の歩数を手入力。

結果として保存：

- target_distance_m
- target_steps
- actual_steps
- error_steps = abs(actual_steps - target_steps)

ランキングは `error_steps` の昇順。

## GPS要件

Browser Geolocation API の watchPosition を使用。

次のGPSノイズ対策を必ず行う。

- high accuracyを要求
- accuracy > 50m のポイントを除外
- 2m未満の移動を除外
- 100m超の位置ジャンプを除外
- 人のウォーキングとして不自然な速度の地点を除外
- Haversine formulaで距離を計算
- 直近の「採用済みGPS地点」から次の採用済み地点までを加算

GPS取得エラー、権限拒否をUI表示する。

## ゴール判定

目標距離到達を検知したら重複処理を起こさず、一度だけfinishすること。

React StrictModeでも二重保存しないよう対策すること。

ゴール時刻は可能な限り正確に扱う。

## ランキング

MVPでは以下を用意。

- TIMEランキング
- STEPランキング
- 誤差の小さい順
- 同率の場合はcreated_atの早い順
- 表示：順位、名前、目標距離、目標値、実績、誤差

追加で可能なら距離フィルタ：

- 全距離
- 0.5km
- 1km
- 2km
- 3km
- 5km

ただし任意距離を設定できる仕様は維持する。

## DB

Supabaseを使用。

既存の `supabase/schema.sql` を必要に応じて改善してよい。

匿名利用をMVPでは許可。

ただし将来Authを追加しやすい設計にする。

## オフライン/設定未完時

Supabase環境変数がない場合はlocalStorageで動くようにしてよい。

## PWA

スマートフォンのホーム画面に追加可能にする。

## UI

スマホファースト。

ホーム：
- TIME CHALLENGE
- STEP CHALLENGE
- ランキング

設定：
- 各自の目標を入力

計測中：
- 現在距離
- 目標距離
- 進捗バー
- 経過時間
- 中止ボタン

結果：
- 目標
- 実績
- 誤差
- ランキングを見る

## ブラインド機能の拡張余地

MVP完成後の拡張を想定し、計測画面の表示はコンポーネント化する。

将来的に以下を選択可能にする予定：

- タイム表示あり
- タイム非表示
- 距離非表示
- タイム・距離両方非表示

今回は実装必須ではない。

## 品質要件

- TypeScript strict
- 不要なany禁止
- npm run buildが通る
- GPSロジックをUIから分離
- 主要な計算ロジックにはテスト可能な純関数を使う
- 二重保存防止
- GPS未対応端末でもクラッシュしない
- 入力値バリデーション
- 目標距離は最低0.1km
- 目標タイム/歩数は0禁止

## 作業手順

1. 現状コードを全確認
2. 型エラー・設計上の問題を修正
3. MVP必須仕様を完成
4. `npm install`
5. `npm run build`
6. エラーがあれば全修正
7. READMEを最新仕様に更新
8. 最後に変更ファイル一覧、実装内容、手動確認手順を報告

途中で確認質問は不要です。
MVP完成まで連続して進めてください。
