#!/bin/sh
# Kiểm tra nhanh các biện pháp hardening đang được áp dụng (dùng để demo / chụp ảnh báo cáo)
# Cách dùng:  sh scripts/check-hardening.sh
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
HOST="${CHECK_HOST:-localhost}"

line() { printf '\n==== %s ====\n' "$1"; }

line "1. User chạy tiến trình, capabilities, read-only rootfs của từng container"
printf '%-24s %-12s %-10s %-14s %s\n' CONTAINER USER READONLY NO-NEW-PRIV CAP_DROP
for c in $(docker compose ps -q); do
  docker inspect "$c" --format '{{.Name}}|{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.SecurityOpt}}|{{.HostConfig.CapDrop}}' |
  awk -F'|' '{ u=($2==""?"root(image)":$2); sub("/","",$1); printf "%-24s %-12s %-10s %-14s %s\n", $1, u, $3, ($4 ~ /no-new-privileges/ ? "yes" : "no"), $5 }'
done

printf 'Tiến trình PostgreSQL chạy bằng user: '
docker exec taxi-postgres ps -o user= -o comm= | grep postgres | head -1 | awk '{print $1}'
printf 'Tiến trình Node.js chạy bằng user:    '
docker exec taxi-app sh -c 'ps -o user= -o comm= | grep node | head -1' | awk '{print $1}'

line "2. Cổng public ra host (chỉ Nginx 80/443)"
docker compose ps --format '{{.Name}}: {{.Ports}}' | grep -- '->' || echo "(không có)"

line "3. Network isolation"
docker network inspect taxi_backend --format 'taxi_backend internal={{.Internal}} subnet={{(index .IPAM.Config 0).Subnet}}'
for n in taxi_frontend taxi_backend taxi_monitoring; do
  printf '%s: ' "$n"; docker network inspect "$n" --format '{{range .Containers}}{{.Name}} {{end}}'; echo
done
printf 'App ra Internet được không? '
docker exec taxi-app sh -c 'wget -q -T 3 -O /dev/null http://example.com 2>/dev/null && echo "CÓ (không an toàn)" || echo "KHÔNG (bị chặn - đúng)"'
printf 'Grafana kết nối Prometheus (cùng mạng)? '
docker exec taxi-grafana sh -c 'nc -z -w 2 prometheus 9090 2>/dev/null && echo "CÓ"  || echo "KHÔNG"'
printf 'Grafana kết nối thẳng PostgreSQL được không? '
docker exec taxi-grafana sh -c 'nc -z -w 2 postgres 5432 2>/dev/null && echo "CÓ" || echo "KHÔNG (khác mạng - đúng)"'

line "4. Least privilege trong PostgreSQL"
printf 'taxi_app DELETE trips      -> '
docker exec -e PGPASSWORD="$APP_DB_PASSWORD" taxi-postgres psql -h 127.0.0.1 -U taxi_app -d "$POSTGRES_DB" -tAc "DELETE FROM taxi.trips WHERE id = -1" 2>&1 | head -1
printf 'taxi_app DROP TABLE        -> '
docker exec -e PGPASSWORD="$APP_DB_PASSWORD" taxi-postgres psql -h 127.0.0.1 -U taxi_app -d "$POSTGRES_DB" -tAc "DROP TABLE taxi.trips" 2>&1 | head -1
printf 'taxi_report UPDATE drivers -> '
docker exec -e PGPASSWORD="$REPORT_DB_PASSWORD" taxi-postgres psql -h 127.0.0.1 -U taxi_report -d "$POSTGRES_DB" -tAc "UPDATE taxi.drivers SET rating = 1" 2>&1 | head -1
printf 'taxi_monitor SELECT customers -> '
docker exec -e PGPASSWORD="$MONITOR_DB_PASSWORD" taxi-postgres psql -h 127.0.0.1 -U taxi_monitor -d "$POSTGRES_DB" -tAc "SELECT * FROM taxi.customers" 2>&1 | head -1
printf 'Phương thức mã hóa mật khẩu -> '
docker exec taxi-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT rolname || ': ' || left(rolpassword, 13) FROM pg_authid WHERE rolname LIKE 'taxi_%' ORDER BY 1" | tr '\n' ' '; echo

line "5. Security headers của Nginx"
curl -skI "https://$HOST/" | grep -iE 'strict-transport|x-frame|x-content-type|referrer-policy|content-security|permissions-policy|^server'

line "6. Chặn truy cập nhạy cảm"
printf 'HTTP -> HTTPS redirect:          '; curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' "http://$HOST/"
printf '/metrics từ Internet:            '; curl -sk -o /dev/null -w '%{http_code}\n' "https://$HOST/metrics"
printf '/.env, /.git:                    '; curl -sk -o /dev/null -w '%{http_code} ' "https://$HOST/.env"; curl -sk -o /dev/null -w '%{http_code}\n' "https://$HOST/.git/config"
printf '/prometheus/ không đăng nhập:    '; curl -sk -o /dev/null -w '%{http_code}\n' "https://$HOST/prometheus/"
printf 'Rate limit API (60 request):     '
for i in $(seq 1 60); do curl -sk -o /dev/null -w '%{http_code}\n' "https://$HOST/api/stats"; done | sort | uniq -c | tr '\n' ' '; echo

line "7. File bí mật"
ls -l .env | awk '{print ".env quyền: " $1}'
git check-ignore -q .env && echo ".env nằm trong .gitignore (không bị commit)"
