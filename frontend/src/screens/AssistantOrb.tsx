import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Mia } from '../useMia';
import { Icon, colors, s } from '../ui';

const labels = {
  off: 'Mia off', waiting: 'Connecting…', listening: 'Listening',
  transcribing: 'Understanding…', thinking: 'Thinking…', speaking: 'Speaking',
  paused: 'Mia on', error: 'Try again',
};

export function AssistantOrb({ mia }: { mia: Mia }) {
  const [focused, setFocused] = useState(false);
  const retry = mia.aiMode && (mia.voicePhase === 'error' || mia.voicePhase === 'waiting');
  const working = ['transcribing', 'thinking', 'speaking'].includes(mia.voicePhase);
  return <View style={orb.slot}>
    <Pressable
      accessibilityRole={retry ? 'button' : 'switch'}
      accessibilityLabel={retry ? 'Retry Mia voice assistant' : `Mia voice mode. ${mia.aiMode ? labels[mia.voicePhase] : 'Off'}`}
      accessibilityHint={retry ? 'Reconnect to Mia. Long press to turn voice mode off.' : mia.aiMode ? 'Turn off hands-free voice control.' : 'Turn on hands-free voice control. Speak after Mia starts listening.'}
      accessibilityState={retry ? undefined : { checked: mia.aiMode }}
      accessibilityActions={mia.aiMode ? [{ name: 'deactivate', label: 'Turn off Mia voice mode' }] : []}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'deactivate') void mia.saveAiMode(false).catch(mia.fail); }}
      onPress={() => void (retry ? mia.resumeAssistant() : mia.saveAiMode(!mia.aiMode)).catch(mia.fail)}
      onLongPress={() => { if (mia.aiMode) void mia.saveAiMode(false).catch(mia.fail); }}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [orb.ring, mia.aiMode && orb.activeRing, focused && s.focus, { opacity: pressed ? .7 : 1 }]}
    >
      <View style={[orb.core, mia.aiMode && orb.activeCore]}>
        {working && mia.voicePhase !== 'speaking' ? <ActivityIndicator color={colors.paper} />
          : <Icon name={retry ? 'refresh' : mia.voicePhase === 'speaking' ? 'volume-high' : mia.aiMode ? 'mic' : 'mic-outline'} color={mia.aiMode ? colors.paper : colors.green} size={28} />}
      </View>
    </Pressable>
    <Text style={[orb.caption, mia.aiMode && { color: colors.green }]}>{labels[mia.voicePhase]}</Text>
  </View>;
}

const orb = StyleSheet.create({
  slot: { width: 94, alignItems: 'center', justifyContent: 'center', gap: 3, paddingTop: 2, paddingBottom: 4 },
  ring: { width: 72, height: 72, borderRadius: 36, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  activeRing: { borderColor: colors.green, backgroundColor: colors.soft },
  core: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  activeCore: { backgroundColor: colors.green },
  caption: { fontSize: 11, fontWeight: '600', color: colors.muted, textAlign: 'center' },
});
