-- Keep account identity and every linked business/audit record when deleting a user.
BEGIN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_by INT REFERENCES users(user_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_deleted_disabled') THEN
    ALTER TABLE users ADD CONSTRAINT users_deleted_disabled CHECK (deleted_at IS NULL OR status = 'disabled');
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_users_deleted ON users (deleted_at DESC) WHERE deleted_at IS NOT NULL;
COMMIT;
