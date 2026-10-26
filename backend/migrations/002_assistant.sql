CREATE TABLE assistant_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 0,
  active_chat_id uuid REFERENCES chats(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assistant_turns (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  client_turn_id uuid NOT NULL,
  generation integer NOT NULL,
  user_text text NOT NULL,
  assistant_text text,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','interrupted','failed')),
  error_code text,
  lease_owner uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(session_id,client_turn_id)
);
CREATE INDEX assistant_turns_pending_idx ON assistant_turns(status,lease_expires_at);
CREATE TABLE draft_reviews (
  draft_id uuid NOT NULL REFERENCES message_drafts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  turn_id uuid NOT NULL REFERENCES assistant_turns(id),
  PRIMARY KEY(draft_id,version)
);
CREATE TABLE device_actions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES assistant_sessions(id),
  turn_id uuid NOT NULL REFERENCES assistant_turns(id),
  generation integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('open_chat','play_audio','stop_audio','record_voice')),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','failed','cancelled')),
  expires_at timestamptz NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_actions_pending_idx ON device_actions(user_id,state,expires_at);
