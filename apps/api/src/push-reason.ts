/** Only protocol codes enter logs/DB; transport exceptions may contain URLs or secrets. */
const apnsReasons = new Set([
  'BadCollapseId', 'BadDeviceToken', 'BadExpirationDate', 'BadMessageId', 'BadPriority', 'BadTopic',
  'DeviceTokenNotForTopic', 'DuplicateHeaders', 'IdleTimeout', 'MissingDeviceToken', 'MissingTopic',
  'PayloadEmpty', 'TopicDisallowed', 'BadCertificate', 'BadCertificateEnvironment', 'ExpiredProviderToken',
  'Forbidden', 'InvalidProviderToken', 'MissingProviderToken', 'BadPath', 'MethodNotAllowed',
  'Unregistered', 'PayloadTooLarge', 'TooManyProviderTokenUpdates', 'TooManyRequests',
  'InternalServerError', 'ServiceUnavailable', 'Shutdown',
]);
const fcmReasons = new Set([
  'UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH', 'QUOTA_EXCEEDED', 'UNAVAILABLE',
  'INTERNAL', 'THIRD_PARTY_AUTH_ERROR', 'APNS_AUTH_ERROR', 'NOT_FOUND', 'PERMISSION_DENIED',
  'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'DEADLINE_EXCEEDED', 'UNKNOWN',
]);
export function safePushReason(raw: string): string {
  if (raw === 'apns_not_configured' || raw === 'fcm_not_configured') return raw;
  if (raw.startsWith('apns_network:')) return 'apns_network';
  if (raw.startsWith('fcm_network:')) return 'fcm_network';
  if (/^fcm_oauth_[1-5]\d\d$/.test(raw)) return raw;
  const match = /^(apns|fcm)_([1-5]\d\d)(?:_([A-Za-z_]+))?$/.exec(raw);
  if (!match) return 'transport_error';
  const [, provider, status, reason] = match;
  const allowed = provider === 'apns' ? apnsReasons : fcmReasons;
  return `${provider}_${status}${reason && allowed.has(reason) ? `_${reason}` : ''}`;
}
