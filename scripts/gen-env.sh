#!/bin/sh
# Sinh file .env với mật khẩu ngẫu nhiên mạnh (24 ký tự) cho mọi tài khoản.
# Cách dùng:  sh scripts/gen-env.sh        (không ghi đè nếu .env đã tồn tại)
set -eu
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo ".env đã tồn tại - không ghi đè. Xóa file .env nếu muốn sinh lại."
  exit 1
fi

rand() {
  # 24 ký tự gồm chữ hoa, chữ thường, số + 1 ký tự đặc biệt an toàn cho URL/shell
  pw=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 22)
  printf '%s_%s' "$pw" "$(LC_ALL=C tr -dc '0-9' </dev/urandom | head -c 1)"
}

sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand)|" \
  -e "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$(rand)|" \
  -e "s|^REPORT_DB_PASSWORD=.*|REPORT_DB_PASSWORD=$(rand)|" \
  -e "s|^MONITOR_DB_PASSWORD=.*|MONITOR_DB_PASSWORD=$(rand)|" \
  -e "s|^APP_ADMIN_PASSWORD=.*|APP_ADMIN_PASSWORD=$(rand)|" \
  -e "s|^PGADMIN_PASSWORD=.*|PGADMIN_PASSWORD=$(rand)|" \
  -e "s|^GRAFANA_ADMIN_PASSWORD=.*|GRAFANA_ADMIN_PASSWORD=$(rand)|" \
  -e "s|^MONITOR_BASIC_AUTH_PASSWORD=.*|MONITOR_BASIC_AUTH_PASSWORD=$(rand)|" \
  .env.example > .env
chmod 600 .env
echo "Đã tạo .env (quyền 600). Xem mật khẩu: cat .env"
