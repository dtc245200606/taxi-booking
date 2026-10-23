-- =============================================================
-- Quản lý nhân viên + nhật ký hoạt động (audit log)
--   role: admin (quản trị) | dispatcher (nhân viên điều phối) | customer (khách hàng)
--   audit_log: chỉ cho THÊM MỚI - ứng dụng không có quyền sửa/xóa -> không xóa được dấu vết
-- Chạy tự động khi khởi tạo volume mới. Với CSDL đã có sẵn, chạy tay:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < db/init/05-staff.sql
-- =============================================================
SET search_path TO taxi;

-- Thêm vai trò admin
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'dispatcher', 'customer'));

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_active            BOOLEAN     NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS password_changed_at  TIMESTAMPTZ;

-- Tài khoản quản trị tạo từ .env trước đây là dispatcher -> nâng lên admin
UPDATE users SET role = 'admin' WHERE username = 'admin' AND role = 'dispatcher';

CREATE TABLE IF NOT EXISTS audit_log (
    id           BIGSERIAL    PRIMARY KEY,
    at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    user_id      INT          REFERENCES users(id),   -- NULL nếu chưa xác định (vd: đăng nhập sai username)
    username     VARCHAR(30),                         -- lưu lại tên tại thời điểm thao tác
    role         VARCHAR(10),
    action       VARCHAR(40)  NOT NULL,
    target_type  VARCHAR(20),
    target_id    INT,
    detail       JSONB,
    ip           VARCHAR(45)
);

CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- Ứng dụng: chỉ được đọc và thêm nhật ký, KHÔNG được sửa
GRANT SELECT, INSERT ON audit_log TO taxi_app;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO taxi_app;
GRANT SELECT ON audit_log TO taxi_report;
GRANT SELECT (is_active, must_change_password, password_changed_at) ON users TO taxi_report;
