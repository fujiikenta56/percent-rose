// =====================================================================
// パーセント・ローズ 管理画面 ロジック
//   - game_status の現在値に応じて4種類のビューを切り替え
//   - 進行トリガーボタン押下時は確認ダイアログを出して誤操作防止
//   - 質問の遷移は display_order の昇順 (0=テスト, 1〜=本番) で自動進行
// =====================================================================
(function () {
  "use strict";

  const sb = window.sb;

  const state = {
    gameStatus: null,
    questions:  [],   // display_order ASC で並んでいる
  };

  const $ = (sel) => document.querySelector(sel);

  /* バラ残数を 0〜100 の整数へ正規化 (NaN/負値/範囲外を排除) */
  function clampRoses(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /* ----------------------- Toast / Modal ----------------------- */
  function toast(msg, ms = 2400) {
    const holder = $("#toast-holder");
    const el = document.createElement("div");
    el.className = "error-toast";
    el.textContent = msg;
    holder.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  function confirmDialog(msg) {
    return new Promise((resolve) => {
      const backdrop = document.createElement("div");
      backdrop.className = "modal-backdrop";
      backdrop.innerHTML = `
        <div class="modal-box">
          <div class="msg">${msg.replace(/\n/g, "<br/>")}</div>
          <div class="actions">
            <button class="cancel" type="button">キャンセル</button>
            <button class="ok" type="button">OK</button>
          </div>
        </div>`;
      backdrop.querySelector(".ok").onclick = () => { backdrop.remove(); resolve(true); };
      backdrop.querySelector(".cancel").onclick = () => { backdrop.remove(); resolve(false); };
      document.body.appendChild(backdrop);
    });
  }

  /* ----------------------- View 切り替え ----------------------- */
  function showView(name) {
    document.querySelectorAll(".admin-view").forEach((el) => el.classList.add("hidden"));
    const el = $("#admin-view-" + name);
    if (el) el.classList.remove("hidden");
  }

  /* ----------------------- 初期データ ----------------------- */
  async function loadQuestions() {
    const { data, error } = await sb
      .from("questions")
      .select("question_id, text, display_order")
      .not("display_order", "is", null)
      .order("display_order", { ascending: true });
    if (error) {
      console.error("[questions]", error);
      toast("問題の読み込みに失敗しました");
      return;
    }
    state.questions = data;
  }

  async function loadGameStatus() {
    const { data } = await sb.from("game_status").select("*").eq("id", 1).maybeSingle();
    state.gameStatus = data;
  }

  /* ----------------------- カウント情報 (entry/theme表示用) ----------------------- */
  async function loadCounts() {
    const { count: userCount } = await sb.from("users").select("*", { count: "exact", head: true });
    $("#entry-count").textContent = userCount ?? 0;
    $("#user-count").textContent = userCount ?? 0;

    if (state.gameStatus && state.gameStatus.current_question_id) {
      const { count: ansCount } = await sb
        .from("answers_log")
        .select("*", { count: "exact", head: true })
        .eq("question_id", state.gameStatus.current_question_id)
        .not("user_answer", "is", null);
      $("#answer-count").textContent = ansCount ?? 0;
    }
  }

  /* ----------------------- 反映 ----------------------- */
  async function reflect() {
    const gs = state.gameStatus;
    if (!gs) return;

    if (gs.status === "entry") {
      showView("entry");
      await loadCounts();
      return;
    }
    if (gs.status === "theme") {
      const q = state.questions.find((q) => q.question_id === gs.current_question_id);
      const order = gs.current_display_order;
      $("#admin-q-label").textContent = order === 0 ? "練習問題" : `第${order}問`;
      $("#admin-q-text").textContent = q ? q.text : "―";
      showView("theme");
      await loadCounts();
      return;
    }
    if (gs.status === "answer") {
      $("#admin-correct").textContent = (gs.revealed_correct_value ?? "―") + "%";
      // 最終問題かどうか判定
      const idx = state.questions.findIndex((q) => q.display_order === gs.current_display_order);
      const isLast = (idx === state.questions.length - 1);
      $("#btn-next").classList.toggle("hidden", isLast);
      $("#btn-final").classList.toggle("hidden", !isLast);
      showView("answer");
      return;
    }
    if (gs.status === "final_result") {
      await renderRanking();
      showView("result");
      return;
    }
  }

  async function renderRanking() {
    const { data } = await sb
      .from("users")
      .select("line_user_id, pair_name, total_roses")
      .order("total_roses", { ascending: false });
    // 残数を正規化 (NaN/負値/範囲外→0〜100) し、0本(脱落)を確実に除外・整列
    const normalized = (data || []).map((u) => ({ ...u, roses: clampRoses(u.total_roses) }));
    const cleared = normalized
      .filter((u) => u.roses > 0)
      .sort((a, b) => b.roses - a.roses);
    const list = $("#admin-ranking-list");
    if (cleared.length === 0) {
      list.innerHTML = `<div class="empty" style="color:#fff;opacity:0.8;">達成者はいませんでした…</div>`;
      return;
    }
    list.innerHTML = cleared.map((u, idx) => {
      const pos = idx + 1;
      const goldClass = pos === 1 ? "gold" : "";
      return `
        <div class="rank-item">
          <div class="left">
            <span class="rank ${goldClass}">${pos}<span class="pos">位</span></span>
            <span class="pair-name">${escapeHtml(u.pair_name)}</span>
          </div>
          <div class="roses"><span class="lbl">バラ</span>${u.roses}</div>
        </div>`;
    }).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  /* ----------------------- ボタン: 問題を表示 (entry → theme) ----------------------- */
  async function onStart() {
    const ok = await confirmDialog("クイズを開始します。\n全員の画面が「出題」に切り替わります。よろしいですか？");
    if (!ok) return;
    const first = state.questions[0];
    if (!first) { toast("問題が登録されていません"); return; }
    const { error } = await sb.rpc("advance_to_question", { p_display_order: first.display_order });
    if (error) { console.error(error); toast("開始に失敗しました"); }
  }

  /* ----------------------- ボタン: 正解を表示 (theme → answer) ----------------------- */
  async function onReveal() {
    const ok = await confirmDialog("回答を締め切って正解を表示します。\nこの操作はもとに戻せません。よろしいですか？");
    if (!ok) return;
    const { error } = await sb.rpc("reveal_answer");
    if (error) { console.error(error); toast("正解表示に失敗しました"); }
  }

  /* ----------------------- ボタン: 次の問題へ (answer → theme) ----------------------- */
  async function onNext() {
    const gs = state.gameStatus;
    const idx = state.questions.findIndex((q) => q.display_order === gs.current_display_order);
    const next = state.questions[idx + 1];
    if (!next) { toast("次の問題がありません"); return; }
    const ok = await confirmDialog(`次の問題（${next.display_order === 0 ? "練習" : "第"+next.display_order+"問"}）に進みます。よろしいですか？`);
    if (!ok) return;
    const { error } = await sb.rpc("advance_to_question", { p_display_order: next.display_order });
    if (error) { console.error(error); toast("次へ進むのに失敗しました"); }
  }

  /* ----------------------- ボタン: 最終結果へ ----------------------- */
  async function onFinal() {
    const ok = await confirmDialog("最終結果を表示します。\n全員の画面にランキングが表示されます。よろしいですか？");
    if (!ok) return;
    const { error } = await sb.rpc("show_final_result");
    if (error) { console.error(error); toast("最終結果表示に失敗しました"); }
  }

  /* ----------------------- ボタン: リセット ----------------------- */
  async function onReset() {
    const ok = await confirmDialog("⚠️ システムを初期状態に戻します。\nエントリー情報と回答ログを全削除します。本当によろしいですか？");
    if (!ok) return;
    const ok2 = await confirmDialog("最終確認: 本当にリセットしますか？");
    if (!ok2) return;
    const { error } = await sb.rpc("reset_game");
    if (error) { console.error(error); toast("リセットに失敗しました"); return; }
    toast("リセットしました");
  }

  /* ----------------------- Realtime ----------------------- */
  function subscribeRealtime() {
    sb.channel("admin-rt-status")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "game_status" },
        async (payload) => {
          state.gameStatus = payload.new;
          await reflect();
        })
      .subscribe();

    // 回答数とエントリー数の自動更新
    sb.channel("admin-rt-counts")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "users" },
        () => loadCounts())
      .on("postgres_changes",
        { event: "*", schema: "public", table: "answers_log" },
        () => loadCounts())
      .subscribe();
  }

  /* ----------------------- 起動 ----------------------- */
  async function bootstrap() {
    $("#btn-start").onclick  = onStart;
    $("#btn-reveal").onclick = onReveal;
    $("#btn-next").onclick   = onNext;
    $("#btn-final").onclick  = onFinal;
    $("#btn-reset").onclick  = onReset;

    await loadQuestions();
    await loadGameStatus();
    subscribeRealtime();
    await reflect();
  }

  document.addEventListener("DOMContentLoaded", bootstrap);
})();
