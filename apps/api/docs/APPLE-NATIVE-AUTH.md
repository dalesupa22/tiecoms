# Native Sign in with Apple

This flow is additive and iOS-only. Browser Google/Microsoft `SsoProvider`, redirects and installed Android clients are unchanged.

## API contract

All paths below are under `/api/v1`, use JSON POST, the existing authentication rate limit, and `Cache-Control: no-store`.

- `/auth/apple/challenge`: `{codeChallenge, device:{platform:"ios",deviceId,name,contract}, orgInviteToken?, orgName?}` → `{challengeId,nonce,expiresAt}`.
- `/auth/apple/complete`: `{challengeId,codeVerifier,identityToken,authorizationCode,fullName?,device}` → existing `AuthResult`.
- `/auth/apple/link/challenge` and `/auth/apple/link/complete`: same payloads, authenticated bearer required and bound to the same user/session. Complete returns `{linked:true}`. It does not replace the active app session or change its email.

`codeChallenge` is base64url SHA-256 of a cryptographically random 43–128-character verifier retained only by the device. Challenge lifetime is five minutes; the server-provided nonce is passed unchanged to Apple's native request. The iOS controller also binds `state` to `challengeId`. `expiresAt` is UTC ISO8601 with milliseconds. Completion claims the challenge atomically once, including invalid proof attempts.

Both native and code-exchange identity JWTs require Apple's signature/JWKS, RS256, exact issuer `https://appleid.apple.com`, exact audience `com.chaggu.app`, nonce, subject, expiration and recent issuance. The two tokens must identify the same subject. Apple authorization-code exchange uses a short-lived ES256 client secret. Provider calls have a 15-second timeout; no provider response body or credential is surfaced in application errors.

## Provisioning required before enabling the iOS button in a release

Configure the API and the worker with the same values:

- `APPLE_CLIENT_ID=com.chaggu.app` (the only allowed audience; this is also the default).
- `APPLE_TEAM_ID` and `APPLE_KEY_ID`: the correct ten-character Apple team/key identifiers.
- `APPLE_PRIVATE_KEY_PATH`: protected, readable mount containing the Sign in with Apple ES256 `.p8` key. Do not put key contents in source control or API output.
- `APPLE_TOKEN_ENCRYPTION_KEY`: independent cryptographically random 32 bytes encoded as exactly 64 hexadecimal characters. API and worker must share this key; never reuse `JWT_SECRET`. Preserve it with the encrypted token vault and do not rotate it without a migration/re-encryption plan.

The native app's explicit bundle identifier must have Sign in with Apple enabled and its provisioning profile/entitlements regenerated as appropriate. Store configuration and key provisioning are release-owner responsibilities. Missing, inconsistent or invalid local credentials fail closed with `apple_unavailable`; Google/Microsoft remain functional.

Apply migration `108_apple_native_auth.sql` before serving this code. The standard migrator and its no-transaction/advisory-lock behavior are unchanged. Migration 108 widens only `user_identities.provider`, adds one-Apple-identity-per-user uniqueness, challenge storage, encrypted token vault, and short-lived hashed deletion markers.

## Identity and organization boundaries

Apple's stable `sub` is the identifier, never its email. A first Apple login matching an existing user's verified email returns `apple_link_required`; users sign in with their current method, then explicitly link Apple in Tú > Cuenta. Linking cannot steal a subject assigned to another account or silently replace an existing Apple identity. An existing subject continues to work when Apple stops sending name/email.

`privaterelay.appleid.com` is a public mail domain. Apple signup does not claim or auto-join a corporate domain, even when sharing a real company email. Optional invitations use the existing invitation validation; an email-restricted invitation must match Apple's verified email. A private relay mismatch gives the generic `apple_invitation_mismatch`, without disclosing the invited address. Native name is bounded display information only; identity/account resolution does not trust an unsigned client email.

Error codes exposed to iOS: `apple_invalid_credential` (401), `apple_email_unverified` (403), `apple_invitation_mismatch` (403), `apple_link_required` (409), `apple_identity_linked` (409), `apple_unavailable` (503). Existing authenticated-session errors remain unchanged.

## Deletion, encryption, races and retries

Tokens are AES-256-GCM ciphertext with a random IV and authenticated record-id binding. Jobs contain only an opaque `tokenId`. No Apple token goes in audit/outbox/jobs or logs. Each successful code exchange is persisted before account/session resolution; a housekeeping scan recovers unassociated records older than ten minutes after process interruption.

Account deletion immediately removes Apple identities, revokes local sessions, anonymizes the account and queues provider revocation in one database transaction. An Apple outage cannot block local deletion. The worker's `apple.revoke` job runs in the slow lane, retries with the existing durable lease/backoff mechanism (up to 100 attempts), and removes ciphertext only after an official successful revoke response. Failed jobs remain inspectable and retain the ciphertext for authorized recovery. API and worker restarts must preserve the encryption key and signing-key mount.

Lock order is Apple-subject advisory lock followed by user row. Deletion first discovers/locks subjects, then locks the user; a first link committed in between causes a serialization retry with the new subject, not an inverse-order lock. Short-lived hashed deletion markers reject pre-deletion identity tokens. Pending revocation blocks a fresh Apple login for the same subject until provider cleanup succeeds, avoiding revival/races with an outstanding revocation.

Apple documents that revoking an already-invalidated token also returns HTTP 200 without a body. Unknown or error responses retain ciphertext and retry; `invalid_token` is not guessed to be success. Source inspected 2026-10-08: https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens.md

## Validation

Run against an isolated PostgreSQL database named `tiecoms_test_apple` bound to loopback only:

```
DATABASE_URL=<isolated-loopback-postgres> JWT_SECRET=<isolated-test-key> npm -w @tiecoms/api test -- --run test/apple-auth.test.ts test/sso.test.ts test/sso-next.test.ts
npm -w @tiecoms/contracts run typecheck
npm -w @tiecoms/api run typecheck
npm -w @tiecoms/api run build
```

The Apple suite verifies real signed JWT fixtures and real SQL transactions; Apple network calls are mocked. It covers signature/issuer/audience/nonce/expiry/issued-at validation, config failure, ciphertext tampering, once-only replay and concurrency, device binding, code-exchange rejection, stable identities, explicit linking, private relay/domain placement, restricted invitations, deletion during provider outage, encrypted queue cleanup, interrupted association recovery, forced login/link/deletion lock overlaps, and HTTP authorization/contract/cache behavior. It does not claim a physical-device Apple authorization result, real Apple code exchange, actual relay-mail delivery, or App Review approval.
