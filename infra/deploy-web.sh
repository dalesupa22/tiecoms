#!/usr/bin/env bash
# Static app-only release: do not restart the API, workers or WhatsApp bridge.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${TIECOMS_HOST:-ReimaginedClubServer}"
test -z "$(git status --porcelain)" || { echo 'Commit the reviewed source before deploying.' >&2; exit 1; }
SOURCE_COMMIT="$(git rev-parse HEAD)"
REL="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)-$(openssl rand -hex 4)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
npm -w @tiecoms/web run -s typecheck
VITE_API_ORIGIN='' VITE_BASE='/' npm -w @tiecoms/web run -s build -- --outDir "$STAGE/app" --emptyOutDir
test "$(git rev-parse HEAD)" = "$SOURCE_COMMIT" && test -z "$(git status --porcelain)" || { echo 'Source changed during build; refusing upload.' >&2; exit 1; }
printf '%s\n' "$SOURCE_COMMIT" > "$STAGE/COMMIT"
cp "$STAGE/app/index.html" "$STAGE/index.expected.html"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf "$STAGE/$REL.tgz" app COMMIT index.expected.html
test "$(git rev-parse HEAD)" = "$SOURCE_COMMIT" && test -z "$(git status --porcelain)" || { echo 'Source changed during packaging; refusing upload.' >&2; exit 1; }
scp -q "$STAGE/$REL.tgz" "$HOST:/tmp/chaggu-web-$REL.tgz"
ssh "$HOST" "sudo bash -s -- '$REL'" <<'REMOTE'
set -euo pipefail
REL="$1"
BASE=/opt/tiecoms
exec 9>"$BASE/shared/web-deploy.lock"
flock -n 9 || { echo 'Another static deployment is running.' >&2; exit 1; }
PREV="$(readlink "$BASE/web/current")"
API_RELEASE="$(cat "$BASE/RELEASE")"
PREV_WEB="$(cat "$BASE/WEB_RELEASE" 2>/dev/null || true)"
DEST="$BASE/web-releases/$REL"
test ! -e "$DEST"
mkdir -p "$DEST"
swapped=0
cleanup() {
  code=$?
  if [ "$code" != 0 ] && [ "$swapped" = 1 ] && [ "$(readlink "$BASE/web/current")" = "$DEST" ]; then
    ln -s "$PREV" "$BASE/web/rollback-$REL"
    mv -Tf "$BASE/web/rollback-$REL" "$BASE/web/current"
    if [ "$(cat "$BASE/WEB_RELEASE" 2>/dev/null || true)" = "$REL" ]; then
      if [ -n "$PREV_WEB" ]; then printf '%s\n' "$PREV_WEB" > "$BASE/WEB_RELEASE"; else rm -f "$BASE/WEB_RELEASE"; fi
    fi
    echo 'Static verification failed; previous web restored.' >&2
  fi
  rm -f "/tmp/chaggu-web-$REL.tgz" "$BASE/web/next-$REL"
}
trap cleanup EXIT
tar -xzf "/tmp/chaggu-web-$REL.tgz" -C "$DEST"
test -s "$DEST/app/index.html"
# Copy, rather than link, the landing so a later full release cleanup is safe.
cp -a "$PREV/site" "$DEST/site"
# Open tabs may still request a lazy chunk from the preceding app release.
if [ -d "$PREV/app/assets" ]; then
  mkdir -p "$DEST/app/assets"
  cp -an "$PREV/app/assets/." "$DEST/app/assets/"
fi
test "$(readlink "$BASE/web/current")" = "$PREV"
test "$(cat "$BASE/RELEASE")" = "$API_RELEASE"
curl --connect-timeout 3 --max-time 10 -fsS http://127.0.0.1:3020/api/health/ready >/dev/null
ln -s "$DEST" "$BASE/web/next-$REL"
mv -Tf "$BASE/web/next-$REL" "$BASE/web/current"
swapped=1
curl --connect-timeout 3 --max-time 15 -fsS --resolve app.chaggu.com:443:127.0.0.1 "https://app.chaggu.com/?verify=$REL" > "$DEST/index.served.html"
cmp "$DEST/index.expected.html" "$DEST/index.served.html"
test "$(cat "$BASE/RELEASE")" = "$API_RELEASE"
printf '%s\n' "$REL" > "$BASE/WEB_RELEASE.next"
mv "$BASE/WEB_RELEASE.next" "$BASE/WEB_RELEASE"
python3 - "$REL" "$API_RELEASE" "$DEST" <<'PY'
import hashlib,json,sys
from pathlib import Path
r,a,d=sys.argv[1:];p=Path(d)
print(json.dumps({'webRelease':r,'commit':(p/'COMMIT').read_text().strip(),'apiReleaseUnchanged':a,'servedIndexSha256':hashlib.sha256((p/'index.served.html').read_bytes()).hexdigest(),'servicesRestarted':False}))
PY
REMOTE
