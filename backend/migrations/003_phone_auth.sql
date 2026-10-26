ALTER TABLE users ADD COLUMN phone_number text UNIQUE;
ALTER TABLE users ADD COLUMN profile_complete boolean NOT NULL DEFAULT false;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_phone_format CHECK(phone_number IS NULL OR phone_number ~ '^\+[1-9][0-9]{6,14}$');
CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY,
  phone_number text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone_idx ON otp_challenges(phone_number,created_at DESC);
