import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import { Button, classicColors, agentColors, useUi } from '../ui';

export function hasAudioControls(mia: Pick<Mia, 'devicePrompt' | 'audioState' | 'recording' | 'voicePhase' | 'aiMode'>) {
  return Boolean(mia.devicePrompt || mia.audioState === 'recording' || mia.recording
    || !mia.aiMode && (mia.audioState === 'playing' || mia.audioState === 'loading') && mia.voicePhase !== 'speaking');
}

export function AudioControls({ mia, elapsed, bottomInset = 0 }: { mia: Mia; elapsed: number; bottomInset?: number }) {
  const { agent, colors, s } = useUi();
  const a = agent ? agentAudio : classicAudio;
  if (!hasAudioControls(mia)) return null;
  return (
    <View testID="audio-controls" style={{ paddingBottom: bottomInset, backgroundColor: mia.audioState === 'recording' || mia.recording ? colors.yellow : colors.soft }}>
      {mia.devicePrompt && (
        <View style={[s.card, a.prompt]}>
          <Text accessibilityRole="alert" style={s.label}>Record a voice note</Text>
          <Text style={s.small}>Record your message, then listen before sending.</Text>
          <Button label="Record voice note" icon="mic-outline" onPress={() => void mia.acceptDeviceRecording()} />
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
          <Text style={s.label}>Your voice note is ready</Text>
          <Text style={s.small}>{Math.max(1, Math.round(mia.recording.durationMs / 1000))} seconds · Preview before sending.</Text>
          <View style={a.actions}>
            <Button secondary label="Preview" icon="play-outline" onPress={() => void mia.preview().catch(mia.fail)} />
            <Button label="Send voice note" loading={mia.busy} onPress={() => void mia.useRecording().catch(mia.fail)} />
            <Button quiet label="Discard recording" onPress={() => void mia.discardRecording().catch(mia.fail)} />
          </View>
        </View>
      ) : null}
      {!mia.aiMode && (mia.audioState === 'playing' || mia.audioState === 'loading') && mia.voicePhase !== 'speaking' && (
        <View style={a.audio}>
          <Text style={[s.small, a.description]}>{mia.audioState === 'loading' ? 'Preparing audio…' : mia.audioState === 'playing' ? 'Playing' : 'Ready when you are'}</Text>
          <Button secondary label="Stop audio" icon="stop-outline" onPress={() => void mia.stopAudio().catch(mia.fail)} />
        </View>
      )}
    </View>
  );
}

function audioStyles(colors: typeof classicColors) { return StyleSheet.create({
  prompt: { margin: 15 },
  description: { flex: 1 },
  audio: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: 15, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.soft },
  recordingBackground: { backgroundColor: colors.yellow },
  recording: { padding: 18, backgroundColor: colors.yellow, gap: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
}); }
const classicAudio = audioStyles(classicColors);
const agentAudio = audioStyles(agentColors);
