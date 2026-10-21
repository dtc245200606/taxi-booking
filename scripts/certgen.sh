#!/bin/sh
# Chạy trong container "certgen" (image alpine/openssl) lúc khởi động hệ thống.
# Sinh chứng chỉ SSL tự ký cho Nginx nếu chưa có (lưu trong volume "certs").
set -eu
CERT_DIR=/certs
DOMAIN="${DOMAIN:-taxi.local}"

if [ ! -s "$CERT_DIR/$DOMAIN.crt" ] || [ ! -s "$CERT_DIR/$DOMAIN.key" ]; then
  echo "[certgen] Tạo chứng chỉ tự ký cho $DOMAIN ..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERT_DIR/$DOMAIN.key" \
    -out    "$CERT_DIR/$DOMAIN.crt" \
    -subj   "/C=VN/ST=ThaiNguyen/L=ThaiNguyen/O=TaxiBooking/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN,DNS:localhost,IP:127.0.0.1"
else
  echo "[certgen] Chứng chỉ đã tồn tại, bỏ qua."
fi

# Nginx chạy bằng UID 101: chỉ user này đọc được private key
chown 101:101 "$CERT_DIR/$DOMAIN.key" "$CERT_DIR/$DOMAIN.crt"
chmod 600 "$CERT_DIR/$DOMAIN.key"
chmod 644 "$CERT_DIR/$DOMAIN.crt"
echo "[certgen] Xong."
