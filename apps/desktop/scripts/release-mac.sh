#!/usr/bin/env bash
# Chaggu para Mac: .dmg universal firmado con Developer ID y notarizado por Apple.
#
# Requiere (una sola vez):
#   1. Certificado «Developer ID Application: CERTILABOR SAS (B76US7H3L3)» en el Llavero
#      (developer.apple.com → Certificates → + → Developer ID Application).
#   2. Llave de App Store Connect para notarizar (Users and Access → Integrations → Team Keys,
#      rol Developer), guardada en tiecoms/.secrets/:
#        notary_AuthKey.p8, notary_key_id (10 caracteres), notary_issuer_id (UUID)
# Uso: bash apps/desktop/scripts/release-mac.sh   → release-assets/desktop-<versión>/
set -euo pipefail
cd "$(dirname "$0")/.."
SECRETS="${CHAGGU_SECRETS:-/Users/danny/Documents/EntreEmpresas/tiecoms/.secrets}"
OUT="${CHAGGU_RELEASES:-/Users/danny/Documents/EntreEmpresas/release-assets}"
source "$HOME/.cargo/env" 2>/dev/null || true

IDENTITY=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*B76US7H3L3)\)".*/\1/p' | head -1)
[ -n "$IDENTITY" ] || { echo "Falta el certificado Developer ID Application de B76US7H3L3 en el Llavero" >&2; exit 1; }
for f in notary_AuthKey.p8 notary_key_id notary_issuer_id; do
  [ -s "$SECRETS/$f" ] || { echo "Falta $SECRETS/$f (ver el encabezado de este script)" >&2; exit 1; }
done

export APPLE_SIGNING_IDENTITY="$IDENTITY"
export APPLE_API_KEY="$(tr -d '[:space:]' < "$SECRETS/notary_key_id")"
export APPLE_API_ISSUER="$(tr -d '[:space:]' < "$SECRETS/notary_issuer_id")"
export APPLE_API_KEY_PATH="$SECRETS/notary_AuthKey.p8"

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
# CI=true: el .dmg se arma sin manejar el Finder por AppleScript.
CI=true npx tauri build --target universal-apple-darwin --bundles app,dmg

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
PRODUCT=$(node -p "require('./src-tauri/tauri.conf.json').productName")
DMG="src-tauri/target/universal-apple-darwin/release/bundle/dmg/${PRODUCT}_${VERSION}_universal.dmg"
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/${PRODUCT}.app"
# Tauri notariza y engrapa la .app; el .dmg también se notariza para que abra sin avisos sin conexión.
codesign --force --sign "$IDENTITY" --timestamp "$DMG"
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"

codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
spctl -a -vvv -t exec "$APP"
spctl -a -vvv -t open --context context:primary-signature "$DMG"
mkdir -p "$OUT/desktop-$VERSION"
cp "$DMG" "$OUT/desktop-$VERSION/Chaggu-$VERSION-mac.dmg"
echo "Listo: $OUT/desktop-$VERSION/Chaggu-$VERSION-mac.dmg"
