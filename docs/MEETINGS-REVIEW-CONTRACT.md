# Meetings security and recovery contract

Review corrections for the read/meet/calendar batch, 28 September 2026. No real-provider certification is claimed by local fake-provider tests.

## Connect an account

1. The authenticated client generates at least 32 cryptographically random bytes, encoded as a 43-character base64url `proofVerifier`. Keep it only in that client's session, bound to the user and selected provider. Web uses sessionStorage; native clients use memory. Clear it on logout, account change, cancellation and expiration.
2. Send `POST /api/v1/meetings/connect/:provider` with `{platform, redirectScheme?, proofChallenge}`. `proofChallenge` is base64url(SHA256(proofVerifier)). The response is `{url}`. The verifier must never enter a URL.
3. Open `url` in the user agent that will receive the callback. The API's provider callback checks the provider as well as the state and consumes the state once. It exchanges the provider authorization code but stores the resulting credentials encrypted and **pending**, without changing the active connection.
4. The callback redirects to the existing web/native destination with `provider` and a random one-use `receipt`. This receipt is delivered only by that redirect; there is no polling endpoint that reveals or redeems it by state. It expires in 120 seconds. Errors use the existing `error` query parameter and have no receipt.
5. The receiving client removes receipt parameters from its URL immediately, finds its matching locally held proof, and sends authenticated `POST /api/v1/meetings/connect/confirm` with `{receipt, proofVerifier}`. Only the original user and proof can redeem the receipt. Success is `{ok:true, provider}`. Invalid user/proof, expiration or replay returns 409 `meeting_confirmation_invalid`. Wrong-user/proof attempts do not consume a valid receipt.

This binds completion to possession of both the original client's verifier and the callback receipt. If attacker A transfers the authorization URL to B, B's browser has the receipt but not A's client proof/session; A has the proof but cannot fetch B's receipt from the API. As with other authorization-code flows, secrets intentionally copied between people remain outside this guarantee. See [RFC 9700, section 2.1.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1).

Provider callbacks send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; confirmation sends `Cache-Control: no-store`. API request logging excludes query strings. Do not log request bodies or callback URLs in clients/proxies. A newly confirmed connection replaces old refresh credentials rather than combining credentials from different provider accounts. Refresh responses update only the captured connection generation and token version: late success cannot resurrect a disconnect or overwrite a replacement, and late rejection cannot mark a replacement for reconnection. `meeting_connection_changed` preserves the attempt when this race is detected.

## Create and recover

Freeze one payload and one idempotency key before the first POST. Preserve both across uncertain responses and UI dismissal; do not rotate the key automatically. Server fingerprints provider, conversation, title, requested start (including the `now` sentinel), duration, timezone and share flag.

- 409 `idempotency_mismatch`: the same key was used with a different payload. No provider request is made.
- 409 `meeting_in_progress`: another request owns this operation temporarily.
- 409 `meeting_pending`: Google created the calendar event but has not returned a Meet URL yet.
- 409 `meeting_uncertain`: the provider might have created the meeting; the server cannot safely declare failure. Check the original calendar before intentionally starting another meeting.

These errors include `error.details.meetingId`. Any error with that ID must preserve the original attempt, including `not_connected`, `reconnect_required`, `no_teams` and `no_meet`. The last two can mean an external calendar event exists without a meeting link; they do not authorize automatically creating another event. Only a known preflight error without an ID may discard a new attempt. Existing-key lookup precedes configuration, access and temporal preflight so an older operation remains recoverable. `GET /api/v1/meetings/:id` is owner-only and returns the existing DTO with status `creating`, `created` or `failed`. Only `created` with a nonempty provider URL permits a success/share/copy UI. GET may read an existing Google event to recover its Meet URL; it never inserts another external event. Re-POST the same frozen payload/key to retry the operation.

Google uses a stable Calendar event ID derived from the persisted operation UUID, plus its conference request ID. Reads precede inserts; 409 duplicate-ID responses reconcile the existing event. Pending or lost responses preserve the reservation. Reconnection changes an internal connection generation, preventing recovery from silently recreating an old operation in another account. Google [events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) and [events.get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get) document these APIs.

Microsoft uses the operation UUID as `transactionId`. Zoom has no equivalent key for this POST. Both remain conservatively uncertain after an interrupted POST; no automatic repeat is attempted. Explicit Teams-without-license responses remain 409 `no_teams`, retaining the external ID if one was returned. Explicit Google conference failure is 409 `no_meet` with the same retained operation and event ID. A session advisory lock serializes recovery and sharing, while durable states survive API restarts. Calendar sharing stores its event ID in the same transaction that creates that event; chat messages use the operation's stable clientMessageId.

## Provider permissions

- Google: `openid email https://www.googleapis.com/auth/calendar.events.owned`. We only create/read events in the person's primary calendar. Both required Calendar methods accept this narrower scope. `calendar.app.created` applies to secondary calendars created by the app and does not cover this primary-calendar flow. [Scope reference](https://developers.google.com/workspace/calendar/api/auth).
- Microsoft: `openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite`. No email access is requested.
- Zoom: user-level granular `meeting:write:meeting` for a new app, or existing `meeting:write` only if the actual app uses that legacy scope. No administrator or read scope is needed by the current implementation. Reconciliation does not list Zoom meetings or retry an uncertain POST. Verify the actual app configuration and real consent before release. [Zoom Create Meeting](https://developers.zoom.us/docs/isv/workflows/create-meeting/).

Provider console configuration, consent, license availability and real meetings still require separate verification. The existing `MEETINGS_ENABLED` switch is preserved and defaults to false. When off, start/callback/confirmation/create remain disabled and GET reads stored status without contacting a provider. Dedicated local fake-provider runs opt in with `MEETINGS_ENABLED=true`; this is not a production activation. Migration 029 adds pending confirmations and durable recovery metadata. Migration 030 preserves skipped unread history when the user sends a message; sending only advances an already caught-up cursor, including a new-history membership boundary.

## Focused local verification

`test/meetings-security.test.ts` requires a dedicated PostgreSQL database named `chaggu_meetings_review_*` on localhost and local API/provider endpoints. It checks proof/account/provider binding, receipt expiry/replay/concurrency, payload mismatch, ambiguous Google/Zoom outcomes, pending conferences and connection changes. `test/read-cursor-send.test.ts` uses the same local-only guard. `test/tanda-lectura-reuniones.test.ts` retains read-tree/personal-subject/meeting regression coverage, now using pending confirmation.

The fake provider must deduplicate Google by `event.id`, not by conference request ID: the latter would hide the original duplicate-calendar-event bug. Fault controls simulate creation followed by a dropped HTTP response and delayed conference generation. They do not test live OAuth, actual provider licenses, push delivery or physical hardware.
