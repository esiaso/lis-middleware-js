-- Hospital sign-in through OIDC (10 §3). Expand-only.
ALTER TABLE "app_user"
  ADD COLUMN "auth_source" TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN "oidc_issuer" TEXT,
  ADD COLUMN "oidc_subject" TEXT;
CREATE UNIQUE INDEX "app_user_oidc_issuer_oidc_subject_key" ON "app_user"("oidc_issuer", "oidc_subject");
ALTER TABLE "user_session" ADD COLUMN "step_up_at" TIMESTAMPTZ;
