#!/usr/bin/env bash
# Despliegue reproducible de Chaggu (antes TieComs) a la EC2 (ssh ReimaginedClubServer).
# Compila localmente, sube un artefacto versionado, migra, arranca y verifica.
# Si la verificación falla, vuelve a la versión anterior.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${TIECOMS_HOST:-ReimaginedClubServer}"
REL="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo local)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "▸ verificando tipos"
npm run -s typecheck
echo "▸ compilando $REL"
npm -w @tiecoms/api run -s build
npm -w @tiecoms/web run -s build
echo "▸ landing"
python3 apps/landing/build.py >/dev/null

mkdir -p "$STAGE/$REL"
cp -R apps/api/dist "$STAGE/$REL/api"
# web/site = landing (www.chaggu.com) · web/app = app (app.chaggu.com).
mkdir -p "$STAGE/$REL/web"
cp -R apps/landing/dist "$STAGE/$REL/web/site"
cp -R apps/web/dist "$STAGE/$REL/web/app"
cp infra/Dockerfile.api infra/compose.yml infra/tiecoms-cert.sh "$STAGE/$REL/"
cp -R infra/nginx "$STAGE/$REL/nginx"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$STAGE" -czf "$STAGE/$REL.tgz" "$REL"

echo "▸ subiendo artefacto ($(du -h "$STAGE/$REL.tgz" | cut -f1))"
scp -q "$STAGE/$REL.tgz" "$HOST:/tmp/tiecoms-$REL.tgz"

ssh "$HOST" "sudo bash -s -- $REL" <<'REMOTE'
set -euo pipefail
REL="$1"
BASE=/opt/tiecoms
PREV="$(cat $BASE/RELEASE 2>/dev/null || true)"
mkdir -p $BASE/releases $BASE/web
tar -C $BASE/releases -xzf /tmp/tiecoms-$REL.tgz && rm -f /tmp/tiecoms-$REL.tgz
cd $BASE/releases/$REL

echo "▸ imagen tiecoms-api:$REL"
docker build -q -t tiecoms-api:$REL -f Dockerfile.api . >/dev/null

echo "▸ migraciones"
docker run --rm --env-file $BASE/shared/api.env -v $BASE/shared/rds-ca.pem:/run/secrets/rds-ca.pem:ro tiecoms-api:$REL node migrate.js

echo "▸ arrancando"
TIECOMS_RELEASE=$REL docker compose -f compose.yml up -d --remove-orphans

ok=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3020/api/health/ready >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  echo "✗ el API no quedó sano; volviendo a ${PREV:-nada}"
  docker compose -f compose.yml logs --tail 50 api || true
  if [ -n "$PREV" ]; then (cd $BASE/releases/$PREV && TIECOMS_RELEASE=$PREV docker compose -f compose.yml up -d); fi
  exit 1
fi

ln -sfn $BASE/releases/$REL/web $BASE/web/current
echo "$REL" > $BASE/RELEASE
# Configuración de nginx versionada con la release (solo archivos de TieComs).
install -m 644 nginx/chaggu-http.conf /etc/nginx/conf.d/chaggu-http.conf
install -m 755 tiecoms-cert.sh /usr/local/sbin/tiecoms-cert
nginx -t && systemctl reload nginx
# Los server de chaggu.com necesitan su certificado (infra/tiecoms-cert.sh). Mientras no
# exista, se deja la configuración anterior para no romper nginx.
if [ -e /etc/nginx/tiecoms/tls/fullchain.pem ] && [ -e /etc/nginx/tiecoms/tls-chaggu/fullchain.pem ]; then
  install -m 644 nginx/security-headers.conf /etc/nginx/tiecoms/security-headers.conf
  install -m 644 nginx/api-locations.conf /etc/nginx/tiecoms/api-locations.conf
  install -m 644 nginx/app-links.conf /etc/nginx/tiecoms/app-links.conf
  install -m 644 nginx/app-links-redirect.conf /etc/nginx/tiecoms/app-links-redirect.conf
  install -m 644 nginx/00-tiecoms-cloudflare.conf /etc/nginx/conf.d/00-tiecoms-cloudflare.conf
  cp /etc/nginx/conf.d/tiecoms.conf /tmp/tiecoms.conf.prev 2>/dev/null || true
  install -m 644 nginx/tiecoms.conf /etc/nginx/conf.d/tiecoms.conf
  if nginx -t; then systemctl reload nginx; else
    echo "✗ nginx rechazó la configuración nueva; se restaura la anterior"
    cp /tmp/tiecoms.conf.prev /etc/nginx/conf.d/tiecoms.conf && nginx -t && systemctl reload nginx
  fi
else
  echo "! falta el certificado de chaggu.com: nginx sigue con la configuración anterior"
fi
# Conserva las últimas 5 versiones.
ls -1dt $BASE/releases/*/ | tail -n +6 | xargs -r rm -rf
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^tiecoms-api:' | grep -v ":$REL$" | grep -v ":${PREV:-none}$" | xargs -r docker image rm >/dev/null 2>&1 || true
echo "✓ Chaggu $REL en línea"
REMOTE
