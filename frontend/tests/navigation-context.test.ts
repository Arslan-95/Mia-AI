import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NavigationContext, sameContext, viewRoute } from '../src/navigationContext';
import { PresentationLease } from '../src/coordination';

test('Mia requests retain the actual route and the view immediately preceding the assistant', () => {
  const navigation = new NavigationContext();
  navigation.move(viewRoute('chats', 'anna-chat'));
  const snapshot = navigation.move(viewRoute('mia'));
  assert.deepEqual(snapshot, { route: '/mia', revision: 2, previousRoute: '/chat/anna-chat' });
  assert.deepEqual(navigation.move('/mia'), snapshot);
  snapshot.route = '/settings';
  assert.equal(navigation.snapshot().route, '/mia');
  assert.equal(viewRoute('people'), '/contacts');
});

test('returning to the same chat does not make an old request or its device actions current again', () => {
  const navigation = new NavigationContext(); const lease = new PresentationLease();
  const request = navigation.move('/chat/anna');
  lease.begin('request'); lease.accept('request', 'turn');
  lease.revoke(); navigation.move('/chat/david'); navigation.move('/chat/anna');
  assert.equal(sameContext(request, navigation.snapshot()), false);
  assert.equal(lease.owns('turn'), false);
});

test('a new account cannot inherit the previous account view or route identifiers', () => {
  const navigation = new NavigationContext();
  navigation.move('/chat/private-chat'); navigation.move('/mia');
  const previous = navigation.snapshot(); navigation.reset();
  const current = navigation.snapshot();
  assert.equal(current.route, '/chats'); assert.equal(current.previousRoute, undefined);
  assert.ok(current.revision > previous.revision);
});
