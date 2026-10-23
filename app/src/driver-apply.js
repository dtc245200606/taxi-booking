// Khách hàng đăng ký làm tài xế đối tác + nhân viên xét duyệt hồ sơ.
//   Khách:     GET  /api/driver-application/terms | /me,  POST /api/driver-application, POST .../cancel
//   Nhân viên: GET  /api/driver-applications,  POST /api/driver-applications/:id/{approve|reject}
const express = require('express');
const { pool, withTransaction } = require('./db');
const { audit } = require('./audit');
const {
  HttpError, wrap, requireText, requireId, requireEnum,
} = require('./validate');
const { requireRole, STAFF_ROLES } = require('./auth');

const router = express.Router();
const customerOnly = requireRole('customer');
const staffOnly = requireRole(...STAFF_ROLES);

// ---------- Điều khoản hợp đồng (đổi nội dung => tăng TERMS_VERSION) ----------
const TERMS_VERSION = '2026-10';
const TERMS = [
  {
    id: 'contract',
    title: 'Hợp đồng hợp tác vận chuyển hành khách',
    body: 'Tài xế là đối tác hợp tác (không phải nhân viên), tự chịu trách nhiệm về phương tiện, chi phí vận hành '
      + 'và nghĩa vụ thuế theo quy định. Hai bên có thể chấm dứt hợp tác khi một bên vi phạm điều khoản.',
  },
  {
    id: 'traffic_law',
    title: 'Chấp hành pháp luật giao thông',
    body: 'Tuân thủ Luật Trật tự, an toàn giao thông đường bộ; tuyệt đối không điều khiển phương tiện khi trong '
      + 'máu hoặc hơi thở có nồng độ cồn, chất ma túy; không sử dụng điện thoại khi đang lái xe.',
  },
  {
    id: 'vehicle',
    title: 'Điều kiện phương tiện',
    body: 'Phương tiện chính chủ hoặc có giấy ủy quyền hợp lệ; có giấy đăng ký xe, giấy chứng nhận kiểm định còn '
      + 'hiệu lực (đối với ô tô) và bảo hiểm bắt buộc trách nhiệm dân sự còn hiệu lực.',
  },
  {
    id: 'conduct',
    title: 'Quy tắc ứng xử và chất lượng dịch vụ',
    body: 'Lịch sự với hành khách, đón đúng giờ, đúng điểm; không từ chối chuyến vô lý; giữ xe sạch sẽ; không thu '
      + 'thêm tiền ngoài giá cước hiển thị. Điểm đánh giá thấp kéo dài có thể bị tạm ngưng hợp tác.',
  },
  {
    id: 'fare',
    title: 'Chính sách giá cước và chiết khấu',
    body: 'Giá cước do hệ thống tính theo loại xe và quãng đường; tài xế đồng ý mức chiết khấu dịch vụ trên mỗi '
      + 'chuyến theo bảng phí công bố tại thời điểm hợp tác.',
  },
  {
    id: 'privacy',
    title: 'Bảo vệ dữ liệu cá nhân',
    body: 'Đồng ý cho hệ thống thu thập, xử lý thông tin cá nhân (CCCD, GPLX, phương tiện) để xét duyệt và quản lý '
      + 'hợp tác theo Nghị định 13/2023/NĐ-CP; cam kết bảo mật thông tin của hành khách.',
  },
  {
    id: 'truthful',
    title: 'Cam kết thông tin trung thực',
    body: 'Thông tin khai báo là chính xác, giấy tờ là thật và còn hiệu lực. Khai báo sai sự thật, hồ sơ sẽ bị từ '
      + 'chối hoặc chấm dứt hợp tác và người khai chịu trách nhiệm trước pháp luật.',
  },
];

// ---------- Hạng GPLX theo loại xe ----------
// Luật TTATGT đường bộ 2024: A1 (xe máy đến 125 cm³), A (trên 125 cm³), B (ô tô chở người đến 8 chỗ không kể
// chỗ người lái); các hạng C1, C, D1, D2, D cũng được lái xe hạng B. GPLX mẫu cũ còn hạn vẫn được dùng:
// A2 (xe máy), B2/E (ô tô). B1 mẫu cũ (số tự động, không hành nghề lái xe) không được kinh doanh vận tải -> không nhận.
const LICENSE_CLASSES = {
  bike: ['A1', 'A', 'A2'],
  car: ['B', 'C1', 'C', 'D1', 'D2', 'D', 'B2', 'E'],
};
const NO_EXPIRY_CLASSES = ['A1', 'A', 'A2']; // GPLX xe máy không thời hạn
const MIN_AGE = 18;

const vehicleCategory = (type) => (type === 'bike' ? 'bike' : 'car');

function requireDate(value, field) {
  const v = requireText(value, field, 10);
  const d = new Date(`${v}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, `${field} không hợp lệ (YYYY-MM-DD)`);
  }
  return v;
}

const today = () => new Date().toISOString().slice(0, 10);

function ageOn(dob, on) {
  const [y, m, d] = dob.split('-').map(Number);
  const [ty, tm, td] = on.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

function validateApplication(body) {
  const now = today();
  const dob = requireDate(body.date_of_birth, 'Ngày sinh');
  const age = ageOn(dob, now);
  if (age < MIN_AGE) throw new HttpError(400, `Bạn phải đủ ${MIN_AGE} tuổi để đăng ký làm tài xế`);
  if (age > 100) throw new HttpError(400, 'Ngày sinh không hợp lệ');

  const nationalId = requireText(body.national_id, 'Số CCCD', 12);
  if (!/^\d{12}$/.test(nationalId)) throw new HttpError(400, 'Số CCCD phải gồm đúng 12 chữ số');

  const vehicleType = requireEnum(body.vehicle_type, ['bike', 'car4', 'car7'], 'Loại xe');
  const plate = requireText(body.license_plate, 'Biển số xe', 20).toUpperCase();
  if (!/^[0-9]{2}[A-Z0-9-]{1,4}[ .-]?[0-9]{3}\.?[0-9]{2}$/.test(plate.replace(/\s+/g, ' '))) {
    throw new HttpError(400, 'Biển số xe không hợp lệ (vd: 20A-123.45 hoặc 20-B1 135.79)');
  }
  const vehicleModel = requireText(body.vehicle_model, 'Hãng / dòng xe', 60);

  const licenseClass = requireText(body.license_class, 'Hạng GPLX', 3).toUpperCase();
  const allowed = LICENSE_CLASSES[vehicleCategory(vehicleType)];
  if (!allowed.includes(licenseClass)) {
    throw new HttpError(400, `Hạng GPLX ${licenseClass} không được phép lái ${vehicleType === 'bike' ? 'xe máy' : 'ô tô'} `
      + `kinh doanh vận tải. Hạng hợp lệ: ${allowed.join(', ')}`);
  }
  const licenseNumber = requireText(body.license_number, 'Số GPLX', 15).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9]{6,15}$/.test(licenseNumber)) throw new HttpError(400, 'Số GPLX không hợp lệ (6-15 chữ/số)');

  const issued = requireDate(body.license_issued_on, 'Ngày cấp GPLX');
  if (issued > now) throw new HttpError(400, 'Ngày cấp GPLX không thể ở tương lai');
  if (ageOn(dob, issued) < MIN_AGE) throw new HttpError(400, 'Ngày cấp GPLX không hợp lệ so với ngày sinh');

  let expires = null;
  if (NO_EXPIRY_CLASSES.includes(licenseClass)) {
    if (body.license_expires_on) expires = requireDate(body.license_expires_on, 'Ngày hết hạn GPLX');
  } else {
    if (!body.license_expires_on) throw new HttpError(400, `GPLX hạng ${licenseClass} có thời hạn - vui lòng nhập ngày hết hạn`);
    expires = requireDate(body.license_expires_on, 'Ngày hết hạn GPLX');
  }
  if (expires && expires <= now) throw new HttpError(400, 'GPLX đã hết hạn - không thể đăng ký');
  if (expires && expires <= issued) throw new HttpError(400, 'Ngày hết hạn phải sau ngày cấp');

  // Phải đồng ý ĐỦ từng điều khoản của phiên bản hiện hành
  const accepted = Array.isArray(body.accepted_terms) ? body.accepted_terms : [];
  const missing = TERMS.filter((t) => !accepted.includes(t.id));
  if (body.terms_version !== TERMS_VERSION) throw new HttpError(409, 'Điều khoản đã được cập nhật, vui lòng tải lại trang');
  if (missing.length) throw new HttpError(400, `Bạn cần đồng ý điều khoản: ${missing.map((t) => t.title).join('; ')}`);

  return {
    dob, nationalId, vehicleType, plate, vehicleModel, licenseClass, licenseNumber, issued, expires,
  };
}

// ---------- API khách hàng ----------
router.get('/driver-application/terms', customerOnly, (req, res) => {
  res.json({
    version: TERMS_VERSION, terms: TERMS, license_classes: LICENSE_CLASSES, no_expiry: NO_EXPIRY_CLASSES, min_age: MIN_AGE,
  });
});

// Hồ sơ gần nhất của khách (kèm thông tin tài xế nếu đã được duyệt) + họ tên, SĐT từ hồ sơ khách hàng
router.get('/driver-application/me', customerOnly, wrap(async (req, res) => {
  const [app, profile] = await Promise.all([
    pool.query(
      `SELECT a.*, d.status AS driver_status, d.rating AS driver_rating
         FROM driver_applications a LEFT JOIN drivers d ON d.id = a.driver_id
        WHERE a.user_id = $1 ORDER BY a.id DESC LIMIT 1`,
      [req.user.id],
    ),
    pool.query('SELECT full_name, phone FROM customers WHERE id = $1', [req.user.customer_id]),
  ]);
  res.json({ profile: profile.rows[0], application: app.rows[0] || null });
}));

router.post('/driver-application', customerOnly, wrap(async (req, res) => {
  const v = validateApplication(req.body);

  const app = await withTransaction(async (db) => {
    const prev = await db.query(
      `SELECT status FROM driver_applications WHERE user_id = $1 AND status IN ('pending', 'approved') LIMIT 1`,
      [req.user.id],
    );
    if (prev.rows.length) {
      throw new HttpError(409, prev.rows[0].status === 'approved'
        ? 'Bạn đã là tài xế đối tác' : 'Bạn đã có hồ sơ đang chờ duyệt');
    }
    const { rows: [c] } = await db.query('SELECT full_name, phone FROM customers WHERE id = $1', [req.user.customer_id]);
    const dup = await db.query(
      'SELECT (SELECT 1 FROM drivers WHERE license_plate = $1) AS plate, (SELECT 1 FROM drivers WHERE phone = $2) AS phone',
      [v.plate, c.phone],
    );
    if (dup.rows[0].plate) throw new HttpError(409, 'Biển số xe này đã được đăng ký cho tài xế khác');
    if (dup.rows[0].phone) throw new HttpError(409, 'Số điện thoại của bạn đã được dùng cho một tài xế khác');

    const { rows } = await db.query(
      `INSERT INTO driver_applications
         (user_id, customer_id, full_name, phone, date_of_birth, national_id, vehicle_type, license_plate,
          vehicle_model, license_number, license_class, license_issued_on, license_expires_on,
          terms_version, terms_accepted, terms_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [req.user.id, req.user.customer_id, c.full_name, c.phone, v.dob, v.nationalId, v.vehicleType, v.plate,
        v.vehicleModel, v.licenseNumber, v.licenseClass, v.issued, v.expires,
        TERMS_VERSION, JSON.stringify(TERMS.map((t) => ({ id: t.id, title: t.title }))), req.ip],
    ).catch((err) => {
      if (err.code === '23505') throw new HttpError(409, 'Bạn đã có hồ sơ đang chờ duyệt');
      throw err;
    });
    await audit(req, 'driver_apply', {
      targetType: 'driver_application', targetId: rows[0].id,
      detail: { vehicle_type: v.vehicleType, license_class: v.licenseClass, license_plate: v.plate, terms_version: TERMS_VERSION },
      db,
    });
    return rows[0];
  });
  res.status(201).json(app);
}));

router.post('/driver-application/cancel', customerOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE driver_applications SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending' RETURNING id`,
    [req.user.id],
  );
  if (!rows.length) throw new HttpError(409, 'Không có hồ sơ nào đang chờ duyệt');
  await audit(req, 'driver_apply_cancel', { targetType: 'driver_application', targetId: rows[0].id });
  res.json({ ok: true });
}));

// ---------- API nhân viên: xét duyệt ----------
router.get('/driver-applications', staffOnly, wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.status) {
    params.push(requireEnum(req.query.status, ['pending', 'approved', 'rejected', 'cancelled'], 'status'));
    where = 'WHERE a.status = $1';
  }
  const { rows } = await pool.query(
    `SELECT a.*, r.username AS reviewer, c.email
       FROM driver_applications a
       JOIN customers c ON c.id = a.customer_id
       LEFT JOIN users r ON r.id = a.reviewed_by
       ${where}
      ORDER BY (a.status = 'pending') DESC, a.id DESC LIMIT 200`,
    params,
  );
  res.json(rows);
}));

async function lockPending(db, id) {
  const { rows } = await db.query('SELECT * FROM driver_applications WHERE id = $1 FOR UPDATE', [id]);
  if (!rows.length) throw new HttpError(404, 'Không tìm thấy hồ sơ');
  if (rows[0].status !== 'pending') throw new HttpError(409, 'Hồ sơ này đã được xử lý');
  return rows[0];
}

// Duyệt: tạo tài xế (trạng thái "Nghỉ" - điều phối viên bật nhận chuyến khi tài xế sẵn sàng)
router.post('/driver-applications/:id/approve', staffOnly, wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const result = await withTransaction(async (db) => {
    const a = await lockPending(db, id);
    if (a.license_expires_on && a.license_expires_on <= new Date()) {
      throw new HttpError(409, 'GPLX của hồ sơ đã hết hạn - không thể duyệt');
    }
    const { rows: [driver] } = await db.query(
      `INSERT INTO drivers (full_name, phone, license_plate, vehicle_type, status, user_id,
                            license_number, license_class, license_expires_on)
       VALUES ($1, $2, $3, $4, 'offline', $5, $6, $7, $8) RETURNING *`,
      [a.full_name, a.phone, a.license_plate, a.vehicle_type, a.user_id, a.license_number, a.license_class,
        a.license_expires_on],
    ).catch((err) => {
      if (err.code === '23505') throw new HttpError(409, 'Biển số, số điện thoại hoặc tài khoản này đã gắn với một tài xế khác');
      throw err;
    });
    const note = req.body.note ? requireText(req.body.note, 'Ghi chú', 300) : null;
    await db.query(
      `UPDATE driver_applications SET status = 'approved', reviewed_by = $1, reviewed_at = now(),
              review_note = $2, driver_id = $3 WHERE id = $4`,
      [req.user.id, note, driver.id, id],
    );
    await audit(req, 'driver_apply_approve', {
      targetType: 'driver_application', targetId: id,
      detail: { full_name: a.full_name, license_plate: a.license_plate, driverId: driver.id },
      db,
    });
    return driver;
  });
  res.json({ ok: true, driver: result });
}));

router.post('/driver-applications/:id/reject', staffOnly, wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const reason = requireText(req.body.reason, 'Lý do từ chối', 300);
  await withTransaction(async (db) => {
    const a = await lockPending(db, id);
    await db.query(
      `UPDATE driver_applications SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), review_note = $2
        WHERE id = $3`,
      [req.user.id, reason, id],
    );
    await audit(req, 'driver_apply_reject', {
      targetType: 'driver_application', targetId: id, detail: { full_name: a.full_name, reason }, db,
    });
  });
  res.json({ ok: true });
}));

module.exports = { router };
