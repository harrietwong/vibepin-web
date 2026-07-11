-- VibePin locale preferences on user_settings (optional — client also persists via auth.user_metadata)
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS app_language text NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS content_language text NOT NULL DEFAULT 'same',
  ADD COLUMN IF NOT EXISTS pinterest_region text NOT NULL DEFAULT 'US';
