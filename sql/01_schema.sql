-- =====================================================================
-- パーセント・ローズ : スキーマ定義
--   - 完全サーバーレス (Supabase + Vanilla JS) 構成
--   - 正解値(correct_value)はカラムレベルGRANTで anon から完全に隠蔽
--   - answers_log.deviation も同様に隠蔽 (deviationから正解が逆算可能なため)
--   - 「order」は PostgREST のソートクエリ予約語と衝突するため display_order に改名
-- =====================================================================

-- ---- 既存オブジェクトの掃除 (再実行時用) ----------------------------
DROP TABLE IF EXISTS public.answers_log  CASCADE;
DROP TABLE IF EXISTS public.users        CASCADE;
DROP TABLE IF EXISTS public.questions    CASCADE;
DROP TABLE IF EXISTS public.game_status  CASCADE;


-- ---- ① game_status (ゲーム進行管理 / シングルトン) -----------------
CREATE TABLE public.game_status (
  id                     smallint    PRIMARY KEY DEFAULT 1,
  status                 text        NOT NULL
                                     CHECK (status IN ('entry','theme','answer','final_result')),
  current_display_order  int,
  current_question_id    int,
  revealed_correct_value int         CHECK (revealed_correct_value BETWEEN 0 AND 100),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_status_singleton CHECK (id = 1)
);
COMMENT ON COLUMN public.game_status.current_display_order
  IS '現在対象の出題順 (0=テスト, 1〜=本番, entry/final_result時はNULL)';
COMMENT ON COLUMN public.game_status.revealed_correct_value
  IS '正解発表中のみセットされる正解値。theme移行時にNULLへ戻す。';


-- ---- ② questions (問題マスタ) ---------------------------------------
CREATE TABLE public.questions (
  question_id    serial PRIMARY KEY,
  text           text   NOT NULL,
  correct_value  int    NOT NULL CHECK (correct_value BETWEEN 0 AND 100),
  display_order  int    UNIQUE
);
COMMENT ON COLUMN public.questions.display_order
  IS '出題順 (重複不可)。0=テスト, 1〜=本番, NULL=非表示 (ボツ/ストック)';


-- ---- ③ users (ペア・残高) ------------------------------------------
CREATE TABLE public.users (
  line_user_id  text        PRIMARY KEY,
  pair_name     text        NOT NULL CHECK (length(trim(pair_name)) > 0),
  total_roses   int         NOT NULL DEFAULT 100
                            CHECK (total_roses BETWEEN 0 AND 100),
  created_at    timestamptz NOT NULL DEFAULT now()
);


-- ---- ④ answers_log (回答ログ / 一発勝負はこのPKで担保) -------------
CREATE TABLE public.answers_log (
  line_user_id  text        NOT NULL REFERENCES public.users(line_user_id)     ON DELETE CASCADE,
  question_id   int         NOT NULL REFERENCES public.questions(question_id)  ON DELETE CASCADE,
  user_answer   int         CHECK (user_answer IS NULL OR user_answer BETWEEN 0 AND 100),
  deviation     int         NOT NULL CHECK (deviation BETWEEN 0 AND 100),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (line_user_id, question_id)
);
CREATE INDEX answers_log_question_id_idx ON public.answers_log(question_id);


-- =====================================================================
-- Realtime 配信対象に追加 (ユーザー画面が購読)
--   - game_status : ステータス遷移を全代表者へpush
--   - users       : バラ没収アニメ用にtotal_rosesの変動をpush
-- =====================================================================
ALTER PUBLICATION supabase_realtime ADD TABLE public.game_status;
ALTER PUBLICATION supabase_realtime ADD TABLE public.users;


-- =====================================================================
-- 権限設定: 正解漏洩防止のキモ
-- =====================================================================

-- questions: anon は correct_value 以外しか読めない
REVOKE ALL ON public.questions FROM anon, authenticated;
GRANT SELECT (question_id, text, display_order) ON public.questions TO anon, authenticated;

-- answers_log: anon は deviation を読めない (deviation→正解の逆算を防ぐ)
REVOKE ALL ON public.answers_log FROM anon, authenticated;
GRANT SELECT (line_user_id, question_id, user_answer, created_at)
  ON public.answers_log TO anon, authenticated;

-- game_status / users: 読み取りは自由
GRANT SELECT ON public.game_status TO anon, authenticated;
GRANT SELECT ON public.users       TO anon, authenticated;

-- 直接の INSERT/UPDATE/DELETE は一切させない (全て SECURITY DEFINER 関数経由)
REVOKE INSERT, UPDATE, DELETE ON public.game_status, public.users, public.questions, public.answers_log
  FROM anon, authenticated;


-- =====================================================================
-- RLS (Row Level Security) を全テーブルで有効化
--   - SELECTポリシーは上記GRANTを最終的に許可する形で開く
--   - 書き込みは SECURITY DEFINER 関数経由のみ (postgresロールで実行されるためRLSバイパス)
-- =====================================================================
ALTER TABLE public.game_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.answers_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY game_status_read ON public.game_status FOR SELECT USING (true);
CREATE POLICY questions_read   ON public.questions   FOR SELECT USING (true);
CREATE POLICY users_read       ON public.users       FOR SELECT USING (true);
CREATE POLICY answers_log_read ON public.answers_log FOR SELECT USING (true);
