import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import { Button, colors, s } from '../ui';

export function AudioControls({ mia, elapsed }: { mia: Mia; elapsed: number }) {
  return (
    <>
      {mia.devicePrompt && (
        <View style={[s.card, a.prompt]}>
          <Text accessibilityRole="alert" style={s.label}>Mia requested a voice note</Text>
          <Text style={s.small}>Choose Record to start a voice note for the requested recipient. Stop to preview before sending.</Text>
          <Button label="Record requested note" icon="mic-outline" onPress={() => void mia.acceptDeviceRecording()} />
          <Button secondary label="Dismiss recording request" onPress={() => void mia.declineDevice().catch(mia.fail)} />
        </View>
      )}
      {mia.audioState === 'recording' ? (
        <View style={[a.audio, a.recordingBackground]}>
          <View style={a.description}>
            <Text style={s.label}>Recording · {elapsed}s</Text>
            <Text style={s.small}>Maximum 2 minutes · stop to preview</Text>
          </View>
          <Button label="Stop recording" icon="stop" onPress={() => void mia.finishRecording().catch(mia.fail)} />
        </View>
      ) : mia.recording ? (
        <View style={a.recording}>
          <Text style={s.label}>{mia.recordPurpose === 'assistant' ? 'Review your spoken request' : 'Your voice note is ready'}</Text>
          <Text style={s.small}>{Math.max(1, Math.round(mia.recording.durationMs / 1000))} seconds · {mia.recordPurpose === 'assistant' ? 'Transcribe, edit, then ask Mia.' : 'Preview before sending.'}</Text>
          <View style={a.actions}>
            <Button secondary label="Preview" icon="play-outline" onPress={() => void mia.preview().catch(mia.fail)} />
            <Button label={mia.recordPurpose === 'assistant' ? 'Transcribe' : 'Send voice note'} loading={mia.busy} onPress={() => void mia.useRecording().catch(mia.fail)} />
            <Button quiet label="Discard recording" onPress={() => void mia.discardRecording().catch(mia.fail)} />
          </View>
        </View>
      ) : null}
      {(mia.audioState === 'playing' || mia.audioState === 'loading' || mia.voiceMode) && mia.audioState !== 'recording' && (
        <View style={a.audio}>
          <Text style={[s.small, a.description]}>{mia.audioState === 'loading' ? 'Preparing spoken response…' : mia.audioState === 'playing' ? 'Playing on this iPhone' : 'Audio controls ready'}</Text>
          <Button secondary label="Stop audio" icon="stop-outline" onPress={() => void mia.stopAudio().catch(mia.fail)} />
        </View>
      )}
    </>
  );
}

const a = StyleSheet.create({
  prompt: { margin: 15 },
  description: { flex: 1 },
  audio: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: 15, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.soft },
  recordingBackground: { backgroundColor: colors.yellow },
  recording: { padding: 18, backgroundColor: colors.yellow, gap: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
});
