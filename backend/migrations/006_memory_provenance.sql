-- Long-term knowledge belongs to the account, independently of the lifetime
-- of the conversation that supplied its provenance.
ALTER TABLE assistant_memories ALTER COLUMN source_turn_id DROP NOT NULL;
ALTER TABLE assistant_memories DROP CONSTRAINT assistant_memories_source_turn_id_fkey;
ALTER TABLE assistant_memories ADD CONSTRAINT assistant_memories_source_turn_id_fkey
  FOREIGN KEY(source_turn_id) REFERENCES assistant_turns(id) ON DELETE SET NULL;
ALTER TABLE assistant_forgotten_memories ALTER COLUMN source_turn_id DROP NOT NULL;
ALTER TABLE assistant_forgotten_memories DROP CONSTRAINT assistant_forgotten_memories_source_turn_id_fkey;
ALTER TABLE assistant_forgotten_memories ADD CONSTRAINT assistant_forgotten_memories_source_turn_id_fkey
  FOREIGN KEY(source_turn_id) REFERENCES assistant_turns(id) ON DELETE SET NULL;
