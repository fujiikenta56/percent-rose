// =====================================================================
// パーセント・ローズ 共通 Supabase クライアント
//   - CDN版 @supabase/supabase-js が <script> で先に読み込まれている前提
//   - window.sb として全画面から利用
// =====================================================================
(function () {
  // 画面が「真っ白」にならないよう、致命的な初期化失敗は画面上にも表示する。
  function fatal(msg) {
    console.error("[percent-rose] " + msg);
    var holder = document.getElementById("toast-holder") || document.body;
    var el = document.createElement("div");
    el.className = "error-toast";
    el.style.cssText =
      "position:fixed;left:12px;right:12px;bottom:16px;z-index:9999;" +
      "background:#b3261e;color:#fff;padding:12px 14px;border-radius:10px;" +
      "font-size:13px;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.35);";
    el.textContent = "初期化に失敗しました: " + msg;
    if (holder) holder.appendChild(el);
  }

  if (!window.supabase || !window.supabase.createClient) {
    fatal("Supabase JS が読み込まれていません。HTMLの <script> 順 / ネットワークを確認してください。");
    return;
  }
  if (!window.APP_CONFIG || !window.APP_CONFIG.SUPABASE_URL) {
    // 最頻出: GitHub Pages 等に config.js がデプロイされておらず 404 になっているケース。
    fatal("config.js が読み込まれていません（404 の可能性）。public/js/config.js がデプロイされているか確認してください。");
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
