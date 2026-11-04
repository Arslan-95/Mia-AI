CREATE TABLE assistant_message_reads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  heard_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

-- Recover older receipts only when the device completed the original voice
-- note or the narration contained the entire source verbatim.
INSERT INTO assistant_message_reads (user_id, message_id)
SELECT DISTINCT a.user_id, m.id
FROM device_actions a
JOIN messages m ON m.id::text = a.payload->>'messageId' AND m.chat_id::text = a.payload->>'chatId'
JOIN chat_members own ON own.chat_id = m.chat_id AND own.user_id = a.user_id
WHERE a.state = 'completed' AND (
  (a.kind = 'show_message' AND m.kind = 'text' AND m.text = a.payload->>'narration')
  OR (a.kind = 'play_audio' AND m.kind = 'voice' AND m.media_id::text = a.payload->>'mediaId')
);
