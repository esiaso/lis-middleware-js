-- User management (10 §2, §3): temporary passwords must be changed at next sign-in. Expand-only.
ALTER TABLE "app_user"
  ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "password_changed_at" TIMESTAMPTZ;
