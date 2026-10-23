-- =============================================================
-- Hồ sơ cá nhân cho mọi tài khoản
--   - Nhân viên (admin, dispatcher) có thêm SĐT / email liên hệ (khách hàng dùng bảng customers)
--   - Phiên đăng nhập lưu thêm User-Agent để người dùng nhận biết thiết bị đang đăng nhập
-- Chạy tự động khi khởi tạo volume mới. Với CSDL đã có sẵn, chạy tay:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < db/init/08-profile.sql
-- =============================================================
SET search_path TO taxi;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
    ADD COLUMN IF NOT EXISTS email VARCHAR(100);

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS user_agent VARCHAR(200);

-- taxi_app đã có quyền SELECT/INSERT/UPDATE trên toàn bảng users, sessions (04-auth.sql) nên dùng được cột mới.
-- taxi_report chỉ được đọc một số cột của users -> không thấy SĐT / email (dữ liệu cá nhân).
