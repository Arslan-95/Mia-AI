CREATE TABLE assistant_memory_settings (
  owner_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  automatic boolean NOT NULL DEFAULT true
);

CREATE TABLE assistant_memories (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  subject text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('identity','preference','relationship','context')),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 80),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 1000),
  source_turn_id uuid NOT NULL REFERENCES assistant_turns(id) ON DELETE CASCADE,
  evidence text NOT NULL CHECK (length(evidence) BETWEEN 1 AND 1000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id,subject,key),
  CHECK (subject = COALESCE(contact_id::text, 'self')),
  CHECK (kind <> 'relationship' OR contact_id IS NOT NULL)
);
CREATE INDEX assistant_memories_owner_idx ON assistant_memories(owner_id,updated_at DESC,id);

-- A forgotten slot has no retained value/evidence. It tells the model not to
-- reconstruct a deleted memory from older conversation history.
CREATE TABLE assistant_forgotten_memories (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject text NOT NULL,
  key text NOT NULL,
  source_turn_id uuid NOT NULL REFERENCES assistant_turns(id) ON DELETE CASCADE,
  forgotten_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,subject,key)
);
