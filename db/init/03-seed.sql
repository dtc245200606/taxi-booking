-- Dữ liệu mẫu phục vụ demo
SET search_path TO taxi;

INSERT INTO customers (full_name, phone, email) VALUES
  ('Nguyễn Văn An',   '0912345678', 'an.nguyen@example.com'),
  ('Trần Thị Bình',   '0987654321', 'binh.tran@example.com'),
  ('Lê Hoàng Cường',  '0905111222', NULL),
  ('Phạm Minh Dũng',  '0934555666', 'dung.pham@example.com'),
  ('Hoàng Thu Hà',    '0978123123', 'ha.hoang@example.com');

INSERT INTO drivers (full_name, phone, license_plate, vehicle_type, status, rating) VALUES
  ('Đỗ Văn Hùng',     '0961000001', '20A-123.45', 'car4', 'available', 4.9),
  ('Vũ Quốc Khánh',   '0961000002', '20A-678.90', 'car4', 'available', 4.7),
  ('Bùi Thanh Long',  '0961000003', '20B-246.80', 'car7', 'available', 4.8),
  ('Ngô Đức Minh',    '0961000004', '20-B1 135.79', 'bike', 'available', 4.6),
  ('Đặng Văn Nam',    '0961000005', '20-B2 975.31', 'bike', 'offline',   4.5);

-- Một vài chuyến đi ở các trạng thái khác nhau
INSERT INTO trips (customer_id, driver_id, pickup_address, dropoff_address, vehicle_type,
                   distance_km, fare, status, requested_at, assigned_at, started_at, completed_at)
VALUES
  (1, 1, 'ĐH Công nghệ Thông tin & TT, Z115', 'Ga Thái Nguyên', 'car4', 6.5, 98000, 'completed',
   now() - interval '3 hour', now() - interval '175 minute', now() - interval '170 minute', now() - interval '150 minute'),
  (2, 4, 'Chợ Thái', 'Hồ Núi Cốc', 'bike', 15.0, 85000, 'completed',
   now() - interval '2 hour', now() - interval '118 minute', now() - interval '115 minute', now() - interval '80 minute');

INSERT INTO trips (customer_id, pickup_address, dropoff_address, vehicle_type, distance_km, fare, status, requested_at)
VALUES
  (3, 'Bệnh viện Trung ương Thái Nguyên', 'Quảng trường 20/8', 'car7', 3.2, 73000, 'requested', now() - interval '5 minute'),
  (4, 'ĐH Sư phạm Thái Nguyên', 'Phường Túc Duyên', 'car4', 4.0, 68000, 'requested', now() - interval '2 minute');

INSERT INTO trip_status_history (trip_id, from_status, to_status, note, changed_at) VALUES
  (1, NULL, 'requested', 'Khách đặt xe', now() - interval '3 hour'),
  (1, 'requested', 'assigned', 'Giao cho tài xế Đỗ Văn Hùng', now() - interval '175 minute'),
  (1, 'assigned', 'in_progress', NULL, now() - interval '170 minute'),
  (1, 'in_progress', 'completed', NULL, now() - interval '150 minute'),
  (2, NULL, 'requested', 'Khách đặt xe', now() - interval '2 hour'),
  (2, 'requested', 'assigned', 'Giao cho tài xế Ngô Đức Minh', now() - interval '118 minute'),
  (2, 'assigned', 'in_progress', NULL, now() - interval '115 minute'),
  (2, 'in_progress', 'completed', NULL, now() - interval '80 minute'),
  (3, NULL, 'requested', 'Khách đặt xe', now() - interval '5 minute'),
  (4, NULL, 'requested', 'Khách đặt xe', now() - interval '2 minute');
