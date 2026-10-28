import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NavigationContext, sameContext, viewRoute } from '../src/navigationContext';
import { PresentationLease } from '../src/coordination';

test('Mia requests retain the open conversation without a separate assistant route', () => {
  const navigation = new NavigationContext();
  navigation.move(viewRoute('chats', 'anna-chat'));
  const snapshot = navigation.snapshot();
  assert.deepEqual(snapshot, { route: '/chat/anna-chat', revision: 1, previousRoute: '/chats' });
  assert.deepEqual(navigation.move(viewRoute('chats', 'anna-chat')), snapshot);
  snapshot.route = '/settings';
  assert.equal(navigation.snapshot().route, '/chat/anna-chat');
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
