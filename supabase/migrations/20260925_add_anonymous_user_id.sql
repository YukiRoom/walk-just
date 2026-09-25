-- WALK JUST! ニックネーム登録機能：challenge_results に端末ごとの匿名ユーザーIDを追加する
--
-- 安全性:
--   * public.challenge_results のみを対象とする（okimemo用テーブル・他テーブルには一切触れない）
--   * NULL許可の列追加とインデックス作成のみ。既存行は anonymous_user_id = NULL のまま残る
--   * DROP / DELETE / UPDATE は行わない
--   * IF NOT EXISTS により何度実行しても安全
--
-- 注意: anonymous_user_id はブラウザの localStorage で生成した識別子であり、認証情報ではありません。
--       同じニックネームの別ユーザーを区別するための値です（既存の user_id 列・RLSポリシーは変更しません）。

alter table public.challenge_results
  add column if not exists anonymous_user_id uuid null;

create index if not exists challenge_results_anonymous_user_idx
  on public.challenge_results(anonymous_user_id);

-- PostgREST のスキーマキャッシュを更新し、APIから新しい列をすぐ使えるようにする
notify pgrst, 'reload schema';
