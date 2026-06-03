// =====================================================================
// パーセント・ローズ ユーザー画面 ロジック
//   - LIFF 初期化 (LIFF_ID=null の場合は dev モード)
//   - ゴーストユーザー対策: アプリ起動だけではINSERTしない。
//     「エントリーして待機する」ボタン押下時に register_user RPC を呼ぶ。
//   - Realtime: game_status 変化で画面遷移、users 変化でバラ数同期
//   - 一発勝負: 送信ボタン押下後はsessionStorageでも回答済みフラグを保持
// =====================================================================
(function () {
  "use strict";

  const sb = window.sb;
  const cfg = window.APP_CONFIG;

  /* ----------------------- 状態 ----------------------- */
  const state = {
    lineUserId: null,
    pairName:   null,
    totalRoses: null,
    rosesBeforeReveal: null,  // 正解発表前の本数 (アニメ起点)
    gameStatus: null,         // 直近の game_status 行
    currentQId: null,
    currentDisplayOrder: null,
    currentQuestion: null,    // { question_id, text, display_order }
    revealedCorrect: null,
    myAnswer: null,           // 現問の自分の回答 (一発勝負)
    submittedQId: null,       // 送信済みquestion_id (二重送信防止)
    answerPhase: 0,           // 演出フェーズ (0:なし, 1:おじさん, 2:バラ)
    answerTimers: [],
    answerRaf: null,          // ロールダウン用 requestAnimationFrame ハンドル
    answerPlayedQId: null,    // 演出再生済みの question_id (再発火時の二重演出防止)
  };

  /* ----------------------- DOM Helpers ----------------------- */
  const $ = (sel) => document.querySelector(sel);
  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.add("hidden"));
    $("#" + id).classList.remove("hidden");
  }
  function toast(msg, ms = 2400) {
    const holder = $("#toast-holder");
    const el = document.createElement("div");
    el.className = "error-toast";
    el.textContent = msg;
    holder.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /* ----------------------- LIFF 初期化 ----------------------- */
  async function initLineUser() {
    if (cfg.LIFF_ID && window.liff) {
      try {
        await liff.init({ liffId: cfg.LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login();
          return null;
        }
        const profile = await liff.getProfile();
        return profile.userId;
      } catch (e) {
        console.error("[liff] init failed", e);
        toast("LINEログインに失敗しました");
        return null;
      }
    }
    // dev モード: ブラウザごとに固定の擬似ID
    let devId = localStorage.getItem("pr_dev_uid");
    if (!devId) {
      devId = "dev_" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem("pr_dev_uid", devId);
    }
    return devId;
  }

  /* ----------------------- 既存ユーザーの復元 ----------------------- */
  async function loadExistingUser() {
    const { data, error } = await sb
      .from("users")
      .select("line_user_id, pair_name, total_roses")
      .eq("line_user_id", state.lineUserId)
      .maybeSingle();
    if (error) {
      console.warn("[users] load error", error);
      return null;
    }
    return data;
  }

  /* ----------------------- エントリー ----------------------- */
  function setupEntryScreen() {
    const input = $("#pair-name");
    const btn = $("#btn-entry");

    input.addEventListener("input", () => {
      btn.disabled = input.value.trim().length === 0;
    });
    btn.disabled = true;

    btn.addEventListener("click", async () => {
      const name = input.value.trim();
      if (!name) return;
      btn.disabled = true;
      const { data, error } = await sb.rpc("register_user", {
        p_line_user_id: state.lineUserId,
        p_pair_name:    name,
      });
      if (error) {
        console.error("[register_user]", error);
        toast("エントリーに失敗しました。再試行してください。");
        btn.disabled = false;
        return;
      }
      state.pairName   = data.pair_name;
      state.totalRoses = data.total_roses;
      reflectGameStatus();
    });
  }

  /* ----------------------- 出題画面 ----------------------- */
  function setupThemeScreen() {
    const slider = $("#theme-slider");
    const display = $("#theme-input-display");
    const submitBtn = $("#btn-submit");

    const updateVal = (v) => {
      display.textContent = v;
      slider.style.setProperty("--val", v + "%");
    };
    slider.addEventListener("input", (e) => updateVal(e.target.value));
    updateVal(slider.value);

    submitBtn.addEventListener("click", async () => {
      if (state.submittedQId === state.currentQId) return; // 一発勝負 (フロント側)
      const v = parseInt(slider.value, 10);
      submitBtn.disabled = true;
      const { error } = await sb.rpc("submit_answer", {
        p_line_user_id: state.lineUserId,
        p_question_id:  state.currentQId,
        p_user_answer:  v,
      });
      if (error) {
        submitBtn.disabled = false;
        if (error.message && error.message.includes("already_answered")) {
          state.submittedQId = state.currentQId;
          state.myAnswer = v;
          persistAnswer();
          showSubmitted(v);
          return;
        }
        console.error("[submit_answer]", error);
        toast("送信に失敗しました: " + (error.message || "unknown"));
        return;
      }
      state.submittedQId = state.currentQId;
      state.myAnswer = v;
      persistAnswer();
      showSubmitted(v);
    });
  }

  function showSubmitted(v) {
    $("#submitted-value").textContent = v;
    showScreen("screen-submitted");
  }

  /* ----- 回答済みフラグの永続化 (リロード対策) ----- */
  function persistAnswer() {
    sessionStorage.setItem(
      "pr_answer_" + state.currentQId,
      JSON.stringify({ q: state.currentQId, v: state.myAnswer })
    );
  }
  function restoreAnswer(qid) {
    const raw = sessionStorage.getItem("pr_answer_" + qid);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /* ----------------------- 出題切り替え ----------------------- */
  async function loadCurrentQuestion() {
    if (!state.currentDisplayOrder && state.currentDisplayOrder !== 0) {
      state.currentQuestion = null;
      return;
    }
    const { data, error } = await sb
      .from("questions")
      .select("question_id, text, display_order")
      .eq("display_order", state.currentDisplayOrder)
      .maybeSingle();
    if (error || !data) {
      console.warn("[questions] load error", error);
      return;
    }
    state.currentQuestion = data;
    $("#theme-q-text").textContent = data.text;
    const label = data.display_order === 0 ? "練習問題" : `第${data.display_order}問`;
    $("#theme-q-label").textContent = label;
  }

  /* ----------------------- ステータス反映 ----------------------- */
  async function reflectGameStatus() {
    const gs = state.gameStatus;
    if (!gs) return;

    state.currentQId = gs.current_question_id;
    state.currentDisplayOrder = gs.current_display_order;
    state.revealedCorrect = gs.revealed_correct_value;

    // ユーザー未登録 → entry 画面のまま
    if (!state.pairName) { showScreen("screen-entry"); return; }

    if (gs.status === "entry") {
      $("#waiting-pair").textContent = `「${state.pairName}」`;
      $("#waiting-roses").textContent = state.totalRoses;
      showScreen("screen-waiting");
      return;
    }
    if (gs.status === "theme") {
      await loadCurrentQuestion();
      $("#theme-roses").textContent = state.totalRoses;
      // 復元: 回答済みなら submitted 画面
      const saved = restoreAnswer(state.currentQId);
      if (saved) {
        state.submittedQId = saved.q;
        state.myAnswer = saved.v;
        showSubmitted(saved.v);
      } else {
        // スライダーをリセット
        const slider = $("#theme-slider");
        slider.value = 50;
        slider.dispatchEvent(new Event("input"));
        $("#btn-submit").disabled = false;
        showScreen("screen-theme");
      }
      return;
    }
    if (gs.status === "answer") {
      await loadCurrentQuestion();
      runAnswerSequence();
      return;
    }
    if (gs.status === "final_result") {
      renderFinalResult();
      return;
    }
  }

  /* ----------------------- 正解発表 演出シーケンス ----------------------- */
  function clearAnswerTimers() {
    state.answerTimers.forEach((t) => clearTimeout(t));
    state.answerTimers = [];
    if (state.answerRaf) {
      cancelAnimationFrame(state.answerRaf);
      state.answerRaf = null;
    }
    // 飛散中のバラ粒子を後始末
    document.querySelectorAll(".rose-petal").forEach((el) => el.remove());
  }

  // 最終的なバラ残数 N に応じた画像分岐 (厳密化)
  //   N > 75        -> rose_100
  //   75 >= N > 50  -> rose_75
  //   50 >= N > 25  -> rose_50
  //   25 >= N > 0   -> rose_25
  //   N = 0         -> rose_0
  function bouquetFor(n) {
    if (n > 75) return "./images/rose_100.png";
    if (n > 50) return "./images/rose_75.png";
    if (n > 25) return "./images/rose_50.png";
    if (n > 0)  return "./images/rose_25.png";
    return "./images/rose_0.png";
  }

  /* ----- 段階表示ヘルパ ----- */
  function showStep(el)  { el.classList.remove("hidden"); void el.offsetWidth; el.classList.add("in"); }
  function hideStep(el)  { el.classList.add("hidden"); el.classList.remove("in"); }

  /* ----- バラ残数カードの初期状態 (搾取前) を組み立てる ----- */
  function prepareRoseCard(before) {
    const numEl = $("#rose-card-num");
    const labelEl = $("#rose-card-label");
    const bouquet = $("#rose-bouquet");
    const captionEl = $("#rose-card-caption");
    numEl.classList.remove("zero");
    labelEl.textContent = "残りのバラ";
    labelEl.style.whiteSpace = "";
    numEl.innerHTML = `${before}<span class="unit">本</span>`;
    bouquet.src = bouquetFor(before);
    bouquet.classList.remove("shaking");
    captionEl.textContent = "おじさんが近づいてきた…";
    captionEl.style.whiteSpace = "";
  }

  /* ----- バラ残数カードの最終状態 (搾取後) を反映 ----- */
  function finalizeRoseCard(after, didConfiscate) {
    const numEl = $("#rose-card-num");
    const labelEl = $("#rose-card-label");
    const bouquet = $("#rose-bouquet");
    const captionEl = $("#rose-card-caption");
    bouquet.classList.remove("shaking");
    bouquet.src = bouquetFor(after);
    if (after === 0) {
      numEl.classList.add("zero");
      numEl.innerHTML = "0";
      labelEl.textContent = "全部のバラがおじさんに\n没収されました…💐";
      labelEl.style.whiteSpace = "pre-line";
      captionEl.textContent = "バラは0本だけど\n引き続きゲームはエンジョイできます！\n次の画面まで少々お待ちください…";
      captionEl.style.whiteSpace = "pre-line";
    } else {
      numEl.classList.remove("zero");
      numEl.innerHTML = `${after}<span class="unit">本</span>`;
      labelEl.textContent = "残りのバラ";
      labelEl.style.whiteSpace = "";
      captionEl.textContent = "次の画面まで少々お待ちください…";
      captionEl.style.whiteSpace = "";
    }
    if (didConfiscate) fireConfiscateStamp();
  }

  /* ----- 数値のロールダウン (requestAnimationFrame) ----- */
  function rollDownNumber(from, to, duration, onUpdate, onDone) {
    const startT = performance.now();
    const diff = to - from;
    function frame(now) {
      let p = (now - startT) / duration;
      if (p > 1) p = 1;
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      onUpdate(Math.round(from + diff * eased));
      if (p < 1) {
        state.answerRaf = requestAnimationFrame(frame);
      } else {
        state.answerRaf = null;
        onUpdate(to);
        if (onDone) onDone();
      }
    }
    state.answerRaf = requestAnimationFrame(frame);
  }

  /* ----- バラ粒子がおじさんに吸い取られる演出 ----- */
  function spawnRosePetals(count) {
    const numEl = $("#rose-card-num");
    const ojisan = document.querySelector("#phase-ojisan .ojisan-img");
    if (!numEl || !ojisan) return;
    const src = numEl.getBoundingClientRect();
    const dst = ojisan.getBoundingClientRect();
    const sx = src.left + src.width / 2;
    const sy = src.top + src.height / 2;
    const dx = dst.left + dst.width * 0.42;
    const dy = dst.top + dst.height * 0.45;
    for (let i = 0; i < count; i++) {
      const petal = document.createElement("div");
      petal.className = "rose-petal";
      petal.textContent = "🌹";
      const jitterX = (Math.random() - 0.5) * 44;
      const jitterY = (Math.random() - 0.5) * 20;
      petal.style.left = (sx + jitterX) + "px";
      petal.style.top = (sy + jitterY) + "px";
      document.body.appendChild(petal);
      // 次フレームで目標へ吸い込む
      requestAnimationFrame(() => {
        const delay = Math.random() * 180;
        petal.style.transition =
          `transform .7s cubic-bezier(.5,-0.2,.7,1) ${delay}ms, opacity .7s ease ${delay}ms`;
        petal.style.transform =
          `translate(${dx - sx - jitterX}px, ${dy - sy - jitterY}px) scale(.3) rotate(${(Math.random() - 0.5) * 220}deg)`;
        petal.style.opacity = "0";
      });
      setTimeout(() => petal.remove(), 1100);
    }
  }

  /* ----- 没収スタンプ押印 + 画面シェイク ----- */
  function fireConfiscateStamp() {
    const stamp = $("#confiscate-stamp");
    if (stamp) {
      stamp.classList.remove("show");
      void stamp.offsetWidth; // アニメ再起動
      stamp.classList.add("show");
    }
    const stage = $("#stage");
    if (stage) {
      stage.classList.remove("shake");
      void stage.offsetWidth;
      stage.classList.add("shake");
      state.answerTimers.push(setTimeout(() => stage.classList.remove("shake"), 600));
    }
  }

  /* ----- 搾取（カウントダウン）開始 ----- */
  function startConfiscation(before, after) {
    const numEl = $("#rose-card-num");
    const bouquet = $("#rose-bouquet");
    const loss = before - after;

    if (loss <= 0) {
      // 没収なし（ピタリ賞など）
      finalizeRoseCard(after, false);
      return;
    }

    // バラを揺らしながら粒子を吸い取る
    bouquet.classList.add("shaking");
    const bursts = 5;
    for (let i = 0; i < bursts; i++) {
      state.answerTimers.push(setTimeout(() => spawnRosePetals(3), i * 320));
    }

    const duration = Math.min(1900, Math.max(750, loss * 22));
    let lastSrc = bouquet.getAttribute("src");
    rollDownNumber(
      before, after, duration,
      (val) => {
        numEl.innerHTML = `${val}<span class="unit">本</span>`;
        // カウントダウン途中でも閾値を跨いだら画像を切り替える
        const next = bouquetFor(val);
        if (next !== lastSrc) { bouquet.src = next; lastSrc = next; }
      },
      () => finalizeRoseCard(after, true)
    );
  }

  async function runAnswerSequence() {
    clearAnswerTimers();

    // 自分の回答を取得 (sessionStorage → なければ answers_log)
    let myAns = state.myAnswer;
    if (myAns == null) {
      const saved = restoreAnswer(state.currentQId);
      if (saved) myAns = saved.v;
    }
    if (myAns == null) {
      const { data } = await sb
        .from("answers_log")
        .select("user_answer")
        .eq("line_user_id", state.lineUserId)
        .eq("question_id", state.currentQId)
        .maybeSingle();
      if (data && data.user_answer != null) myAns = data.user_answer;
    }

    const correct = state.revealedCorrect;
    const unanswered = (myAns == null);
    const deviation = unanswered ? 100 : Math.abs(correct - myAns);

    // --- 正解カードの内容 (第1段階で表示) ---
    $("#answer-correct").textContent = correct == null ? "―" : correct;
    const yourEl = $("#answer-your");
    if (unanswered) {
      yourEl.classList.add("unanswered");
      yourEl.textContent = "あなたの回答は未回答です。";
      $("#answer-dev").classList.add("hidden");
      $("#answer-bubble").textContent = "未回答は全部没収しちゃうよー。";
    } else {
      yourEl.classList.remove("unanswered");
      yourEl.textContent = `あなたの回答 ${myAns}%`;
      $("#answer-dev").textContent = `誤差 ${deviation}`;
      $("#answer-dev").classList.remove("hidden");
      $("#answer-bubble").textContent =
        deviation === 0 ? "ピタリ賞！今回は没収なしだよ。" : "誤差の分だけ没収するよーん。";
    }

    // 開始時の総バラ数を記憶 (アニメ起点)
    if (state.rosesBeforeReveal == null) state.rosesBeforeReveal = state.totalRoses;
    const before = state.rosesBeforeReveal;
    // 本番想定の残数 (テストでも演出上は引く)
    const simulatedAfter = unanswered ? 0 : Math.max(0, before - deviation);

    const ojisan = $("#phase-ojisan");
    const roseCard = $("#phase-roses");

    showScreen("screen-answer");

    // 再発火 (Realtime で answer 中に行が更新される等) → 演出を繰り返さず最終状態へ
    if (state.answerPlayedQId === state.currentQId) {
      showStep(ojisan);
      showStep(roseCard);
      prepareRoseCard(before);
      finalizeRoseCard(simulatedAfter, false);
      return;
    }
    state.answerPlayedQId = state.currentQId;

    // --- 第1段階: 正解見出し＋正解カードのみ。おじさん／バラは伏せる ---
    hideStep(ojisan);
    hideStep(roseCard);
    $("#confiscate-stamp").classList.remove("show");
    prepareRoseCard(before);

    // --- 第2段階: おじさん登場 (約1.2秒後) ---
    state.answerTimers.push(setTimeout(() => showStep(ojisan), 1200));

    // --- 第3段階: バラ残数カードを被せて表示 → 搾取カウントダウン開始 (約2.4秒後) ---
    state.answerTimers.push(setTimeout(() => {
      showStep(roseCard);
      // カード登場アニメ後に搾取開始
      state.answerTimers.push(setTimeout(() => startConfiscation(before, simulatedAfter), 550));
    }, 2400));
  }

  /* ----------------------- 最終結果 ----------------------- */
  async function renderFinalResult() {
    const { data: users, error } = await sb
      .from("users")
      .select("line_user_id, pair_name, total_roses")
      .order("total_roses", { ascending: false });
    if (error) {
      console.error("[result]", error);
      toast("結果取得に失敗しました");
      return;
    }
    const clearedSorted = users.filter((u) => u.total_roses > 0);

    const me = users.find((u) => u.line_user_id === state.lineUserId);
    const myRank = clearedSorted.findIndex((u) => u.line_user_id === state.lineUserId);

    const summary = $("#result-summary");
    if (me && me.total_roses > 0) {
      summary.innerHTML = `
        <div class="lbl">あなたのペアは</div>
        <div class="rank-num">${myRank + 1}<span class="pos">位</span></div>
        <div class="rose-num">バラ${me.total_roses}本</div>
      `;
    } else {
      summary.innerHTML = `
        <div class="lbl">あなたのペアは</div>
        <div class="lose">残念脱落…💐</div>
        <div class="rose-num">バラ0本</div>
      `;
    }

    const listEl = $("#ranking-list");
    if (clearedSorted.length === 0) {
      listEl.innerHTML = `<div class="empty">残念ながら、達成者はいませんでした…</div>`;
    } else {
      listEl.innerHTML = clearedSorted.map((u, idx) => {
        const pos = idx + 1;
        const isMe = u.line_user_id === state.lineUserId;
        const goldClass = pos === 1 ? "gold" : "";
        const escapedName = escapeHtml(u.pair_name);
        return `
          <div class="rank-item${isMe ? " me" : ""}">
            <div class="left">
              <span class="rank ${goldClass}">${pos}<span class="pos">位</span></span>
              <span class="pair-name">${escapedName}</span>
            </div>
            <div class="roses"><span class="lbl">バラ</span>${u.total_roses}</div>
          </div>
        `;
      }).join("");
    }

    showScreen("screen-result");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  /* ----------------------- Realtime 購読 ----------------------- */
  function subscribeRealtime() {
    sb.channel("rt-game-status")
      .on("postgres_changes",
        { event: "*", schema: "public", table: "game_status" },
        async (payload) => {
          const prev = state.gameStatus ? state.gameStatus.status : null;
          state.gameStatus = payload.new;
          // 状態がanswer以外に遷移したらアニメ起点・演出状態をリセット
          if (state.gameStatus.status !== "answer") {
            state.rosesBeforeReveal = null;
            state.answerPlayedQId = null;
            clearAnswerTimers();
          }
          // 出題が切り替わったら回答済みフラグもリセット
          if (state.gameStatus.current_question_id !== state.submittedQId) {
            state.submittedQId = null;
            state.myAnswer = null;
          }
          await reflectGameStatus();
        })
      .subscribe();

    sb.channel("rt-users-self")
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "users",
          filter: `line_user_id=eq.${state.lineUserId}` },
        (payload) => {
          state.totalRoses = payload.new.total_roses;
          $("#waiting-roses").textContent = state.totalRoses;
          $("#theme-roses").textContent = state.totalRoses;
        })
      .subscribe();
  }

  /* ----------------------- 起動 ----------------------- */
  async function loadGameStatus() {
    const { data } = await sb.from("game_status").select("*").eq("id", 1).maybeSingle();
    state.gameStatus = data;
  }

  async function bootstrap() {
    setupEntryScreen();
    setupThemeScreen();

    const uid = await initLineUser();
    if (!uid) return;
    state.lineUserId = uid;

    const existing = await loadExistingUser();
    if (existing) {
      state.pairName   = existing.pair_name;
      state.totalRoses = existing.total_roses;
    } else {
      state.totalRoses = 100;
    }

    await loadGameStatus();
    subscribeRealtime();
    await reflectGameStatus();
  }

  document.addEventListener("DOMContentLoaded", bootstrap);
})();
