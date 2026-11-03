import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { build } from 'esbuild';
import type { VoicePhase } from '../src/voiceConversation';

// Model the native angle separately from the cached JS value, and control
// completion/readback explicitly to exercise interrupted native animations.
const native = `const n = globalThis.__orbNative;
  export const Easing = { sin: Math.sin, inOut: f => f, linear: t => t };
  export const View = 'View', Text = 'Text';
  export const StyleSheet = { create: x => x };
  export const useWindowDimensions = () => ({ height: 800, fontScale: 1 });
  export const Animated = {
    View: 'AnimatedView', add: (...inputs) => ({ inputs }), multiply: (...inputs) => ({ inputs }),
    Value: class {
      constructor(value) { this.value = value; this.nativeValue = value; this.writes = []; n.values.push(this); }
      setValue(value) { this.writes.push(value); this.value = this.nativeValue = value; }
      interpolate(config) { return { value: this, config }; }
      stopAnimation(callback) {
        this.animation?.stop();
        if (callback) { const read = () => callback(this.nativeValue); if (n.holdReads) n.reads.push(read); else read(); }
      }
    },
    timing(value, config) {
      const a = { value, config, started: false, stopped: false,
        start(callback) {
          value.animation = a; a.started = true; a.callback = callback; a.from = value.nativeValue;
          if (config.duration === 0) a.finish();
        },
        stop() { if (a.stopped) return; a.stopped = true; a.callback?.({ finished: false }); },
        finish() { if (a.stopped) return; value.nativeValue = config.toValue; a.callback?.({ finished: true }); },
      }; n.timings.push(a); return a;
    },
    sequence(children) {
      let index = 0;
      return { children, start(callback) {
        const next = result => { if (!result.finished) return callback?.(result);
          if (++index < children.length) children[index].start(next); else callback?.(result); };
        children[index].start(next);
      }, stop() { children[index]?.stop(); } };
    },
    loop(child, config) {
      const loop = { child, config, stopped: false, start() { child.start(); }, stop() { loop.stopped = true; child.stop(); } };
      n.loops.push(loop); return loop;
    },
  };`;
const bundle = build({
  entryPoints: [fileURLToPath(new URL('../src/screens/AssistantOrb.tsx', import.meta.url).toString())],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  plugins: [{ name: 'orb-native', setup(builder) {
    builder.onResolve({ filter: /^(react-native|\.\.\/ui|\.\.\/motion|\.\/AgentRecordingAura|\.\/ConversationStatus)$/ }, args => ({ path: args.path, namespace: 'orb-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'orb-native' }, args => ({ contents: args.path === 'react-native' ? native
      : args.path === '../motion' ? 'export const useReducedMotion = () => globalThis.__orbNative.reduced;'
      : args.path === '../ui' ? "export const Icon = 'Icon'; export const agentColors = {};"
      : 'export const AgentRecordingAura = () => null; export const ConversationStatus = () => null;' }));
  } }],
});
type Value = { value: number; nativeValue: number; writes: number[] };
type Timing = { value: Value; config: { toValue: number; duration: number; easing(t: number): number; useNativeDriver: boolean; isInteraction: boolean }; started: boolean; stopped: boolean; finish(): void; callback?(result: { finished: boolean }): void };
async function mount(phase: VoicePhase, recording = false) {
  const n = { reduced: false, holdReads: false, reads: [] as (() => void)[], values: [] as Value[], timings: [] as Timing[], loops: [] as any[] };
  Object.assign(globalThis, { __orbNative: n, IS_REACT_ACT_ENVIRONMENT: true });
  const module = { exports: {} as any };
  new Function('require', 'module', 'exports', (await bundle).outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports);
  const { MiaCore } = module.exports;
  let renderer: ReactTestRenderer;
  const sample = (phase: VoicePhase, recording = false, microphoneMuted = false) => React.createElement(MiaCore, { phase, recording, microphoneMuted });
  await act(async () => { renderer = create(sample(phase, recording)); });
  const flatten = (style: any): any => Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style;
  const views = () => renderer!.root.findAll(node => node.type === 'AnimatedView' as any);
  const styleOf = (key: string) => flatten(views().find(node => key in flatten(node.props.style))!.props.style);
  const orbit = () => styleOf('borderLeftColor').transform[0].rotate.value as Value;
  const sphere = () => styleOf('overflow');
  const pulse = () => sphere().transform[0].scale.inputs[0].value as Value;
  const decoration = (id: string) => renderer!.root.findAll(node => node.props.testID === id)[0];
  const latest = (value: Value) => n.timings.filter(a => a.value === value && a.started && !a.stopped).at(-1)!;
  return { n, orbit, pulse, sphere, decoration, latest,
    async update(phase: VoicePhase, recording = false, microphoneMuted = false) { await act(async () => { renderer!.update(sample(phase, recording, microphoneMuted)); }); },
    async close() { await act(async () => { renderer!.unmount(); }); },
  };
}

test('all voice-phase pairs preserve the displayed angle and pulse without direct resets', async () => {
  const phases: VoicePhase[] = ['off', 'waiting', 'listening', 'transcribing', 'thinking', 'speaking', 'paused', 'error'];
  for (const from of phases) for (const to of phases) {
    const h = await mount(from);
    try {
      const rotation = h.orbit(), pulse = h.pulse();
      rotation.nativeValue = .371; pulse.nativeValue = .63;
      await h.update(to);
      assert.equal(h.orbit(), rotation, `${from} → ${to}: same rotation node`);
      assert.equal(h.pulse(), pulse);
      assert.equal(rotation.nativeValue, .371, `${from} → ${to}: no angle jump`);
      assert.equal(pulse.nativeValue, .63, `${from} → ${to}: no pulse jump`);
      assert.ok(h.n.values.every(value => value.writes.length === 0));
      assert.ok(h.n.timings.every(a => a.config.useNativeDriver && !a.config.isInteraction));
    } finally { await h.close(); }
  }
});

test('input mute dims the orb independently of the output phase without restarting its motion', async () => {
  for (const phase of ['speaking', 'thinking', 'waiting'] as const) {
    const h = await mount(phase);
    try {
      const standby = h.sphere().opacity.value as Value;
      const rotation = h.orbit(), pulse = h.pulse();
      rotation.nativeValue = .37; pulse.nativeValue = .6;
      const loops = h.n.loops.length;
      const orbitAnimation = h.latest(rotation), pulseAnimation = h.latest(pulse);
      await h.update(phase, false, true);
      assert.equal(h.sphere().opacity.value, standby);
      assert.equal(h.latest(standby).config.toValue, 1, `${phase}: mute fades to the dimmed appearance`);
      assert.equal(h.latest(standby).config.duration, 400);
      h.latest(standby).finish();
      const [normal, muted] = h.sphere().opacity.config.outputRange;
      assert.equal(normal + (muted - normal) * standby.nativeValue, .65);
      assert.equal(h.sphere().backgroundColor.value, standby, 'mute also changes the sphere color');
      await h.update(phase, false, false);
      assert.equal(h.latest(standby).config.toValue, 0, `${phase}: unmute restores the normal appearance`);
      assert.equal(h.latest(rotation), orbitAnimation);
      assert.equal(h.latest(pulse), pulseAnimation);
      assert.equal(h.n.loops.length, loops, 'input mute leaves the current output animation running');
      assert.equal(rotation.nativeValue, .37);
      assert.equal(pulse.nativeValue, .6);
      assert.deepEqual(standby.writes, []);
    } finally { await h.close(); }
  }
});

test('mute brakes from the native angle; interrupted unmute and thinking ramp from the current velocity', async () => {
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const h = await mount('listening');
  try {
    const rotation = h.orbit();
    h.latest(rotation).finish(); // Finish acceleration and start a native full-turn loop.
    now += 500;
    rotation.nativeValue = .37; // Deliberately leave the JS cache at zero.
    await h.update('paused');
    const brake = h.latest(rotation);
    assert.equal(brake.config.toValue, .37 + 400 / 16000 / 2);
    assert.equal(brake.config.easing(0), 0);
    assert.equal(brake.config.easing(1), 1);
    assert.ok((1 - brake.config.easing(.999)) < .00001, 'the brake ends at zero velocity');
    now += 200;
    rotation.nativeValue = .37 + (brake.config.toValue - .37) * brake.config.easing(.5);
    const interruptedAngle = rotation.nativeValue;
    await h.update('speaking');
    const resume = h.latest(rotation);
    assert.equal(rotation.nativeValue, interruptedAngle);
    assert.ok(Math.abs(resume.config.toValue - interruptedAngle - (1 / 32000 + 1 / 16000) * 200) < 1e-10);
    resume.finish();
    const loop = h.n.loops.at(-1)!;
    assert.equal(loop.child.config.duration, 16000);
    assert.equal(loop.child.config.toValue - rotation.nativeValue, 1, 'loop seam is exactly one full turn');
    now += 500;
    rotation.nativeValue = .8;
    await h.update('thinking');
    assert.ok(Math.abs(h.latest(rotation).config.toValue - .8 - (1 / 16000 + 1 / 4200) * 200) < 1e-10);
    assert.deepEqual(rotation.writes, []);
  } finally { await h.close(); Date.now = realNow; }
});

test('connection and recording decorations finish their fades and survive rapid exit/reentry', async () => {
  const h = await mount('waiting', true);
  const ids = ['mia-connecting-orbit', 'mia-recording-microphone'];
  const opacity = (id: string): Value => id === ids[0] ? h.decoration(id)!.props.style.opacity : h.decoration(id)!.parent!.props.style.opacity;
  try {
    const values = ids.map(opacity);
    await h.update('listening');
    assert.ok(ids.every(id => h.decoration(id)), 'decorations remain mounted during exit');
    const exits = values.map(value => h.latest(value));
    values.forEach(value => { value.nativeValue = .5; });
    await h.update('waiting', true);
    await act(async () => { exits.forEach(exit => exit.callback?.({ finished: true })); });
    assert.ok(ids.every(id => h.decoration(id)), 'stale fade callbacks cannot hide reentered decorations');
    values.forEach(value => { assert.equal(value.nativeValue, .5); assert.equal(h.latest(value).config.toValue, 1); });
    await h.update('listening');
    await act(async () => { values.forEach(value => h.latest(value).finish()); });
    assert.ok(ids.every(id => !h.decoration(id)));
  } finally { await h.close(); }
});

test('Reduce Motion freezes the angle, stops loops, and resumes from the same angle', async () => {
  const h = await mount('thinking');
  try {
    const rotation = h.orbit();
    h.latest(rotation).finish();
    rotation.nativeValue = .47;
    h.n.reduced = true;
    const count = h.n.timings.length;
    await h.update('paused');
    assert.equal(rotation.nativeValue, .47);
    assert.ok(h.n.loops.every(loop => loop.stopped));
    assert.ok(h.n.timings.slice(count).every(a => a.config.duration === 0));
    assert.equal(h.pulse().nativeValue, 0);
    h.n.reduced = false;
    await h.update('listening');
    assert.equal(rotation.nativeValue, .47);
    assert.equal(h.latest(rotation).config.toValue, .47 + 400 / 16000 / 2);
  } finally { await h.close(); }
});

test('late native angle readbacks cannot restart superseded or unmounted animations', async () => {
  const h = await mount('listening');
  h.n.holdReads = true;
  await h.update('thinking');
  await h.update('paused');
  const count = h.n.timings.length;
  await h.close();
  await act(async () => { h.n.reads.forEach(read => read()); });
  assert.equal(h.n.timings.length, count);
  assert.ok(h.n.loops.every(loop => loop.stopped));
});
