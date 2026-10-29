import { createRequire } from 'node:module';
import type { PressableProps } from 'react-native';

// Exercise the installed RN responder state machine. Only native services are
// stubbed: reproducing onPressIn/onPressOut alone misses release -> onPress.
const require = createRequire(import.meta.url);
const { code } = require('@babel/core').transformFileSync(require.resolve('react-native/Libraries/Pressability/Pressability'), {
  babelrc: false, configFile: false, presets: [require.resolve('@react-native/babel-preset')],
});
const services: Record<string, unknown> = {
  '../../src/private/featureflags/ReactNativeFeatureFlags': { shouldPressibilityUseW3CPointerEventsForHover: () => false },
  '../Components/Sound/SoundManager': { playTouchSound() {} },
  '../ReactNative/UIManager': { measure(_id: number, callback: (...values: number[]) => void) { callback(0, 0, 200, 200, 0, 0); } },
  '../StyleSheet/Rect': { normalizeRect: (value: unknown) => value },
  '../Utilities/Platform': { OS: 'ios' },
  './HoverState': { isHoverEnabled: () => false },
  './PressabilityPerformanceEventEmitter.js': { emitEvent() {} },
};
const module = { exports: {} as { default: new (props: PressableProps) => { getEventHandlers(): Record<string, (event: unknown) => void>; reset(): void } } };
new Function('require', 'module', 'exports', code)((id: string) => {
  if (id in services) return services[id];
  if (id === 'invariant' || id.startsWith('@babel/runtime/')) return require(id);
  throw new Error('Unexpected Pressability dependency: ' + id);
}, module, module.exports);

export function pressGesture(props: PressableProps) {
  const responder = new module.exports.default(props);
  const handlers = responder.getEventHandlers();
  let point = { pageX: 10, pageY: 10, locationX: 10, locationY: 10 };
  const event = () => ({ currentTarget: 1, target: 1, persist() {}, nativeEvent: {
    ...point, timestamp: Date.now(), touches: [point], changedTouches: [point],
  } });
  return {
    // Native RN grants the responder during extraction, before dispatching
    // the ordinary bubbling touch-start callback.
    begin: () => { const touch = event(); handlers.onResponderGrant!(touch); props.onTouchStart?.(touch as any); },
    move: (x: number, y: number) => { point = { pageX: x, pageY: y, locationX: x, locationY: y }; const touch = event(); handlers.onResponderMove!(touch); props.onTouchMove?.(touch as any); },
    release: () => { const touch = event(); handlers.onResponderRelease!(touch); props.onTouchEnd?.(touch as any); },
    cancel: () => { const touch = event(); handlers.onResponderTerminate!(touch); props.onTouchCancel?.(touch as any); },
    activate: () => handlers.onClick!({ currentTarget: 1, target: 1, nativeEvent: { timestamp: Date.now() } }),
    dispose: () => responder.reset(),
  };
}
