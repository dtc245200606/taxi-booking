-- =============================================================
-- Chế độ tài xế (khách hàng đã được duyệt làm tài xế đối tác)
--   - trips.driver_accepted_at   : thời điểm tài xế xác nhận đón khách (NULL = chờ tài xế xác nhận)
--   - trip_driver_rejections     : tài xế từ chối chuyến -> chuyến quay về "Chờ tài xế",
--                                  lần điều phối sau không giao lại cho tài xế đã từ chối
-- Chạy tự động khi khởi tạo volume mới. Với CSDL đã có sẵn, chạy tay:
--   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < db/init/09-driver-mode.sql
-- =============================================================
SET search_path TO taxi;

ALTER TABLE trips
    ADD COLUMN IF NOT EXISTS driver_accepted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS trip_driver_rejections (
    id           SERIAL       PRIMARY KEY,
    trip_id      INT          NOT NULL REFERENCES trips(id),
    driver_id    INT          NOT NULL REFERENCES drivers(id),
    reason       VARCHAR(200),
    rejected_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rejections_trip   ON trip_driver_rejections(trip_id, driver_id);
CREATE INDEX IF NOT EXISTS idx_rejections_driver ON trip_driver_rejections(driver_id, rejected_at DESC);

-- Chỉ thêm mới (append-only) giống lịch sử chuyến đi
GRANT SELECT, INSERT ON trip_driver_rejections TO taxi_app;
GRANT USAGE, SELECT ON SEQUENCE trip_driver_rejections_id_seq TO taxi_app;
GRANT SELECT ON trip_driver_rejections TO taxi_report;
