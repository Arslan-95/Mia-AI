import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeApp, deleteApp, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { digest, guardSms } from '../src/sms-limits.js';
import { firestoreStore } from '../src/firestore-store.js';

test('real Firestore transactions prevent concurrent IP and global bypass; public writes are denied',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async t => {
    const projectId = 'demo-mia-auth';
    const app = initializeApp({ projectId }, 'sms-guard-emulator');
    t.after(() => deleteApp(app));
    const database = getFirestore(app, 'mia-auth-limits');
    const store = firestoreStore(database);
    const secret = 'emulator-only-secret-with-more-than-32-characters';
    const now = Date.now();
    // The emulator can abort contending transactions after a lock timeout.
    // Production fails closed on storage errors too; do not mistake an abort
    // for an allowed SMS. Unknown errors must still fail this test.
    async function concurrent(requests) {
      const results = await Promise.allSettled(requests);
      for (const result of results) if (result.status === 'rejected') {
        assert.equal(result.reason?.code, 10, 'only ABORTED contention is expected');
        assert.match(result.reason?.details ?? '', /Transaction lock timeout/);
      }
      const aborted = results.filter(result => result.status === 'rejected').length;
      if (aborted) t.diagnostic(`Firestore emulator lock timeouts: ${aborted}; these requests were not admitted`);
      return results.filter(result => result.status === 'fulfilled' && result.value === true).length;
    }
    const counter = async (scope, value) => (await database.collection('sms_limits').doc(digest(secret, scope, value)).get()).data()?.attempts ?? [];
    const sameIp = await concurrent(Array.from({ length: 8 }, (_, index) => guardSms(store, secret, {
      id: `same-ip-${index}`, ipAddress: '192.0.2.123', additionalUserInfo: { phoneNumber: `+1202555${2000 + index}` },
    }, now)));
    assert.equal(sameIp, 1, 'one contender must succeed without IP overshoot');
    assert.equal((await counter('ip', '192.0.2.123')).length, sameIp);
    const distributed = await concurrent(Array.from({ length: 15 }, (_, index) => guardSms(store, secret, {
      id: `distributed-${index}`, ipAddress: `198.51.100.${index + 1}`, additionalUserInfo: { phoneNumber: `+1202555${3000 + index}` },
    }, now)));
    assert.ok(distributed > 0 && distributed <= 9, 'concurrent requests make progress within the global cap');
    let admitted = sameIp + distributed;
    assert.equal((await counter('global', 'sms')).length, admitted, 'persisted counter exactly matches admissions');
    // If contention rejected a legitimate request, sequential requests must
    // still fill the remaining budget and then be denied at exactly ten.
    while (admitted < 10) {
      assert.equal(await guardSms(store, secret, { id: `fill-${admitted}`, ipAddress: `203.0.113.${admitted + 1}`,
        additionalUserInfo: { phoneNumber: `+1202555${5000 + admitted}` } }, now), true);
      admitted++;
    }
    assert.equal(await guardSms(store, secret, { id: 'over-cap', ipAddress: '203.0.113.200',
      additionalUserInfo: { phoneNumber: '+12025556000' } }, now), false);
    assert.equal((await counter('global', 'sms')).length, 10);
    assert.equal((await database.collection('sms_limits').get()).size, 31, 'ten complete reservations; no partial writes from aborted or denied requests');
    const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${projectId}/databases/mia-auth-limits/documents/sms_limits/spoof`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { attempts: { arrayValue: { values: [] } } } }),
    });
    assert.equal(response.status, 403);

    // Exercise the actual exported handler using the SDK's AuthBlockingEvent
    // shape (eventId, not a generic CloudEvent id). No Google SMS is sent.
    process.env.GCLOUD_PROJECT = projectId;
    process.env.SMS_RATE_LIMIT_HASH_KEY = secret;
    const { miaBeforeSmsSent } = await import('../src/index.js');
    assert.equal(miaBeforeSmsSent.__endpoint.blockingTrigger.eventType, 'providers/cloud.auth/eventTypes/user.beforeSendSms');
    await assert.rejects(miaBeforeSmsSent.run({ eventId: 'actual-sdk-shape', ipAddress: '203.0.113.1',
      additionalUserInfo: { phoneNumber: '+12025554000' } }), error => error.code === 'resource-exhausted' && error.message === 'OTP_RATE_LIMIT');
    await getFirestore('mia-auth-limits').terminate();
    await deleteApp(getApp());
    await database.terminate();
  });
