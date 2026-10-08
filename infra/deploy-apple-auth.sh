#!/usr/bin/env bash
# Release the reviewed Apple-auth API/worker and legal site, preserving the app and WhatsApp bridge.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${EXPECTED_API_RELEASE:?Reconcile the running API first}"
: "${EXPECTED_WEB_RELEASE:?Reconcile the running web first}"
host="${TIECOMS_HOST:-ReimaginedClubServer}"
test -z "$(git status --porcelain)" || { echo 'Commit and push the reviewed source first.' >&2; exit 1; }
revision="$(git rev-parse HEAD)"
test "$(git rev-parse origin/principal)" = "$revision" || { echo 'Source must match the fetched public deployment branch.' >&2; exit 1; }
release="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)-apple-login"
stage="$(mktemp -d /tmp/chaggu-apple-release.XXXXXX)"
trap 'rm -rf "$stage"' EXIT
npm -w @tiecoms/api run -s typecheck
npm -w @tiecoms/api run -s build
python3 apps/landing/build.py >/dev/null
cp -R apps/api/dist "$stage/api"
cp -R apps/landing/dist "$stage/site"
cp infra/Dockerfile.api infra/compose.yml "$stage/"
touch "$stage/WA_PRIVACY_V1"
printf '%s\n' "$revision" > "$stage/SOURCE_COMMIT"
test "$(git rev-parse HEAD)" = "$revision" && test -z "$(git status --porcelain)"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$stage" -czf "$stage/artifact.tgz" api site Dockerfile.api compose.yml WA_PRIVACY_V1 SOURCE_COMMIT
shasum -a 256 "$stage/artifact.tgz"
scp -q "$stage/artifact.tgz" "$host:/tmp/chaggu-$release.tgz"
ssh "$host" "sudo bash -s -- '$EXPECTED_API_RELEASE' '$EXPECTED_WEB_RELEASE' '$release' '$revision'" <<'REMOTE'
set -euo pipefail
expected="$1"; expected_web="$2"; release="$3"; revision="$4"; base=/opt/tiecoms
exec 9>"$base/shared/web-deploy.lock"
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 1; }
test "$(cat "$base/RELEASE")" = "$expected" || { echo 'API changed; reconcile before deployment.' >&2; exit 1; }
test "$(cat "$base/WEB_RELEASE")" = "$expected_web" || { echo 'Web changed; reconcile before deployment.' >&2; exit 1; }
test -f "$base/shared/apple-auth/AuthKey.p8"
wa_before="$(docker inspect --format '{{.Id}} {{.Config.Image}} {{.State.StartedAt}}' tiecoms-wa-1)"
web_before="$(readlink "$base/web/current")"
dest="$base/releases/$release"
test ! -e "$dest"
mkdir "$dest"
tar -xzf "/tmp/chaggu-$release.tgz" -C "$dest"
test "$(cat "$dest/SOURCE_COMMIT")" = "$revision"
cd "$dest"
docker build -q -t "tiecoms-api:$release" -f Dockerfile.api .
# Additive migration permits rollback to the preceding binaries without undoing schema.
docker run --rm --env-file "$base/shared/api.env" -v "$base/shared/rds-ca.pem:/run/secrets/rds-ca.pem:ro" "tiecoms-api:$release" node migrate.js
changed=0
restore() {
  code=$?
  if [ "$code" != 0 ] && [ "$changed" = 1 ]; then
    (cd "$base/releases/$expected" && TIECOMS_RELEASE="$expected" docker compose -f compose.yml up -d --no-deps api worker)
    ln -s "$web_before" "$base/web/rollback-$release"
    mv -Tf "$base/web/rollback-$release" "$base/web/current"
    printf '%s\n' "$expected" > "$base/RELEASE"
    printf '%s\n' "$expected_web" > "$base/WEB_RELEASE"
    echo 'Verification failed; preceding services and static site restored.' >&2
  fi
  rm -f "/tmp/chaggu-$release.tgz"
}
trap restore EXIT
changed=1
TIECOMS_RELEASE="$release" docker compose -f compose.yml up -d --no-deps api worker
ok=0
for attempt in $(seq 1 30); do
  if curl --connect-timeout 2 --max-time 4 -fsS http://127.0.0.1:3020/api/health/ready >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
test "$ok" = 1
test "$(docker inspect --format '{{.State.Running}}' tiecoms-worker-1)" = true
# A readiness response alone cannot prove that the service user can read the key
# or that migration 109 and the encryption configuration work. This creates only
# an expiring anonymous challenge; no Apple account or Chaggu session is created.
docker exec -i tiecoms-api-1 node --input-type=module <<'CHECK_APPLE'
import { createHash, randomBytes, randomUUID } from 'node:crypto';
const codeChallenge = createHash('sha256').update(randomBytes(48)).digest('base64url');
const response = await fetch('http://127.0.0.1:3020/api/v1/auth/apple/challenge', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ codeChallenge, device: { platform: 'ios', deviceId: randomUUID(), name: 'Release preflight' } }),
  signal: AbortSignal.timeout(15000),
});
if (!response.ok || response.headers.get('cache-control') !== 'no-store') throw new Error('Apple challenge configuration check failed');
const body = await response.json();
if (typeof body.challengeId !== 'string' || body.challengeId.length < 32 || !/^[a-f0-9]{64}$/.test(body.nonce)
  || !(Date.parse(body.expiresAt) > Date.now())) throw new Error('Apple challenge schema check failed');
console.log('APPLE_CHALLENGE_CONFIG_VERIFIED; no account or login performed');
CHECK_APPLE
test "$wa_before" = "$(docker inspect --format '{{.Id}} {{.Config.Image}} {{.State.StartedAt}}' tiecoms-wa-1)"
mkdir "$dest/web"
mv "$dest/site" "$dest/web/site"
cp -a "$web_before/app" "$dest/web/app"
ln -s "$dest/web" "$base/web/next-$release"
mv -Tf "$base/web/next-$release" "$base/web/current"
curl --connect-timeout 3 --max-time 15 -fsS --resolve www.chaggu.com:443:127.0.0.1 "https://www.chaggu.com/terminos/?verify=$release" > "$dest/terms.served.html"
cmp "$dest/web/site/terminos/index.html" "$dest/terms.served.html"
curl --connect-timeout 3 --max-time 15 -fsS --resolve app.chaggu.com:443:127.0.0.1 "https://app.chaggu.com/?verify=$release" > "$dest/app.served.html"
cmp "$web_before/app/index.html" "$dest/app.served.html"
printf '%s\n' "$release" > "$base/RELEASE"
printf '%s\n' "$release" > "$base/WEB_RELEASE"
echo "APPLE_AUTH_READY $release SOURCE $revision; app bytes and WhatsApp preserved"
REMOTE
