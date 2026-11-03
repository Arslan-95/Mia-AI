CREATE TABLE voice_exit_requests (
  request_turn_id uuid PRIMARY KEY REFERENCES assistant_turns(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  voice_revision integer NOT NULL CHECK (voice_revision >= 0),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes',
  consumed_by uuid REFERENCES assistant_turns(id) ON DELETE CASCADE
);
