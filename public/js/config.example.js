// =====================================================================
// パーセント・ローズ 共通設定（見本ファイル）
//   - このファイルをコピーして public/js/config.js を作成してください。
//   - Supabase の URL / anon key を運用者がここに記入してください。
//   - LIFF ID は LINE Developers Console から取得した値を記入してください。
//   - 本ファイルはフロントエンドのみで動くため、anon key 以外を入れないこと。
// =====================================================================
window.APP_CONFIG = {
  SUPABASE_URL:  "YOUR_SUPABASE_URL_HERE",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY_HERE",

  // LINEミニアプリの LIFF ID。LIFFを使わずローカル検証する場合は null にすると
  // 「dev_」プレフィックス付きの擬似 line_user_id が sessionStorage（タブ/ウィンドウ単位）に保存される。
  LIFF_ID: null,
};
