#!/bin/sh
# Chạy trong container "certgen" (image alpine/openssl) lúc khởi động hệ thống.
# Sinh chứng chỉ SSL tự ký cho Nginx nếu chưa có (lưu trong volume "certs")
# và file htpasswd cho Basic Auth.
# Container chỉ có quyền CHOWN nên: tạo file -> chmod -> chown (chuyển cho Nginx UID 101).
set -eu
CERT_DIR=/certs
DOMAIN="${DOMAIN:-taxi.local}"

if [ ! -s "$CERT_DIR/$DOMAIN.crt" ] || [ ! -s "$CERT_DIR/$DOMAIN.key" ]; then
  echo "[certgen] Tạo chứng chỉ tự ký cho $DOMAIN ..."
  rm -f "$CERT_DIR/$DOMAIN.key" "$CERT_DIR/$DOMAIN.crt"
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERT_DIR/$DOMAIN.key" \
    -out    "$CERT_DIR/$DOMAIN.crt" \
    -subj   "/C=VN/ST=ThaiNguyen/L=ThaiNguyen/O=TaxiBooking/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN,DNS:localhost,IP:127.0.0.1" 2>/dev/null
  chmod 600 "$CERT_DIR/$DOMAIN.key"      # chỉ chủ sở hữu (Nginx) đọc được private key
  chmod 644 "$CERT_DIR/$DOMAIN.crt"
  chown 101:101 "$CERT_DIR/$DOMAIN.key" "$CERT_DIR/$DOMAIN.crt"
  openssl x509 -in "$CERT_DIR/$DOMAIN.crt" -noout -subject -enddate
else
  echo "[certgen] Chứng chỉ đã tồn tại, bỏ qua."
fi

# File mật khẩu HTTP Basic Auth bảo vệ Prometheus UI (luôn sinh lại theo .env)
if [ -n "${BASIC_AUTH_PASSWORD:-}" ]; then
  rm -f "$CERT_DIR/htpasswd"
  printf '%s:%s\n' "${BASIC_AUTH_USER:-monitor}" "$(openssl passwd -apr1 "$BASIC_AUTH_PASSWORD")" > "$CERT_DIR/htpasswd"
  chmod 600 "$CERT_DIR/htpasswd"
  chown 101:101 "$CERT_DIR/htpasswd"
  echo "[certgen] Đã tạo htpasswd cho user ${BASIC_AUTH_USER:-monitor}"
fi
echo "[certgen] Xong."
