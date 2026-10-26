CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE TABLE contacts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, user_id),
  CHECK(owner_id <> user_id)
);
CREATE TABLE chats (
  id uuid PRIMARY KEY,
  direct_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chat_members (
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id uuid,
  PRIMARY KEY(chat_id, user_id)
);
CREATE INDEX chat_members_user_idx ON chat_members(user_id);
CREATE TABLE media (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime_type text NOT NULL,
  byte_size integer NOT NULL CHECK(byte_size > 0),
  digest text NOT NULL,
  duration_ms integer NOT NULL CHECK(duration_ms > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('text', 'voice')),
  text text,
  media_id uuid REFERENCES media(id),
  client_id uuid NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(sender_id, client_id),
  CHECK((kind = 'text' AND text IS NOT NULL AND media_id IS NULL)
    OR (kind = 'voice' AND media_id IS NOT NULL))
);
CREATE INDEX messages_chat_cursor_idx ON messages(chat_id, created_at DESC, id DESC);
ALTER TABLE chat_members ADD CONSTRAINT chat_members_read_fk FOREIGN KEY(last_read_message_id) REFERENCES messages(id);
CREATE TABLE message_drafts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK(kind IN ('text', 'voice')),
  text text,
  media_id uuid REFERENCES media(id),
  version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'editing' CHECK(state IN ('editing', 'ready', 'sent', 'discarded')),
  reviewed_version integer,
  message_id uuid REFERENCES messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((kind = 'text' AND text IS NOT NULL AND media_id IS NULL)
    OR (kind = 'voice' AND media_id IS NOT NULL))
);
CREATE INDEX message_drafts_owner_idx ON message_drafts(owner_id, updated_at DESC);
CREATE TABLE events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_user_cursor_idx ON events(user_id, id);
