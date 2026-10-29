import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatScrollPositions } from '../src/chatScrollPositions';

test('scroll memory is per account/chat and lasts only for this app session', () => {
  const positions = new ChatScrollPositions();
  const start = positions.read('owner', 'anna');
  positions.save('owner', 'anna', start.generation, 420, []);
  assert.equal(positions.read('owner', 'anna').offset, 420);
  assert.equal(positions.read('owner', 'other-chat').offset, undefined);
  assert.equal(positions.read('other-account', 'anna').offset, undefined);
  assert.equal(new ChatScrollPositions().read('owner', 'anna').offset, undefined, 'cold restart does not read a disk preference');
  positions.clear();
  positions.save('owner', 'anna', start.generation, 600, []);
  assert.equal(positions.read('owner', 'anna').offset, undefined, 'late events from the logged-out account are discarded');
});

test('native overscroll and invalid samples cannot corrupt a saved position', () => {
  const positions = new ChatScrollPositions();
  const { generation } = positions.read('owner', 'anna');
  positions.save('owner', 'anna', generation, 200, []);
  for (const value of [NaN, Infinity, -Infinity]) positions.save('owner', 'anna', generation, value, []);
  assert.equal(positions.read('owner', 'anna').offset, 200);
  positions.save('owner', 'anna', generation, -35, []);
  assert.equal(positions.read('owner', 'anna').offset, 0, 'bounce at the latest message does not persist a negative gap');
});
