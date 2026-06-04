// =====================================================================
// パーセント・ローズ 共通設定
//   - Supabase の URL / anon key を運用者がここに記入してください。
//   - LIFF ID は LINE Developers Console から取得した値を記入してください。
//   - 本ファイルはフロントエンドのみで動くため、anon key 以外を入れないこと。
//
// 動作モードの切り替え（URLパラメータ不要）:
//   - ホスト名が localhost / 127.0.0.1 → ローカル検証モード (LIFF_ID: null)。
//     LIFFを使わず「dev_」プレフィックス付きの擬似 line_user_id が localStorage に保存される。
//   - それ以外 (GitHub Pages 等の本番環境) → LINE の LIFF ID をセット。
// =====================================================================
var isLocalhost =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

window.APP_CONFIG = {
  SUPABASE_URL:  "https://lptoculyhijlrycijepm.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxwdG9jdWx5aGlqbHJ5Y2lqZXBtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NjA1ODEsImV4cCI6MjA5NjAzNjU4MX0.agoRJJZkgz6IkbEnTAoGE6n9qJTkdigl0C5Zct9kXgI",

  // ローカルは null（dev擬似ID）、本番は LINE の LIFF ID。
  // ↓ "YOUR_LIFF_ID_HERE" を LINE Developers Console の LIFF ID に置き換えてください。
  LIFF_ID: isLocalhost ? null : "2010233783-lyQhUKGT",
};
