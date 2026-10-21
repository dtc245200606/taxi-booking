#!/bin/sh
# =============================================================
# Tạo các tài khoản CSDL theo nguyên tắc ĐẶC QUYỀN TỐI THIỂU
#   - POSTGRES_USER (taxi_admin): chủ sở hữu, chỉ dùng để quản trị qua pgAdmin
#   - taxi_app     : ứng dụng web -> SELECT/INSERT/UPDATE, KHÔNG có DELETE/DDL
#   - taxi_report  : báo cáo      -> chỉ SELECT
#   - taxi_monitor : postgres-exporter -> role hệ thống pg_monitor, không đọc bảng nghiệp vụ
# Mật khẩu lấy từ biến môi trường (.env), không ghi cứng trong mã nguồn.
# =============================================================
set -eu

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_pw="$APP_DB_PASSWORD" \
     -v report_pw="$REPORT_DB_PASSWORD" \
     -v monitor_pw="$MONITOR_DB_PASSWORD" \
     -v db="$POSTGRES_DB" <<'EOSQL'
SET password_encryption = 'scram-sha-256';

CREATE ROLE taxi_app     LOGIN PASSWORD :'app_pw'     CONNECTION LIMIT 30;
CREATE ROLE taxi_report  LOGIN PASSWORD :'report_pw'  CONNECTION LIMIT 5;
CREATE ROLE taxi_monitor LOGIN PASSWORD :'monitor_pw' CONNECTION LIMIT 3;

-- Không ai được kết nối mặc định, chỉ cấp cho role cần thiết
REVOKE CONNECT ON DATABASE :"db" FROM PUBLIC;
GRANT  CONNECT ON DATABASE :"db" TO taxi_app, taxi_report, taxi_monitor;

-- search_path mặc định trỏ vào schema taxi
ALTER ROLE taxi_app    SET search_path = taxi;
ALTER ROLE taxi_report SET search_path = taxi;

-- Ứng dụng: đọc/ghi dữ liệu, không xóa, không tạo/sửa bảng
GRANT USAGE ON SCHEMA taxi TO taxi_app, taxi_report;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA taxi TO taxi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA taxi TO taxi_app;
-- Bảng lịch sử chỉ cho thêm mới (append-only) -> không sửa được dấu vết
REVOKE UPDATE ON taxi.trip_status_history FROM taxi_app;

-- Báo cáo: chỉ đọc
GRANT SELECT ON ALL TABLES IN SCHEMA taxi TO taxi_report;

-- Giám sát: role có sẵn pg_monitor (đọc pg_stat_*), không đọc dữ liệu nghiệp vụ
GRANT pg_monitor TO taxi_monitor;
EOSQL

echo "[init] Đã tạo role taxi_app, taxi_report, taxi_monitor"
