# Provider-side SMS limits

`miaBeforeSmsSent` is a Firebase Authentication blocking trigger. Firebase calls
it before sending an SMS. This is the authoritative layer: a modified client
cannot bypass it by invoking Firebase directly. A client preflight call to the
Mia API alone would not enforce this boundary.

The code must be deployed and registered in the live Firebase project before
these provider-side limits take effect. Merely enabling the Phone provider,
running the Mia backend or checking this code into Git does not activate them.

Deployment on 2026-11-02: `miaBeforeSmsSent` is ACTIVE in
`jobhunter-ai-90df3` / `us-central1`, and Identity Platform's `beforeSendSms`
trigger points at its Cloud Run URL. Runtime identity
`mia-sms-guard@jobhunter-ai-90df3.iam.gserviceaccount.com` has
`roles/datastore.user` conditioned on the `mia-auth-limits` database and access
to the single HMAC secret. No service-account key was created. Change the
`serviceAccount` option and provision equivalent permissions when using another
project. Real iPhone SMS delivery still needs an on-device check.

## Limits

The defaults are deliberately small for testing:

| Scope | Cooldown | Rolling 15 minutes | Rolling 24 hours |
| --- | --- | --- | --- |
| Public IPv4 or IPv6 /64 | 60 seconds | 5 attempts | 10 attempts |
| Full international phone number | 60 seconds | 5 attempts | 10 attempts |
| Entire Firebase project | — | — | 10 attempts |

These are reservations before delivery: a failed delivery can consume a slot.
All devices behind the same public address share its allowance. IPv4-mapped
IPv6 addresses normalize to the same IPv4 bucket. IPv6 addresses use a /64 to
prevent cycling interface identifiers within the same network. A public IP is
not a reliable unique identifier for a physical computer.

## Enforcement

The function wrapper verifies Firebase's signed blocking event. The handler
uses the provider-supplied source IP and destination number, never client
headers or an unsigned preflight request. Firestore atomically reserves the IP,
phone and global counters together. Delivery-event markers make provider
retries idempotent. Missing identity, missing secrets, invalid state and storage
outages fail closed. Allowing a request does not override Google's existing
reCAPTCHA verdict.

Counters are kept in the dedicated named database `mia-auth-limits`, whose
client Security Rules deny all reads and writes. This avoids changing the
existing project's application database or its rules. Stored identifiers are
HMAC digests; raw phone numbers, IP addresses, tokens and secrets are not logged
or stored by this handler. Configure Firestore TTL on `sms_limits.expiresAt` to
remove inactive buckets and event markers after about 25 hours. TTL deletion is
asynchronous and is not part of the rate-limit decision.
The live TTL policy was verified `ACTIVE` on 2026-11-02. Counter expiration
works independently of that background cleanup. The Artifact Registry cleanup
policy retains build images for one day.

## Deployment

1. Review and enable Firebase Authentication with Identity Platform in the
   selected project; auth blocking triggers require it.
2. Authorize the official Firebase CLI with a project owner/deployer account.
   Its Google OAuth screen requests broad Firebase and Google Cloud permissions;
   the account owner must approve that grant.
3. Create the named Firestore database `mia-auth-limits` and deploy its deny-all
   rules from the root `firebase.json`. Existing app databases must not be replaced.
4. Create `SMS_RATE_LIMIT_HASH_KEY` in Secret Manager through Firebase CLI using
   a random secret of at least 32 characters. Keep it outside Git and reuse it
   across deployments; changing it resets the counter namespaces.
   Provision the dedicated runtime identity used in `src/index.js`. Grant
   `roles/datastore.user` with condition
   `resource.name=="projects/PROJECT_ID/databases/mia-auth-limits"`. The Firebase
   deployment grants it access to the referenced secret; do not grant Editor.
5. Deploy only the `mia-auth` functions codebase. Verify that the Firebase
   `beforeSendSms` blocking trigger points at `miaBeforeSmsSent` and that the
   function is ready. Do not delete a registered blocking function without also
   unregistering its auth trigger.
6. Configure TTL and test an allowed and blocked phone flow on the actual app.

This uses Cloud Functions, Secret Manager and a named Firestore database under
the project's billing account. The 10-SMS cap limits SMS reservations; it is not
a total cloud-spending cap, nor a promise that all supporting services are free.
Instances scale down to zero and are capped at two. No service-account JSON key
is needed; deployed code uses its attached identity.

## Tests

From this directory run `npm test` for pure guard tests. To also verify actual
concurrent Firestore transactions, named-database rules and the exported handler,
run from the repository root with a Java runtime available:

```sh
firebase emulators:exec --only firestore --project demo-mia-auth "npm --prefix firebase-functions test"
```

The emulator uses a demo project and fictional numbers. It sends no SMS and
does not consume the live project's quota.

Concurrent emulator transactions can hit lock timeouts, a documented
[emulator limitation](https://firebase.google.com/docs/emulator-suite/connect_firestore#transactions).
The integration test reports these aborted requests, verifies that admissions
never exceed the caps and match persisted counters, and fills the remaining
budget sequentially to prove its exact boundary. It does not measure production
latency. Under contention or a storage outage, the deployed function can reject
legitimate attempts; it never permits sending without a committed reservation.
