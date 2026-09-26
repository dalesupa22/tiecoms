#!/usr/bin/env bash
# Preparación única del servidor (idempotente). Ejecutar con sudo en la EC2.
# No toca los sitios existentes: solo añade archivos de TieComs.
set -euo pipefail
SRC="${1:?ruta a la carpeta infra subida}"
install -d -m 755 /opt/tiecoms/shared /opt/tiecoms/web /etc/nginx/tiecoms /var/www/letsencrypt
[ -f /opt/tiecoms/shared/rds-ca.pem ] || curl -fsS https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /opt/tiecoms/shared/rds-ca.pem
chmod 644 /opt/tiecoms/shared/rds-ca.pem
install -m 644 "$SRC/nginx/cloudflare-realip.conf" /etc/nginx/tiecoms/cloudflare-realip.conf
install -m 644 "$SRC/nginx/security-headers.conf" /etc/nginx/tiecoms/security-headers.conf
install -m 644 "$SRC/nginx/api-locations.conf" /etc/nginx/tiecoms/api-locations.conf
install -m 644 "$SRC/nginx/00-tiecoms-cloudflare.conf" /etc/nginx/conf.d/00-tiecoms-cloudflare.conf
install -m 755 "$SRC/tiecoms-cert.sh" /usr/local/sbin/tiecoms-cert
# Certificado temporal primero para que la configuración completa cargue.
/usr/local/sbin/tiecoms-cert || true
install -m 644 "$SRC/nginx/tiecoms.conf" /etc/nginx/conf.d/tiecoms.conf
nginx -t && systemctl reload nginx
cat > /etc/systemd/system/tiecoms-cert.service <<'UNIT'
[Unit]
Description=Chaggu: emitir certificados Let's Encrypt cuando el DNS llegue
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tiecoms-cert
UNIT
cat > /etc/systemd/system/tiecoms-cert.timer <<'UNIT'
[Unit]
Description=Chaggu: reintento del certificado cada 10 minutos
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
[ -f /etc/letsencrypt/live/tiecoms.com/fullchain.pem ] || systemctl enable --now tiecoms-cert.timer
echo "✓ servidor listo para TieComs"
