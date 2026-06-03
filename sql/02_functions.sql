-- =====================================================================
-- パーセント・ローズ : Database Functions
--   フロント (anon) から RPC で呼び出す。全て SECURITY DEFINER。
--   - register_user        : ペア名エントリー (ゴーストユーザー対策)
--   - submit_answer        : 回答送信 (一発勝負・DBで誤差を内部計算)
--   - advance_to_question  : 管理「問題を表示する」
--   - reveal_answer        : 管理「回答締め切り・正解発表」
--                            未回答強制脱落 / 引き算 / テスト問題スキップを
--                            1トランザクションで一括処理
--   - show_final_result    : 管理「最終結果を表示する」
--   - reset_game           : 管理「初期化」
-- =====================================================================


-- ---- register_user : ペア名を入力してエントリー --------------------
-- LINEアプリ起動だけでは絶対にINSERTしない (ゴーストユーザー対策)。
-- 同じ line_user_id が再エントリーした場合は pair_name を上書き許可。
CREATE OR REPLACE FUNCTION public.register_user(
  p_line_user_id text,
  p_pair_name    text
) RETURNS public.users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.users;
  v_name text;
BEGIN
  v_name := trim(coalesce(p_pair_name, ''));
  IF v_name = '' THEN
    RAISE EXCEPTION 'pair_name is required' USING ERRCODE = '22023';
  END IF;
  -- 項目1: ペア名は8文字以内 (フロントと整合。char_length で多バイト対応)
  IF char_length(v_name) > 8 THEN
    RAISE EXCEPTION 'pair_name_too_long' USING ERRCODE = '22023';
  END IF;
  IF p_line_user_id IS NULL OR length(p_line_user_id) = 0 THEN
    RAISE EXCEPTION 'line_user_id is required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.users (line_user_id, pair_name, total_roses)
  VALUES (p_line_user_id, v_name, 100)
  ON CONFLICT (line_user_id) DO UPDATE
    SET pair_name = EXCLUDED.pair_name
  RETURNING * INTO v_user;

  RETURN v_user;
END;
$$;


-- ---- submit_answer : 回答送信 (一発勝負) ---------------------------
-- 既に同じ (line_user_id, question_id) の行があれば
-- PK重複→ unique_violation を捕まえて 'already_answered' エラーで弾く。
-- 受付は status='theme' かつ current_question_id 一致時のみ。
CREATE OR REPLACE FUNCTION public.submit_answer(
  p_line_user_id text,
  p_question_id  int,
  p_user_answer  int
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status        text;
  v_current_qid   int;
  v_correct       int;
  v_deviation     int;
BEGIN
  -- 入力チェック
  IF p_user_answer IS NULL OR p_user_answer < 0 OR p_user_answer > 100 THEN
    RAISE EXCEPTION 'user_answer must be between 0 and 100' USING ERRCODE = '22023';
  END IF;

  -- ゲーム状態 = theme でなければ受け付けない
  SELECT status, current_question_id
    INTO v_status, v_current_qid
    FROM public.game_status WHERE id = 1;

  IF v_status IS DISTINCT FROM 'theme' THEN
    RAISE EXCEPTION 'answers are not being accepted now (status=%)', v_status
      USING ERRCODE = '22023';
  END IF;

  IF v_current_qid IS DISTINCT FROM p_question_id THEN
    RAISE EXCEPTION 'this question is not currently active' USING ERRCODE = '22023';
  END IF;

  -- 正解値を取得し誤差を計算
  SELECT correct_value INTO v_correct
    FROM public.questions WHERE question_id = p_question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'question % not found', p_question_id USING ERRCODE = '22023';
  END IF;

  v_deviation := abs(v_correct - p_user_answer);

  -- 一発勝負: INSERT のみ (Upsertにしない)
  -- 既存があれば unique_violation を捕まえて専用エラーに変換
  BEGIN
    INSERT INTO public.answers_log (line_user_id, question_id, user_answer, deviation)
    VALUES (p_line_user_id, p_question_id, p_user_answer, v_deviation);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'already_answered' USING ERRCODE = 'P0001';
    WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'user_not_registered' USING ERRCODE = 'P0001';
  END;
END;
$$;


-- ---- advance_to_question : 管理「問題を表示する」-------------------
-- display_order で指定した問題をアクティブにし、status='theme' へ。
-- 前回の revealed_correct_value はクリアする。
CREATE OR REPLACE FUNCTION public.advance_to_question(p_display_order int)
RETURNS public.game_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_qid int;
  v_row public.game_status;
BEGIN
  SELECT question_id INTO v_qid
    FROM public.questions
   WHERE display_order = p_display_order;
  IF v_qid IS NULL THEN
    RAISE EXCEPTION 'no question for display_order %', p_display_order USING ERRCODE = '22023';
  END IF;

  UPDATE public.game_status
     SET status                 = 'theme',
         current_display_order  = p_display_order,
         current_question_id    = v_qid,
         revealed_correct_value = NULL,
         updated_at             = now()
   WHERE id = 1
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;


-- ---- reveal_answer : 管理「回答締め切り・正解発表」-----------------
-- 仕様書 B. の連動ロジックを1トランザクションで一括処理。
--   B-1: 未回答ペアの強制脱落 (テスト問題は total_roses 更新スキップ)
--   B-2,3: 回答ペアの total_roses から deviation を引き算 (下限0, 既0スキップ, テストスキップ)
--   B-4: game_status を 'answer' に遷移し、revealed_correct_value をセット
CREATE OR REPLACE FUNCTION public.reveal_answer()
RETURNS public.game_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_display_order int;
  v_question_id   int;
  v_correct       int;
  v_is_test       boolean;
  v_row           public.game_status;
BEGIN
  SELECT current_display_order, current_question_id
    INTO v_display_order, v_question_id
    FROM public.game_status WHERE id = 1;

  IF v_question_id IS NULL THEN
    RAISE EXCEPTION 'no active question to reveal' USING ERRCODE = '22023';
  END IF;

  SELECT correct_value INTO v_correct
    FROM public.questions WHERE question_id = v_question_id;

  v_is_test := (v_display_order = 0);

  -- ---- B-1-c: 未回答者の補正INSERT (履歴保持) ---------------------
  -- ※テスト/本番どちらでも履歴は残す
  INSERT INTO public.answers_log (line_user_id, question_id, user_answer, deviation)
  SELECT u.line_user_id, v_question_id, NULL, 100
    FROM public.users u
   WHERE NOT EXISTS (
     SELECT 1 FROM public.answers_log a
      WHERE a.line_user_id = u.line_user_id
        AND a.question_id  = v_question_id
   );

  -- ---- B-1-b: 未回答者を強制脱落 (本番のみ) -----------------------
  IF NOT v_is_test THEN
    UPDATE public.users u
       SET total_roses = 0
      FROM public.answers_log a
     WHERE a.line_user_id = u.line_user_id
       AND a.question_id  = v_question_id
       AND a.user_answer  IS NULL;
  END IF;

  -- ---- B-2,3: 回答者の引き算 (本番のみ・下限0・既0スキップ) -------
  IF NOT v_is_test THEN
    UPDATE public.users u
       SET total_roses = GREATEST(0, u.total_roses - a.deviation)
      FROM public.answers_log a
     WHERE a.line_user_id   = u.line_user_id
       AND a.question_id    = v_question_id
       AND a.user_answer    IS NOT NULL
       AND u.total_roses    > 0;
  END IF;

  -- ---- B-4: ステータス遷移 + 正解値を公開 ------------------------
  UPDATE public.game_status
     SET status                 = 'answer',
         revealed_correct_value = v_correct,
         updated_at             = now()
   WHERE id = 1
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;


-- ---- show_final_result : 管理「最終結果を表示する」-----------------
CREATE OR REPLACE FUNCTION public.show_final_result()
RETURNS public.game_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.game_status;
BEGIN
  UPDATE public.game_status
     SET status                 = 'final_result',
         revealed_correct_value = NULL,
         updated_at             = now()
   WHERE id = 1
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;


-- ---- reset_game : 管理「初期化」------------------------------------
-- イベント開始前 / テストプレイ後にエントリー情報ごと完全クリア。
CREATE OR REPLACE FUNCTION public.reset_game()
RETURNS public.game_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.game_status;
BEGIN
  -- Supabase の safe-update ガードは WHERE 句なしの DELETE を拒否する
  -- (ERROR 21000 "DELETE requires a WHERE clause") ため、全件削除でも
  -- WHERE true を明示する。answers_log は users への FK (ON DELETE CASCADE)
  -- を持つので、先に answers_log を消してから users を消す。
  DELETE FROM public.answers_log WHERE true;
  DELETE FROM public.users        WHERE true;

  UPDATE public.game_status
     SET status                 = 'entry',
         current_display_order  = NULL,
         current_question_id    = NULL,
         revealed_correct_value = NULL,
         updated_at             = now()
   WHERE id = 1
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;


-- =====================================================================
-- 実行権限 (anon/authenticated に公開)
--   ※身内30名のイベント前提のためフロント全員から呼べる状態。
--     不正対策を強化したい場合は、管理系関数の第1引数に
--     固定トークン (例: p_admin_token text) を追加してチェックする方式に拡張可能。
-- =====================================================================
GRANT EXECUTE ON FUNCTION public.register_user(text, text)        TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_answer(text, int, int)    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.advance_to_question(int)         TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reveal_answer()                  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.show_final_result()              TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reset_game()                     TO anon, authenticated;
