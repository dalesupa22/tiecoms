# Sign in with Apple — iOS

Implemented on top of TestFlight 1.7.16 (56), source `c7ee6c521a821dd971c4e22ecee8d83655ade1ca`. The release version/build is assigned separately during release preparation.

## User flow

The official `ASAuthorizationAppleIDButton` appears above Google and Microsoft on login and registration, at the same width and 50-point height. All three use the existing terms acceptance. Apple opens its native authorization sheet; requested scopes are only name and email, including Hide My Email.

Existing accounts are never linked by matching email. A user signs in using their existing method and selects Apple under **You > Account · Apple** (**Tú > Cuenta · Apple**). This uses distinct authenticated linking endpoints. Error messages explain linking and invitation restrictions in Spanish and English.

## Protocol and session boundaries

- `POST /api/v1/auth/apple/challenge` receives S256 `codeChallenge`, the existing device descriptor and optional `orgInviteToken` or `orgName`.
- A fresh cryptographic verifier stays in memory. Server `challengeId` is sent as Apple request state, and server `nonce` is passed unchanged to Apple. Both nonempty fields and ISO8601 expiry are checked before presenting the sheet.
- On completion, state and expiry are checked again. `/apple/complete` receives `challengeId`, `codeVerifier`, `identityToken`, `authorizationCode`, optional first-authorization name (maximum 120 characters), and the device descriptor. Email is never trusted from client input.
- `/apple/link/challenge` and `/apple/link/complete` require the current chaggu session. Linking completion is sent exactly once with a current access token: Apple credential 401 responses must not refresh/replay the consumed challenge or sign out the valid chaggu session.
- API validation and authorization-code exchange are server responsibilities. No identity/access/authorization token is logged or persisted by the Apple authorizer.
- Only the Apple subject and chaggu user ID are stored in a separate device-bound, app-only Keychain entry. No shared extension group or plaintext debug fallback is used. A failed identity write closes the newly created login session.
- Password/Google/Microsoft login, logout and account deletion clear the previous Apple session binding. Session generation guards discard results arriving after account changes.
- Startup and foreground share a credential-state check; a revocation notification also checks the Apple credential. Revoked/not-found/transferred closes the local session. An Apple service/network error does not imply revocation.
- Native cancellation calls `ASAuthorizationController.cancel()` and retains the pending controller/busy state until the Apple callback. Cancelled login leaves no error banner. Repeated taps cannot create a second flow.

## Capability and deployment

The app entitlement includes `com.apple.developer.applesignin = [Default]`. Share and notification extensions retain their existing entitlements. The App ID, provisioning profile, backend Apple configuration, archive eligibility, delivery and App Review reply are separate release steps owned by the release coordinator.

## Verification scope

`AppleSignInTests` cover nonce/state/scopes, expiry, secure proof generation, completion payload, initial/returning identity, cancellation/double taps, native cancellation callback timing, explicit authenticated linking, invalid-proof 401 without replay, identity persistence failure, logout cleanup, revocation, startup/foreground coalescing and stale callbacks after account changes.

`AppleSignInUITests` runs against a closed local port and checks the rendered official button on login/registration, equal prominence, consent gating and accessible enabled state. It captures both screens. This test never signs into an Apple Account or sends a real message.

The test run logs and screenshots are reported separately in the release receipt. Mocked security/unit tests and simulator layout do not prove a real Apple authorization exchange, private relay delivery, App Store approval or physical notification acceptance.
