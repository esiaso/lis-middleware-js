-- Standard comments entered by the lab (01 A-27). Expand-only. None are shipped.
CREATE TABLE "standard_comment" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "local_test_code" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_by" TEXT,
    "retired_at" TIMESTAMPTZ,
    "retire_reason" TEXT,
    CONSTRAINT "standard_comment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "standard_comment_code_chk" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9-]{1,11}$'),
    CONSTRAINT "standard_comment_text_chk" CHECK (char_length("text") BETWEEN 2 AND 500),
    CONSTRAINT "standard_comment_retired_chk" CHECK ("active" OR ("retired_by" IS NOT NULL AND "retired_at" IS NOT NULL))
);
-- One active comment per code.
CREATE UNIQUE INDEX "standard_comment_one_active" ON "standard_comment"("code") WHERE "active";
