-- =============================================================
-- Đề 22: Hệ thống Đặt xe / Taxi Booking - Lược đồ CSDL
-- Chạy tự động 1 lần khi container PostgreSQL khởi tạo volume mới
-- =============================================================

-- Toàn bộ bảng nằm trong schema riêng "taxi", không dùng schema public
CREATE SCHEMA IF NOT EXISTS taxi;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

SET search_path TO taxi;

CREATE TABLE customers (
    id          SERIAL PRIMARY KEY,
    full_name   VARCHAR(100) NOT NULL,
    phone       VARCHAR(20)  NOT NULL UNIQUE,
    email       VARCHAR(100),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
    id             SERIAL PRIMARY KEY,
    full_name      VARCHAR(100) NOT NULL,
    phone          VARCHAR(20)  NOT NULL UNIQUE,
    license_plate  VARCHAR(20)  NOT NULL UNIQUE,
    vehicle_type   VARCHAR(10)  NOT NULL CHECK (vehicle_type IN ('bike', 'car4', 'car7')),
    status         VARCHAR(10)  NOT NULL DEFAULT 'available'
                   CHECK (status IN ('available', 'on_trip', 'offline')),
    rating         NUMERIC(2,1) NOT NULL DEFAULT 5.0 CHECK (rating BETWEEN 1 AND 5),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE trips (
    id               SERIAL PRIMARY KEY,
    customer_id      INT          NOT NULL REFERENCES customers(id),
    driver_id        INT          REFERENCES drivers(id),
    pickup_address   VARCHAR(200) NOT NULL,
    dropoff_address  VARCHAR(200) NOT NULL,
    vehicle_type     VARCHAR(10)  NOT NULL CHECK (vehicle_type IN ('bike', 'car4', 'car7')),
    distance_km      NUMERIC(6,1) NOT NULL CHECK (distance_km > 0),
    fare             INT          NOT NULL CHECK (fare >= 0),
    status           VARCHAR(12)  NOT NULL DEFAULT 'requested'
                     CHECK (status IN ('requested', 'assigned', 'in_progress', 'completed', 'cancelled')),
    cancel_reason    VARCHAR(200),
    requested_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    assigned_at      TIMESTAMPTZ,
    started_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    cancelled_at     TIMESTAMPTZ
);

-- Lịch sử chuyển trạng thái (audit trail) của chuyến đi
CREATE TABLE trip_status_history (
    id           SERIAL PRIMARY KEY,
    trip_id      INT          NOT NULL REFERENCES trips(id),
    from_status  VARCHAR(12),
    to_status    VARCHAR(12)  NOT NULL,
    note         VARCHAR(200),
    changed_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_trips_status      ON trips(status);
CREATE INDEX idx_trips_customer    ON trips(customer_id);
CREATE INDEX idx_trips_driver      ON trips(driver_id);
CREATE INDEX idx_drivers_status    ON drivers(status, vehicle_type);
CREATE INDEX idx_history_trip      ON trip_status_history(trip_id);

-- View báo cáo doanh thu theo tài xế (dùng cho tài khoản chỉ đọc)
CREATE VIEW driver_revenue AS
SELECT d.id, d.full_name, d.license_plate,
       COUNT(t.id) FILTER (WHERE t.status = 'completed')            AS completed_trips,
       COALESCE(SUM(t.fare) FILTER (WHERE t.status = 'completed'), 0) AS revenue
  FROM drivers d LEFT JOIN trips t ON t.driver_id = d.id
 GROUP BY d.id;
