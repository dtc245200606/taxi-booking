#!/bin/sh
# Tạo / xóa dữ liệu demo (ảo) cho hệ thống. Cần các container taxi-app và taxi-postgres đang chạy.
# Cách dùng:
#   sh scripts/seed-demo.sh            tạo dữ liệu demo (báo lỗi nếu đã có)
#   sh scripts/seed-demo.sh --reset    xóa dữ liệu demo cũ rồi tạo lại (số liệu ngày tháng mới nhất)
#   sh scripts/seed-demo.sh --remove   chỉ xóa dữ liệu demo
# Mật khẩu cho mọi tài khoản demo: biến DEMO_PASSWORD (mặc định demo1234)
set -eu
cd "$(dirname "$0")/.."

MODE="${1:-}"
DEMO_PASSWORD="${DEMO_PASSWORD:-demo1234}"

psql_run() {
  # $1 = file SQL, các tham số sau truyền vào psql dạng -v
  file="$1"; shift
  docker compose exec -T postgres sh -c 'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' sh "$@" < "$file"
}

if [ "$MODE" = "--reset" ] || [ "$MODE" = "--remove" ]; then
  echo "==> Xóa dữ liệu demo cũ"
  psql_run db/demo/remove-demo.sql
  [ "$MODE" = "--remove" ] && exit 0
fi

echo "==> Băm mật khẩu demo bằng scrypt (dùng chính hàm của ứng dụng)"
HASH=$(docker exec taxi-app node -e \
  "require('/app/src/auth').hashPassword(process.argv[1]).then((h) => { console.log(h); process.exit(0); })" \
  "$DEMO_PASSWORD")

echo "==> Tạo dữ liệu demo"
psql_run db/demo/seed-demo.sql -v "pw_hash=$HASH"

cat <<EOF

Xong! Tài khoản demo (mật khẩu: $DEMO_PASSWORD):
  Điều phối viên : dieuphoi01, dieuphoi02   (dieuphoi03 đang bị khóa)
  Khách hàng     : xem tab Khách hàng / Nhân viên, vd. tên đăng nhập dạng "lan.nguyen07"
Liệt kê tài khoản khách demo:
  docker compose exec postgres sh -c 'psql -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" -c "SELECT username, full_name FROM taxi.users WHERE role = \$\$customer\$\$ ORDER BY id"'
EOF
