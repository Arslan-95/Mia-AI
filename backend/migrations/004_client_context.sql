ALTER TABLE assistant_turns ADD COLUMN client_context jsonb;
ALTER TABLE assistant_turns ADD CONSTRAINT assistant_turns_context_object
  CHECK(client_context IS NULL OR jsonb_typeof(client_context) = 'object');
