-- =====================================================================
-- パーセント・ローズ : 初期シードデータ
--   - game_status : シングルトン1行 (status='entry')
--   - questions   : テスト1問 + 本番6問
-- =====================================================================

-- ---- game_status シングルトン ---------------------------------------
INSERT INTO public.game_status (id, status, current_display_order, current_question_id, revealed_correct_value)
VALUES (1, 'entry', NULL, NULL, NULL)
ON CONFLICT (id) DO UPDATE
   SET status = 'entry',
       current_display_order = NULL,
       current_question_id = NULL,
       revealed_correct_value = NULL,
       updated_at = now();


-- ---- questions ------------------------------------------------------
-- display_order: 0 = テスト, 1〜 = 本番, NULL = 非表示 (ストック)
-- 数値はサンプル。本番前に運営側で実際の正解に差し替えてください。
TRUNCATE TABLE public.questions RESTART IDENTITY CASCADE;

INSERT INTO public.questions (text, correct_value, display_order) VALUES
  -- テスト問題 (本番のスコアに影響しない)
  ('【練習】日本人で犬を飼っている世帯は何％？',                              13, 0),

  -- 本番問題
  ('20〜40代の社会人で、今年（または昨年）1回以上『キャンプやBBQ』に行った人は何％？', 27, 1),
  ('日本の成人で、毎朝『朝食』をきちんと食べる人は何％？',                    73, 2),
  ('日本の世帯のうち、『持ち家』に住んでいる世帯は何％？',                    61, 3),
  ('日本の20〜40代社会人で、『貯金額が100万円以上』ある人は何％？',           45, 4),
  ('日本人で、SNS（LINE含む）を週1回以上利用している人は何％？',              82, 5),
  ('日本の20〜40代で、過去1年以内に『海外旅行』に行った人は何％？',           18, 6);
