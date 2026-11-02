-- Store only consumed token digests to prevent credential replay. Account,
-- contact and chat identities continue to use the existing verified number.
CREATE TABLE firebase_sign_ins (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX firebase_sign_ins_expiry_idx ON firebase_sign_ins(expires_at);
