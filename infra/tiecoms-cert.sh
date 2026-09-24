#!/usr/bin/env bash
# Emite (o reutiliza) el certificado Let's Encrypt de tiecoms.com y lo enlaza para nginx.
# Mientras el DNS no llegue a este servidor, nginx usa un autofirmado temporal.
# Lo ejecuta tiecoms-cert.timer cada 10 minutos hasta lograrlo; luego el timer se apaga.
set -euo pipefail
TLS=/etc/nginx/tiecoms/tls
LE=/etc/letsencrypt/live/tiecoms.com
install -d -m 755 $TLS
if [ ! -e $TLS/fullchain.pem ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 30 -subj "/CN=www.tiecoms.com" \
    -keyout $TLS/selfsigned.key -out $TLS/selfsigned.crt >/dev/null 2>&1
  ln -sfn $TLS/selfsigned.crt $TLS/fullchain.pem
  ln -sfn $TLS/selfsigned.key $TLS/privkey.pem
fi
if [ ! -f $LE/fullchain.pem ]; then
  # Sonda barata antes de gastar intentos de Let's Encrypt: ¿el dominio público llega aquí?
  PROBE=$(openssl rand -hex 12)
  install -d /var/www/letsencrypt/.well-known/acme-challenge
  echo "$PROBE" > /var/www/letsencrypt/.well-known/acme-challenge/tiecoms-probe
  GOT=$(curl -fsS --max-time 10 http://www.tiecoms.com/.well-known/acme-challenge/tiecoms-probe 2>/dev/null || true)
  rm -f /var/www/letsencrypt/.well-known/acme-challenge/tiecoms-probe
  [ "$GOT" = "$PROBE" ] || { echo "tiecoms-cert: DNS aún no llega aquí"; exit 0; }
  certbot certonly --webroot -w /var/www/letsencrypt -d tiecoms.com -d www.tiecoms.com -d app.tiecoms.com --non-interactive --keep-until-expiring --expand -q || { echo "tiecoms-cert: DNS aún no llega aquí"; exit 0; }
fi
if [ "$(readlink $TLS/fullchain.pem)" != "$LE/fullchain.pem" ]; then
  ln -sfn $LE/fullchain.pem $TLS/fullchain.pem
  ln -sfn $LE/privkey.pem $TLS/privkey.pem
  nginx -t && systemctl reload nginx
  echo "tiecoms-cert: certificado Let's Encrypt activo"
fi
systemctl disable --now tiecoms-cert.timer 2>/dev/null || true
