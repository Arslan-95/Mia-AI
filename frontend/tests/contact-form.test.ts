import assert from 'node:assert/strict';
import test from 'node:test';
import { contactFormSnapshot, contactFormStatus } from '../src/features/contacts/model/contactForm';

test('a contact clarification preserves the requested details without displaying a save failure', () => {
  const form = contactFormSnapshot({ turnId: 'rename-turn', operation: 'rename', name: 'Anna Dimo',
    identifier: '+12025550101', status: 'clarification', code: 'MEMORY_CHANGE_UNSUPPORTED' });
  assert.ok(form);
  assert.equal(form.status, 'clarification');
  assert.equal(form.name, 'Anna Dimo');
  assert.equal(form.identifier, '+12025550101');
  assert.equal(contactFormStatus[form.status], 'Waiting for clarification');
  assert.equal(contactFormSnapshot({ ...form, status: 'failed' })?.status, 'failed', 'technical failures retain their own status');
});
