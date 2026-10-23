-- =============================================================
-- Quên mật khẩu (khách hàng): token đặt lại gửi qua email
--   - Chỉ lưu SHA-256 của token, không lưu token gốc
--   - Dùng 1 lần (used_at), hết hạn sau 30 phút (expires_at)
-- Chạy tự động khi khởi tạo volume mới. Với CSDL đã có sẵn, chạy tay:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < db/init/06-password-reset.sql
-- =============================================================
SET search_path TO taxi;

CREATE TABLE IF NOT EXISTS password_resets (
    token_hash  CHAR(64)     PRIMARY KEY,
    user_id     INT          NOT NULL REFERENCES users(id),
    ip          VARCHAR(45),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ  NOT NULL,
    used_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_at DESC);
-- Tìm khách theo email khi quên mật khẩu (không phân biệt hoa thường)
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(lower(email));

GRANT SELECT, INSERT, UPDATE ON password_resets TO taxi_app;
