ALTER TABLE device_actions DROP CONSTRAINT device_actions_kind_check;
ALTER TABLE device_actions ADD CONSTRAINT device_actions_kind_check
  CHECK(kind IN ('open_chat','play_audio','stop_audio','record_voice','set_voice_mode','set_microphone_muted'));
