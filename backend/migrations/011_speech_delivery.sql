ALTER TABLE assistant_turns ADD COLUMN speech_delivery jsonb;
ALTER TABLE assistant_turns ADD CONSTRAINT assistant_turns_speech_delivery_object
  CHECK (speech_delivery IS NULL OR jsonb_typeof(speech_delivery) = 'object');
