-- =============================================================
-- Khách hàng đăng ký làm tài xế đối tác
--   driver_applications : hồ sơ đăng ký (thông tin cá nhân, phương tiện, GPLX, đồng ý điều khoản)
--   Luồng: pending (chờ duyệt) -> approved (tạo bản ghi drivers) | rejected (kèm lý do) | cancelled (khách tự hủy)
-- Chạy tự động khi khởi tạo volume mới. Với CSDL đã có sẵn, chạy tay:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < db/init/07-driver-applications.sql
-- =============================================================
SET search_path TO taxi;

-- Tài xế được tạo từ hồ sơ đăng ký sẽ gắn với tài khoản của khách + lưu thông tin GPLX
ALTER TABLE drivers
    ADD COLUMN IF NOT EXISTS user_id             INT UNIQUE REFERENCES users(id),
    ADD COLUMN IF NOT EXISTS license_number      VARCHAR(15),
    ADD COLUMN IF NOT EXISTS license_class       VARCHAR(3),
    ADD COLUMN IF NOT EXISTS license_expires_on  DATE;

CREATE TABLE IF NOT EXISTS driver_applications (
    id                  SERIAL       PRIMARY KEY,
    user_id             INT          NOT NULL REFERENCES users(id),
    customer_id         INT          NOT NULL REFERENCES customers(id),
    full_name           VARCHAR(100) NOT NULL,
    phone               VARCHAR(20)  NOT NULL,
    date_of_birth       DATE         NOT NULL,
    national_id         CHAR(12)     NOT NULL,                       -- số CCCD 12 chữ số
    vehicle_type        VARCHAR(10)  NOT NULL CHECK (vehicle_type IN ('bike', 'car4', 'car7')),
    license_plate       VARCHAR(20)  NOT NULL,
    vehicle_model       VARCHAR(60)  NOT NULL,                       -- hãng / dòng xe / màu
    license_number      VARCHAR(15)  NOT NULL,
    license_class       VARCHAR(3)   NOT NULL,
    license_issued_on   DATE         NOT NULL,
    license_expires_on  DATE,                                        -- NULL = không thời hạn (A1, A, A2)
    -- Bằng chứng đồng ý điều khoản: phiên bản + danh sách điều khoản + thời điểm + IP
    terms_version       VARCHAR(20)  NOT NULL,
    terms_accepted      JSONB        NOT NULL,
    terms_accepted_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    terms_ip            VARCHAR(45),
    status              VARCHAR(10)  NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    review_note         VARCHAR(300),
    reviewed_by         INT          REFERENCES users(id),
    reviewed_at         TIMESTAMPTZ,
    driver_id           INT          REFERENCES drivers(id),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CHECK (license_expires_on IS NULL OR license_expires_on > license_issued_on)
);

-- Mỗi khách chỉ có tối đa 1 hồ sơ đang chờ duyệt
CREATE UNIQUE INDEX IF NOT EXISTS uq_driver_app_pending ON driver_applications(user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_driver_app_status ON driver_applications(status, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON driver_applications TO taxi_app;
GRANT USAGE, SELECT ON SEQUENCE driver_applications_id_seq TO taxi_app;
-- Báo cáo: không cho đọc CCCD / ngày sinh (dữ liệu cá nhân nhạy cảm)
GRANT SELECT (id, user_id, customer_id, full_name, vehicle_type, license_plate, license_class, status,
              reviewed_by, reviewed_at, driver_id, created_at) ON driver_applications TO taxi_report;
