import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NavigationContext, pageView, routeView, sameContext, viewRoute } from '../src/navigationContext';
import { PresentationLease } from '../src/coordination';

test('assistant home and messenger pages have explicit routes while requests retain the open conversation', () => {
  const navigation = new NavigationContext();
  navigation.move(viewRoute('chats', 'anna-chat'));
  const snapshot = navigation.snapshot();
  assert.deepEqual(snapshot, { route: '/chat/anna-chat', revision: 1, previousRoute: '/chats' });
  assert.deepEqual(navigation.move(viewRoute('chats', 'anna-chat')), snapshot);
  snapshot.route = '/settings';
  assert.equal(navigation.snapshot().route, '/chat/anna-chat');
  assert.equal(viewRoute('people'), '/contacts');
  assert.equal(viewRoute('assistant'), '/mia');
  assert.deepEqual(routeView('/mia'), { view: 'assistant', chatId: null });
  assert.equal(pageView('/drafts'), 'drafts');
  for (const route of ['/chat/anna', 'https://example.com', '/settings/../mia', undefined]) assert.equal(pageView(route), null);
});

test('back returns to the screen that opened the chat and root tabs replace the navigation branch', () => {
  const navigation = new NavigationContext();
  navigation.move(viewRoute('people'));
  navigation.move(viewRoute('chats', 'anna'));
  const entered = navigation.snapshot();
  assert.equal(navigation.back().route, '/contacts');
  assert.ok(navigation.snapshot().revision > entered.revision);
  navigation.move('/chat/anna'); navigation.move('/chat/bob');
  assert.equal(navigation.back().route, '/chat/anna');
  assert.equal(navigation.back().route, '/contacts');
  navigation.move('/settings'); navigation.move('/chats'); navigation.move('/chat/anna');
  assert.equal(navigation.back().route, '/chats');
  navigation.reset(); assert.equal(navigation.back().route, '/chats');
  assert.deepEqual(routeView('/chat/anna'), { view: 'chats', chatId: 'anna' });
  assert.deepEqual(routeView('/contacts'), { view: 'people', chatId: null });
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
