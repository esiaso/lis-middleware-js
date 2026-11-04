-- Comments on results (01 A-26). Expand-only. A comment is never edited or deleted; it can only be withdrawn.
CREATE TABLE "result_comment" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "on_report" BOOLEAN NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_by" TEXT,
    "withdrawn_at" TIMESTAMPTZ,
    "withdraw_reason" TEXT,
    CONSTRAINT "result_comment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "result_comment_text_chk" CHECK (char_length("text") BETWEEN 2 AND 500),
    CONSTRAINT "result_comment_withdrawn_chk" CHECK (("withdrawn_at" IS NULL) = ("withdrawn_by" IS NULL) AND ("withdrawn_at" IS NULL) = ("withdraw_reason" IS NULL))
);
CREATE INDEX "result_comment_result_id_created_at_idx" ON "result_comment"("result_id", "created_at");
ALTER TABLE "result_comment" ADD CONSTRAINT "result_comment_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only the withdrawal columns may change, once; nothing is deleted.
CREATE FUNCTION result_comment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'result_comment rows are never deleted';
  END IF;
  IF OLD.withdrawn_at IS NOT NULL
     OR NEW.id <> OLD.id OR NEW.result_id <> OLD.result_id OR NEW.text <> OLD.text OR NEW.on_report <> OLD.on_report
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a result comment can only be withdrawn, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER result_comment_guard BEFORE UPDATE OR DELETE ON result_comment FOR EACH ROW EXECUTE FUNCTION result_comment_guard();
