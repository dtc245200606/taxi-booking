-- =============================================================
-- Tài khoản đăng nhập + phiên làm việc (session)
--   users    : tài khoản; role = dispatcher (điều phối viên) | customer (khách hàng)
--   sessions : phiên đăng nhập; chỉ lưu SHA-256 của token, không lưu token gốc
-- Chạy tự động khi khởi tạo volume mới. Với CSDL đã có sẵn, chạy tay:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < db/init/04-auth.sql
-- =============================================================
SET search_path TO taxi;

CREATE TABLE IF NOT EXISTS users (
    id             SERIAL PRIMARY KEY,
    username       VARCHAR(30)  NOT NULL UNIQUE,
    password_hash  VARCHAR(255) NOT NULL,          -- scrypt$N$r$p$salt$hash
    full_name      VARCHAR(100) NOT NULL,
    role           VARCHAR(10)  NOT NULL DEFAULT 'customer'
                   CHECK (role IN ('dispatcher', 'customer')),
    customer_id    INT          UNIQUE REFERENCES customers(id),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_login_at  TIMESTAMPTZ,
    -- Tài khoản khách hàng bắt buộc gắn với một hồ sơ khách hàng
    CHECK (role <> 'customer' OR customer_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  CHAR(64)     PRIMARY KEY,           -- SHA-256 (hex) của token trong cookie
    user_id     INT          NOT NULL REFERENCES users(id),
    ip          VARCHAR(45),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ  NOT NULL,
    revoked_at  TIMESTAMPTZ                         -- đăng xuất = đánh dấu thu hồi (app không có quyền DELETE)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Quyền: ứng dụng đọc/ghi, không xóa; báo cáo chỉ đọc các cột không nhạy cảm
GRANT SELECT, INSERT, UPDATE ON users, sessions TO taxi_app;
GRANT USAGE, SELECT ON SEQUENCE users_id_seq TO taxi_app;
GRANT SELECT (id, username, full_name, role, customer_id, created_at, last_login_at) ON users TO taxi_report;
