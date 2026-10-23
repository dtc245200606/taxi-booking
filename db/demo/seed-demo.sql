-- =============================================================
-- Dữ liệu demo (ảo) cho hệ thống Taxi Booking - chạy qua: sh scripts/seed-demo.sh
--   45 khách hàng (32 có tài khoản), 3 điều phối viên, 20 tài xế, ~650 chuyến đi trong 30 ngày,
--   vài chuyến đang diễn ra, 10 hồ sơ đăng ký làm tài xế.
-- Dấu nhận diện để xóa sạch (db/demo/remove-demo.sql):
--   SĐT khách 0399xxxxxx, tài xế 0398xxxxxx, nhân viên 0397xxxxxx; email @example.com
-- Biến psql cần truyền: pw_hash (mật khẩu demo đã băm scrypt, do app sinh)
-- =============================================================
\set ON_ERROR_STOP on
SET search_path TO taxi;
\o /dev/null
SELECT set_config('demo.pw_hash', :'pw_hash', false);
\o

-- Hàm tạm (chỉ tồn tại trong phiên này)
CREATE FUNCTION pg_temp.pick(a text[]) RETURNS text LANGUAGE sql VOLATILE AS
$f$ SELECT a[1 + floor(random() * array_length(a, 1))::int] $f$;
CREATE FUNCTION pg_temp.pick_int(a int[]) RETURNS int LANGUAGE sql VOLATILE AS
$f$ SELECT a[1 + floor(random() * array_length(a, 1))::int] $f$;
-- Bỏ dấu tiếng Việt để tạo tên đăng nhập: "Nguyễn" -> "nguyen"
CREATE FUNCTION pg_temp.unaccent_vn(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT translate(lower(s),
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    repeat('a', 17) || repeat('e', 11) || repeat('i', 5) || repeat('o', 17) || repeat('u', 11) || repeat('y', 5) || 'd')
$f$;
CREATE FUNCTION pg_temp.vn_name(female boolean) RETURNS text LANGUAGE sql VOLATILE AS $f$
  SELECT pg_temp.pick(ARRAY['Nguyễn','Trần','Lê','Phạm','Hoàng','Huỳnh','Phan','Vũ','Võ','Đặng','Bùi','Đỗ',
                            'Hồ','Ngô','Dương','Lý','Đinh','Mai','Trịnh','Lương'])
    || ' ' || CASE WHEN female
         THEN pg_temp.pick(ARRAY['Thị','Ngọc','Thu','Thanh','Minh','Phương','Hồng','Kim','Bảo','Diệu'])
         ELSE pg_temp.pick(ARRAY['Văn','Đức','Minh','Quốc','Hữu','Thành','Xuân','Hoàng','Gia','Công']) END
    || ' ' || CASE WHEN female
         THEN pg_temp.pick(ARRAY['Anh','Chi','Dung','Giang','Hà','Hạnh','Hoa','Hương','Lan','Linh','Mai','My',
                                 'Ngân','Nhung','Oanh','Phương','Quỳnh','Thảo','Trang','Uyên','Vân','Yến'])
         ELSE pg_temp.pick(ARRAY['An','Bình','Cường','Dũng','Hải','Hiếu','Hùng','Huy','Khánh','Long','Mạnh','Nam',
                                 'Phong','Quân','Sơn','Tài','Thắng','Toàn','Trung','Tuấn','Việt','Vinh']) END
$f$;
-- Địa điểm ở TP Thái Nguyên: điểm quen thuộc hoặc số nhà + tên đường
CREATE FUNCTION pg_temp.vn_place() RETURNS text LANGUAGE sql VOLATILE AS $f$
  SELECT CASE WHEN random() < 0.55 THEN pg_temp.pick(ARRAY[
      'ĐH Công nghệ Thông tin & TT, Z115', 'ĐH Sư phạm Thái Nguyên', 'ĐH Kỹ thuật Công nghiệp',
      'ĐH Nông Lâm Thái Nguyên', 'ĐH Y Dược Thái Nguyên', 'Ga Thái Nguyên', 'Bến xe khách Thái Nguyên',
      'Chợ Thái', 'Bệnh viện Trung ương Thái Nguyên', 'Bệnh viện A Thái Nguyên', 'Quảng trường 20/8',
      'Bảo tàng Văn hóa các dân tộc Việt Nam', 'Vincom Plaza Thái Nguyên', 'Hồ Núi Cốc', 'Đồi chè Tân Cương',
      'Khu công nghiệp Yên Bình', 'Khu công nghiệp Sông Công', 'TP Sông Công', 'TX Phổ Yên',
      'Sân vận động Thái Nguyên', 'Cầu Gia Bẩy', 'Phường Túc Duyên', 'Phường Tân Thịnh', 'Phường Gia Sàng'])
    ELSE (1 + floor(random() * 450))::int || ' ' || pg_temp.pick(ARRAY[
      'Lương Ngọc Quyến', 'Hoàng Văn Thụ', 'Quang Trung', 'Bắc Kạn', 'Cách Mạng Tháng Tám', 'Phan Đình Phùng',
      'Minh Cầu', 'Đội Cấn', 'Thống Nhất', 'Dương Tự Minh', 'Việt Bắc', 'Tân Thịnh']) || ', TP Thái Nguyên'
  END
$f$;

DO $demo$
DECLARE
  pw text := current_setting('demo.pw_hash');
  terms jsonb := '[{"id":"contract","title":"Hợp đồng hợp tác vận chuyển hành khách"},
                   {"id":"traffic_law","title":"Chấp hành pháp luật giao thông"},
                   {"id":"vehicle","title":"Điều kiện phương tiện"},
                   {"id":"conduct","title":"Quy tắc ứng xử và chất lượng dịch vụ"},
                   {"id":"fare","title":"Chính sách giá cước và chiết khấu"},
                   {"id":"privacy","title":"Bảo vệ dữ liệu cá nhân"},
                   {"id":"truthful","title":"Cam kết thông tin trung thực"}]';
  reasons text[] := ARRAY['Khách đổi ý', 'Khách đặt nhầm điểm đón', 'Tài xế báo kẹt xe, đến trễ',
                          'Không liên lạc được với khách', 'Khách thay đổi lịch trình'];
  hours int[] := ARRAY[6,7,7,7,8,8,8,9,9,10,11,11,12,12,13,14,15,16,16,17,17,17,18,18,18,19,19,20,21,22];
  cust_ids int[] := '{}';
  cust_created timestamptz[] := '{}';  -- ngày đăng ký của từng khách (song song với cust_ids)
  k int;
  acct_uids int[] := '{}';
  bike_ids int[] := '{}';
  car4_ids int[] := '{}';
  car7_ids int[] := '{}';
  reviewer int;
  i int; d int; n int; j int;
  female boolean; v_name text; v_user text; v_email text; v_created timestamptz;
  cid int; uid int; did int; tid int; drv int; drv_name text;
  vt text; km numeric; base int; per int; fare int; r float;
  v_from text; v_to text; reason text; v_status text; v_plate text; v_class text;
  t_req timestamptz; t_asg timestamptz; t_sta timestamptz; t_end timestamptz;
  issued date; trips_made int := 0;
  -- Mốc 0h hôm nay theo giờ Việt Nam (CSDL chạy giờ UTC)
  day0 timestamptz := date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
BEGIN
  PERFORM setseed(0.2026);
  IF EXISTS (SELECT 1 FROM customers WHERE phone LIKE '0399%') THEN
    RAISE EXCEPTION 'Dữ liệu demo đã tồn tại. Chạy: sh scripts/seed-demo.sh --reset để tạo lại';
  END IF;

  -- ---------- Khách hàng (32 người đầu có tài khoản) ----------
  FOR i IN 1..45 LOOP
    female := random() < 0.5;
    v_name := pg_temp.vn_name(female);
    v_user := pg_temp.unaccent_vn(split_part(v_name, ' ', 3)) || '.' || pg_temp.unaccent_vn(split_part(v_name, ' ', 1))
              || lpad(i::text, 2, '0');
    v_email := CASE WHEN random() < 0.7 THEN v_user || '@example.com' END;
    -- Khách đăng ký rải trong 90 ngày (1/3 trong 30 ngày gần đây) -> biểu đồ khách mới có dữ liệu
    v_created := now() - (CASE WHEN i <= 15 THEN 40 + random() * 50 ELSE 2 + random() * 88 END) * interval '1 day';
    INSERT INTO customers (full_name, phone, email, created_at)
    VALUES (v_name, '0399' || lpad(i::text, 6, '0'), v_email, v_created) RETURNING id INTO cid;
    cust_ids := cust_ids || cid;
    cust_created := cust_created || v_created;
    IF i <= 32 THEN
      INSERT INTO users (username, password_hash, full_name, role, customer_id, created_at, last_login_at, password_changed_at)
      VALUES (v_user, pw, v_name, 'customer', cid, v_created, greatest(v_created, now() - random() * interval '12 days'), v_created)
      RETURNING id INTO uid;
      acct_uids := acct_uids || uid;
    END IF;
  END LOOP;

  -- ---------- Điều phối viên (dieuphoi03 bị khóa để demo chức năng khóa tài khoản) ----------
  FOR i IN 1..3 LOOP
    v_name := pg_temp.vn_name(i = 2);
    INSERT INTO users (username, password_hash, full_name, role, phone, email, is_active,
                       created_at, last_login_at, password_changed_at)
    VALUES ('dieuphoi0' || i, pw, v_name, 'dispatcher', '0397' || lpad(i::text, 6, '0'), 'dieuphoi0' || i || '@example.com',
            i <> 3, now() - interval '80 days', now() - random() * interval '3 days', now() - interval '80 days')
    ON CONFLICT (username) DO NOTHING;
  END LOOP;
  SELECT id INTO reviewer FROM users WHERE username = 'dieuphoi01';

  -- ---------- Tài xế: 8 xe máy, 8 ô tô 4 chỗ, 4 ô tô 7 chỗ ----------
  FOR i IN 1..20 LOOP
    vt := CASE WHEN i <= 8 THEN 'bike' WHEN i <= 16 THEN 'car4' ELSE 'car7' END;
    issued := (now() - (1 + random() * 8) * interval '1 year')::date;
    IF vt = 'bike' THEN
      v_plate := '20-B' || (1 + i % 9) || ' ' || lpad((100 + (i * 37) % 900)::text, 3, '0') || '.' || lpad(((i * 53) % 100)::text, 2, '0');
      v_class := pg_temp.pick(ARRAY['A1', 'A1', 'A']);
    ELSE
      v_plate := '20A-' || lpad((200 + (i * 41) % 800)::text, 3, '0') || '.' || lpad(((i * 29) % 100)::text, 2, '0');
      v_class := pg_temp.pick(ARRAY['B', 'B', 'B2', 'C1']);
    END IF;
    INSERT INTO drivers (full_name, phone, license_plate, vehicle_type, status, rating, created_at,
                         license_number, license_class, license_expires_on)
    VALUES (pg_temp.vn_name(random() < 0.1), '0398' || lpad(i::text, 6, '0'), v_plate, vt,
            CASE WHEN random() < 0.72 THEN 'available' ELSE 'offline' END,
            round((4.3 + random() * 0.7)::numeric, 1), now() - (40 + random() * 50) * interval '1 day',
            lpad(floor(random() * 1e12)::bigint::text, 12, '0'), v_class,
            CASE WHEN vt = 'bike' THEN NULL ELSE issued + interval '10 years' END)
    RETURNING id INTO did;
    IF vt = 'bike' THEN bike_ids := bike_ids || did;
    ELSIF vt = 'car4' THEN car4_ids := car4_ids || did;
    ELSE car7_ids := car7_ids || did; END IF;
  END LOOP;

  -- ---------- Chuyến đi đã kết thúc: 29 ngày trước + phần đã qua của hôm nay ----------
  FOR d IN REVERSE 29..0 LOOP
    IF d > 0 THEN
      n := 14 + floor(random() * 12)::int + CASE WHEN extract(dow FROM (day0 - d * interval '1 day') AT TIME ZONE 'Asia/Ho_Chi_Minh') IN (0, 6) THEN 6 ELSE 0 END;
    ELSE
      n := CASE WHEN now() - day0 > interval '3 hours'
                THEN greatest(1, floor(extract(epoch FROM now() - day0) / 3600 * 0.9)::int) ELSE 0 END;
    END IF;
    FOR j IN 1..n LOOP
      IF d > 0 THEN
        t_req := day0 - d * interval '1 day'
                 + make_interval(hours => pg_temp.pick_int(hours), mins => floor(random() * 60)::int, secs => floor(random() * 60)::int);
      ELSE
        t_req := day0 + random() * (now() - day0 - interval '2 hours');
      END IF;
      r := random();
      vt := CASE WHEN r < 0.45 THEN 'bike' WHEN r < 0.85 THEN 'car4' ELSE 'car7' END;
      km := round((CASE WHEN vt = 'bike' THEN 1.5 + random() * 10 ELSE 2 + random() * 24 END)::numeric, 1);
      base := CASE vt WHEN 'bike' THEN 10000 WHEN 'car4' THEN 20000 ELSE 25000 END;
      per := CASE vt WHEN 'bike' THEN 5000 WHEN 'car4' THEN 12000 ELSE 15000 END;
      fare := (round((base + per * km) / 1000.0) * 1000)::int;
      v_from := pg_temp.vn_place();
      LOOP v_to := pg_temp.vn_place(); EXIT WHEN v_to <> v_from; END LOOP;
      -- Chỉ chọn khách đã đăng ký trước thời điểm đặt chuyến
      LOOP k := 1 + floor(random() * array_length(cust_ids, 1))::int; EXIT WHEN cust_created[k] < t_req - interval '1 hour'; END LOOP;
      cid := cust_ids[k];
      drv := pg_temp.pick_int(CASE vt WHEN 'bike' THEN bike_ids WHEN 'car4' THEN car4_ids ELSE car7_ids END);
      SELECT full_name INTO drv_name FROM drivers WHERE id = drv;
      t_asg := t_req + (1 + random() * 5) * interval '1 minute';
      r := random();

      IF r < 0.86 THEN            -- hoàn thành
        t_sta := t_asg + (3 + random() * 10) * interval '1 minute';
        t_end := t_sta + (km * 2.2 + random() * 8) * interval '1 minute';
        INSERT INTO trips (customer_id, driver_id, pickup_address, dropoff_address, vehicle_type, distance_km, fare,
                           status, requested_at, assigned_at, started_at, completed_at)
        VALUES (cid, drv, v_from, v_to, vt, km, fare, 'completed', t_req, t_asg, t_sta, t_end) RETURNING id INTO tid;
        INSERT INTO trip_status_history (trip_id, from_status, to_status, note, changed_at) VALUES
          (tid, NULL, 'requested', 'Khách đặt xe', t_req),
          (tid, 'requested', 'assigned', 'Giao cho tài xế ' || drv_name, t_asg),
          (tid, 'assigned', 'in_progress', NULL, t_sta),
          (tid, 'in_progress', 'completed', NULL, t_end);
      ELSIF r < 0.93 THEN         -- hủy khi chưa có tài xế
        reason := pg_temp.pick(reasons);
        t_end := t_req + (2 + random() * 8) * interval '1 minute';
        INSERT INTO trips (customer_id, pickup_address, dropoff_address, vehicle_type, distance_km, fare,
                           status, cancel_reason, requested_at, cancelled_at)
        VALUES (cid, v_from, v_to, vt, km, fare, 'cancelled', reason, t_req, t_end) RETURNING id INTO tid;
        INSERT INTO trip_status_history (trip_id, from_status, to_status, note, changed_at) VALUES
          (tid, NULL, 'requested', 'Khách đặt xe', t_req),
          (tid, 'requested', 'cancelled', reason, t_end);
      ELSE                        -- hủy sau khi đã giao tài xế
        reason := pg_temp.pick(reasons);
        t_end := t_asg + (2 + random() * 10) * interval '1 minute';
        INSERT INTO trips (customer_id, driver_id, pickup_address, dropoff_address, vehicle_type, distance_km, fare,
                           status, cancel_reason, requested_at, assigned_at, cancelled_at)
        VALUES (cid, drv, v_from, v_to, vt, km, fare, 'cancelled', reason, t_req, t_asg, t_end) RETURNING id INTO tid;
        INSERT INTO trip_status_history (trip_id, from_status, to_status, note, changed_at) VALUES
          (tid, NULL, 'requested', 'Khách đặt xe', t_req),
          (tid, 'requested', 'assigned', 'Giao cho tài xế ' || drv_name, t_asg),
          (tid, 'assigned', 'cancelled', reason, t_end);
      END IF;
      trips_made := trips_made + 1;
    END LOOP;
  END LOOP;

  -- ---------- Chuyến đang diễn ra ngay lúc này: 6 chờ tài xế, 4 đã nhận, 3 đang chạy ----------
  FOR j IN 1..13 LOOP
    v_status := CASE WHEN j <= 6 THEN 'requested' WHEN j <= 10 THEN 'assigned' ELSE 'in_progress' END;
    r := random();
    vt := CASE WHEN r < 0.45 THEN 'bike' WHEN r < 0.85 THEN 'car4' ELSE 'car7' END;
    km := round((CASE WHEN vt = 'bike' THEN 1.5 + random() * 10 ELSE 2 + random() * 20 END)::numeric, 1);
    base := CASE vt WHEN 'bike' THEN 10000 WHEN 'car4' THEN 20000 ELSE 25000 END;
    per := CASE vt WHEN 'bike' THEN 5000 WHEN 'car4' THEN 12000 ELSE 15000 END;
    fare := (round((base + per * km) / 1000.0) * 1000)::int;
    v_from := pg_temp.vn_place();
    LOOP v_to := pg_temp.vn_place(); EXIT WHEN v_to <> v_from; END LOOP;
    LOOP k := 1 + floor(random() * array_length(cust_ids, 1))::int; EXIT WHEN cust_created[k] < t_req - interval '1 hour'; END LOOP;
    cid := cust_ids[k];
    t_req := now() - CASE v_status WHEN 'requested' THEN random() * 12 WHEN 'assigned' THEN 12 + random() * 8
                                   ELSE 22 + random() * 15 END * interval '1 minute';
    drv := NULL;
    IF v_status <> 'requested' THEN
      SELECT id, full_name INTO drv, drv_name FROM drivers
       WHERE status = 'available' AND vehicle_type = vt AND phone LIKE '0398%' ORDER BY random() LIMIT 1;
      IF drv IS NULL THEN v_status := 'requested'; END IF; -- hết tài xế rảnh cùng loại -> để chờ
    END IF;
    t_asg := t_req + (1 + random() * 3) * interval '1 minute';
    t_sta := t_asg + (3 + random() * 5) * interval '1 minute';
    INSERT INTO trips (customer_id, driver_id, pickup_address, dropoff_address, vehicle_type, distance_km, fare,
                       status, requested_at, assigned_at, started_at)
    VALUES (cid, drv, v_from, v_to, vt, km, fare, v_status, t_req,
            CASE WHEN v_status <> 'requested' THEN t_asg END, CASE WHEN v_status = 'in_progress' THEN t_sta END)
    RETURNING id INTO tid;
    INSERT INTO trip_status_history (trip_id, from_status, to_status, note, changed_at)
    VALUES (tid, NULL, 'requested', 'Khách đặt xe', t_req);
    IF v_status <> 'requested' THEN
      INSERT INTO trip_status_history (trip_id, from_status, to_status, note, changed_at)
      VALUES (tid, 'requested', 'assigned', 'Giao cho tài xế ' || drv_name, t_asg);
      UPDATE drivers SET status = 'on_trip' WHERE id = drv;
    END IF;
    IF v_status = 'in_progress' THEN
      INSERT INTO trip_status_history (trip_id, from_status, to_status, note, changed_at)
      VALUES (tid, 'assigned', 'in_progress', NULL, t_sta);
    END IF;
    trips_made := trips_made + 1;
  END LOOP;

  -- ---------- Hồ sơ đăng ký làm tài xế: 3 đã duyệt, 4 chờ duyệt, 2 từ chối, 1 đã rút ----------
  FOR i IN 1..10 LOOP
    uid := acct_uids[i];
    SELECT c.id, c.full_name, c.phone, c.created_at INTO cid, v_name, v_user, v_created
      FROM users u JOIN customers c ON c.id = u.customer_id WHERE u.id = uid;
    v_status := CASE WHEN i <= 3 THEN 'approved' WHEN i <= 7 THEN 'pending' WHEN i <= 9 THEN 'rejected' ELSE 'cancelled' END;
    vt := CASE WHEN i % 3 = 0 THEN 'bike' WHEN i % 3 = 1 THEN 'car4' ELSE 'car7' END;
    IF vt = 'bike' THEN
      v_plate := '20-B5 ' || lpad((900 + i)::text, 3, '0') || '.' || lpad((i * 7)::text, 2, '0');
      v_class := 'A1';
    ELSE
      v_plate := '20A-' || lpad((900 + i)::text, 3, '0') || '.' || lpad((i * 7)::text, 2, '0');
      v_class := 'B';
    END IF;
    issued := (now() - (1 + random() * 6) * interval '1 year')::date;
    t_req := now() - (CASE WHEN v_status = 'pending' THEN random() * 3 ELSE 4 + random() * 8 END) * interval '1 day';
    t_req := greatest(t_req, v_created + interval '2 hours');  -- nộp hồ sơ sau khi đã có tài khoản
    did := NULL;
    IF v_status = 'approved' THEN
      INSERT INTO drivers (full_name, phone, license_plate, vehicle_type, status, user_id,
                           license_number, license_class, license_expires_on, created_at)
      VALUES (v_name, v_user, v_plate, vt, 'offline', uid, lpad(floor(random() * 1e12)::bigint::text, 12, '0'), v_class,
              CASE WHEN vt = 'bike' THEN NULL ELSE issued + interval '10 years' END, t_req + interval '1 day')
      RETURNING id INTO did;
    END IF;
    INSERT INTO driver_applications
      (user_id, customer_id, full_name, phone, date_of_birth, national_id, vehicle_type, license_plate, vehicle_model,
       license_number, license_class, license_issued_on, license_expires_on, terms_version, terms_accepted,
       terms_accepted_at, terms_ip, status, review_note, reviewed_by, reviewed_at, driver_id, created_at)
    VALUES
      (uid, cid, v_name, v_user,
       (now() - (21 + random() * 25) * interval '1 year')::date,
       '019' || (CASE WHEN random() < 0.5 THEN '0' ELSE '1' END) || lpad(floor(random() * 1e8)::bigint::text, 8, '0'),
       vt, v_plate,
       CASE vt WHEN 'bike' THEN pg_temp.pick(ARRAY['Honda Wave Alpha', 'Honda Vision', 'Yamaha Sirius', 'Honda Air Blade'])
               WHEN 'car4' THEN pg_temp.pick(ARRAY['Toyota Vios', 'Hyundai Accent', 'Kia Morning', 'VinFast VF 5'])
               ELSE pg_temp.pick(ARRAY['Toyota Innova', 'Mitsubishi Xpander', 'Kia Carens']) END
         || ' ' || (2016 + floor(random() * 9))::int || ', ' || pg_temp.pick(ARRAY['trắng', 'đen', 'bạc', 'đỏ', 'xanh']),
       lpad(floor(random() * 1e12)::bigint::text, 12, '0'), v_class, issued,
       CASE WHEN vt = 'bike' THEN NULL ELSE issued + interval '10 years' END,
       '2026-10', terms, t_req, '172.28.10.1', v_status,
       CASE v_status WHEN 'rejected' THEN pg_temp.pick(ARRAY[
              'Số GPLX không khớp với giấy phép bản gốc, vui lòng kiểm tra lại',
              'Xe chưa có giấy chứng nhận kiểm định còn hiệu lực'])
                     WHEN 'approved' THEN 'Đã đối chiếu giấy tờ gốc và ký hợp đồng' END,
       CASE WHEN v_status IN ('approved', 'rejected') THEN reviewer END,
       CASE WHEN v_status IN ('approved', 'rejected') THEN t_req + interval '1 day' END,
       did, t_req);
  END LOOP;

  RAISE NOTICE 'Đã tạo: 45 khách hàng (32 tài khoản), 3 điều phối viên, 23 tài xế, % chuyến đi, 10 hồ sơ tài xế', trips_made;
END
$demo$;

SELECT status, count(*) AS so_chuyen FROM trips GROUP BY status ORDER BY status;
