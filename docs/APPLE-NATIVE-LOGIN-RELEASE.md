# Native Sign in with Apple release

The iOS client uses `com.chaggu.app` as its Apple audience. Google/Microsoft browser login and existing Android clients keep their contracts. No Apple web Services ID is required by this native flow.

## Server configuration

Configure these values through the existing private production environment file, never in Git or release receipts:

- `APPLE_CLIENT_ID=com.chaggu.app`
- `APPLE_TEAM_ID`: the developer team owning Chaggu.
- `APPLE_KEY_ID`: a dedicated Sign in with Apple key associated with Chaggu's primary App ID.
- `APPLE_PRIVATE_KEY_PATH=/run/secrets/apple-auth/AuthKey.p8`
- `APPLE_TOKEN_ENCRYPTION_KEY`: a dedicated 32-byte random key, encoded as 64 hexadecimal characters. Preserve this key while any Apple token ciphertext exists; replacing it would prevent revocation.

The host directory `/opt/tiecoms/shared/apple-auth` must exist before starting the new compose definition. Its `AuthKey.p8` must be readable only by the container service user and host administrators. Compose mounts the directory read-only into `api` and `worker`; the WhatsApp service has no access to it. Existing distribution, APNs and other application keys are not reused or replaced.

Missing configuration makes Apple authentication unavailable without disabling the existing login providers. The refresh tokens are encrypted with record-bound AES-GCM. Account deletion queues durable revocation and completes local deletion without depending on Apple's availability. Revocation jobs use the ordinary slow worker lane so an Apple outage does not delay push jobs.

## Release sequence and limits

1. Review and commit source; push it, fetch/pull the exact deployment commit into a clean checkout, and verify `HEAD == origin/principal` for the API release.
2. Reconcile the running API/web release IDs and any concurrent releases. Supply those exact IDs as `EXPECTED_API_RELEASE` and `EXPECTED_WEB_RELEASE` to `bash infra/deploy-apple-auth.sh`.
3. The script builds the API and legal site, applies additive migration 108, and replaces the API/worker. It preserves the current web-app bytes and WhatsApp bridge container. A failed verification restores previous binaries/static pointers while retaining the additive schema.
4. Verify API readiness, configured Apple challenge behavior, worker health, deployed legal pages and preserved clients. Do not describe a mock Apple token exchange as real authentication.
5. Archive iOS from its separately reviewed source, with the Apple entitlement only on the main app. Use an App Store eligible export and a new verified version/build number. Preserve extensions, testers and existing review metadata.
6. Verify signed artifact identity/hash, Apple processing and build audience before selecting it for App Review. Record real authentication evidence separately from simulator tests and compile results. Answer App Review using the actual submitted version and current no-charge model; retain tentative future prices outside the response.

The draft response, authorization, source reconciliation and release receipts live under `release-assets/apple-login-20261007/` outside this repository. This document does not itself assert a deployment, upload, successful live Apple login or App Review submission.
