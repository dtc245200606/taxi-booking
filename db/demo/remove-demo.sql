-- =============================================================
-- Xóa sạch dữ liệu demo (do db/demo/seed-demo.sql tạo) - chạy qua: sh scripts/seed-demo.sh --remove
-- Nhận diện bằng: SĐT khách 0399xxxxxx, tài xế 0398xxxxxx, nhân viên 0397xxxxxx.
-- Nếu dữ liệu THẬT đang tham chiếu tới dữ liệu demo (vd: chuyến của khách thật được giao cho tài xế demo)
-- thì dừng lại, không xóa gì.
-- =============================================================
\set ON_ERROR_STOP on
SET search_path TO taxi;
BEGIN;

CREATE TEMP TABLE demo_customers ON COMMIT DROP AS SELECT id FROM customers WHERE phone LIKE '0399%';
CREATE TEMP TABLE demo_users ON COMMIT DROP AS
  SELECT id FROM users WHERE customer_id IN (SELECT id FROM demo_customers) OR (phone LIKE '0397%' AND role = 'dispatcher');
CREATE TEMP TABLE demo_drivers ON COMMIT DROP AS
  SELECT id FROM drivers WHERE phone LIKE '0398%' OR user_id IN (SELECT id FROM demo_users);

DO $chk$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM trips
   WHERE driver_id IN (SELECT id FROM demo_drivers) AND customer_id NOT IN (SELECT id FROM demo_customers);
  IF n > 0 THEN
    RAISE EXCEPTION 'Có % chuyến của khách thật đang gắn với tài xế demo - không xóa để tránh mất dữ liệu thật', n;
  END IF;
  SELECT count(*) INTO n FROM driver_applications
   WHERE reviewed_by IN (SELECT id FROM demo_users) AND user_id NOT IN (SELECT id FROM demo_users);
  IF n > 0 THEN
    RAISE EXCEPTION 'Có % hồ sơ tài xế thật do nhân viên demo duyệt - không xóa để tránh mất dữ liệu thật', n;
  END IF;
END
$chk$;

DELETE FROM trip_status_history WHERE trip_id IN (SELECT id FROM trips WHERE customer_id IN (SELECT id FROM demo_customers));
DELETE FROM trips WHERE customer_id IN (SELECT id FROM demo_customers);
DELETE FROM driver_applications WHERE user_id IN (SELECT id FROM demo_users);
DELETE FROM drivers WHERE id IN (SELECT id FROM demo_drivers);
-- Bản ghi phụ của tài khoản demo (phát sinh nếu đã đăng nhập / thao tác bằng tài khoản demo)
DELETE FROM audit_log WHERE user_id IN (SELECT id FROM demo_users);
DELETE FROM password_resets WHERE user_id IN (SELECT id FROM demo_users);
DELETE FROM sessions WHERE user_id IN (SELECT id FROM demo_users);
DELETE FROM users WHERE id IN (SELECT id FROM demo_users);
DELETE FROM customers WHERE id IN (SELECT id FROM demo_customers);

COMMIT;
SELECT (SELECT count(*) FROM customers) AS khach_hang, (SELECT count(*) FROM drivers) AS tai_xe,
       (SELECT count(*) FROM trips) AS chuyen_di, (SELECT count(*) FROM users) AS tai_khoan;
