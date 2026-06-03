// =====================================================================
// パーセント・ローズ 共通 Supabase クライアント
//   - CDN版 @supabase/supabase-js が <script> で先に読み込まれている前提
//   - window.sb として全画面から利用
// =====================================================================
(function () {
  if (!window.supabase || !window.supabase.createClient) {
    console.error("[percent-rose] Supabase JS が読み込まれていません。HTMLの <script> 順を確認してください。");
    return;
  }
  if (!window.APP_CONFIG || !window.APP_CONFIG.SUPABASE_URL) {
    console.error("[percent-rose] config.js が読み込まれていません。");
    return;
  }

  window.sb = window.supabase.createClient(
    window.APP_CONFIG.SUPABASE_URL,
    window.APP_CONFIG.SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 5 } },
    }
  );
})();
