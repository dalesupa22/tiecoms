#!/usr/bin/env bash
# Emite (o reutiliza) los certificados Let's Encrypt de chaggu.com y del dominio anterior
# tiecoms.com, y los enlaza para nginx. Uso: tiecoms-cert [tiecoms|chaggu] (sin argumento: ambos).
# Mientras el DNS no llegue a este servidor, nginx usa un autofirmado temporal.
# Lo ejecuta tiecoms-cert.timer cada 10 minutos hasta lograrlo; luego el timer se apaga.
set -euo pipefail

# cert <nombre> <dir tls> <host de sonda> <dominios...>
cert() {
  local NAME=$1 TLS=$2 PROBE_HOST=$3; shift 3
  local LE=/etc/letsencrypt/live/$NAME
  install -d -m 755 "$TLS"
  if [ ! -e "$TLS/fullchain.pem" ]; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj "/CN=$PROBE_HOST" \
      -keyout "$TLS/selfsigned.key" -out "$TLS/selfsigned.crt" >/dev/null 2>&1
    ln -sfn "$TLS/selfsigned.crt" "$TLS/fullchain.pem"
    ln -sfn "$TLS/selfsigned.key" "$TLS/privkey.pem"
  fi
  if [ ! -f "$LE/fullchain.pem" ]; then
    # Sonda barata antes de gastar intentos de Let's Encrypt: ¿el dominio público llega aquí?
    local PROBE GOT args=()
    PROBE=$(openssl rand -hex 12)
    install -d /var/www/letsencrypt/.well-known/acme-challenge
    echo "$PROBE" > /var/www/letsencrypt/.well-known/acme-challenge/tiecoms-probe
    GOT=$(curl -fsS --max-time 10 "http://$PROBE_HOST/.well-known/acme-challenge/tiecoms-probe" 2>/dev/null || true)
    rm -f /var/www/letsencrypt/.well-known/acme-challenge/tiecoms-probe
    [ "$GOT" = "$PROBE" ] || { echo "tiecoms-cert: el DNS de $NAME aún no llega aquí"; return 1; }
    for d in "$@"; do args+=(-d "$d"); done
    certbot certonly --webroot -w /var/www/letsencrypt --cert-name "$NAME" "${args[@]}" \
      --non-interactive --keep-until-expiring --expand -q || { echo "tiecoms-cert: certbot falló para $NAME"; return 1; }
  fi
  if [ "$(readlink "$TLS/fullchain.pem")" != "$LE/fullchain.pem" ]; then
    ln -sfn "$LE/fullchain.pem" "$TLS/fullchain.pem"
    ln -sfn "$LE/privkey.pem" "$TLS/privkey.pem"
    nginx -t && systemctl reload nginx
    echo "tiecoms-cert: certificado Let's Encrypt de $NAME activo"
  fi
}

pending=0
if [ "${1:-}" != chaggu ]; then
  cert tiecoms.com /etc/nginx/tiecoms/tls www.tiecoms.com tiecoms.com www.tiecoms.com app.tiecoms.com || pending=1
fi
if [ "${1:-}" != tiecoms ]; then
  cert chaggu.com /etc/nginx/tiecoms/tls-chaggu www.chaggu.com chaggu.com www.chaggu.com app.chaggu.com || pending=1
fi
[ "$pending" = 1 ] || systemctl disable --now tiecoms-cert.timer 2>/dev/null || true
