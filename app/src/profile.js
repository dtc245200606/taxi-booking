// Hồ sơ cá nhân - dùng chung cho mọi vai trò (admin, dispatcher, customer).
//   GET   /api/profile                         thông tin tài khoản + cá nhân + phiên đăng nhập
//   PATCH /api/profile                         đổi họ tên / SĐT / email (SĐT, email cần mật khẩu hiện tại)
//   POST  /api/profile/sessions/:id/revoke     đăng xuất một thiết bị
//   POST  /api/profile/sessions/revoke-others  đăng xuất mọi thiết bị khác
// Khách hàng: SĐT/email lưu ở bảng customers; nhân viên: lưu ở bảng users.
const express = require('express');
const { pool, withTransaction } = require('./db');
const { audit } = require('./audit');
const {
  HttpError, wrap, requireText, requirePhone, requireEmail,
} = require('./validate');
const { requireAuth, verifyPassword, revokeSessions } = require('./auth');

const router = express.Router();
const SESSION_ID_LEN = 12; // chỉ đưa ra trình duyệt 12 ký tự đầu của hash phiên làm mã nhận diện

async function loadProfile(req) {
  const u = req.user;
  const { rows: [acc] } = await pool.query(
    `SELECT u.username, u.role, u.full_name, u.created_at, u.last_login_at, u.password_changed_at,
            COALESCE(c.phone, u.phone) AS phone, COALESCE(c.email, u.email) AS email
       FROM users u LEFT JOIN customers c ON c.id = u.customer_id
      WHERE u.id = $1`,
    [u.id],
  );
  const [sessions, driver] = await Promise.all([
    pool.query(
      `SELECT left(token_hash, ${SESSION_ID_LEN}) AS id, ip, user_agent, created_at, expires_at,
              token_hash = $2 AS current
         FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC`,
      [u.id, req.sessionHash],
    ),
    pool.query(
      'SELECT id, license_plate, vehicle_type, license_class, status, rating FROM drivers WHERE user_id = $1',
      [u.id],
    ),
  ]);
  return { ...acc, sessions: sessions.rows, driver: driver.rows[0] || null };
}

router.get('/profile', requireAuth, wrap(async (req, res) => {
  res.json(await loadProfile(req));
}));

router.patch('/profile', requireAuth, wrap(async (req, res) => {
  const u = req.user;
  const isCustomer = u.role === 'customer';
  const { rows: [cur] } = await pool.query(
    `SELECT u.full_name, u.password_hash, COALESCE(c.phone, u.phone) AS phone, COALESCE(c.email, u.email) AS email
       FROM users u LEFT JOIN customers c ON c.id = u.customer_id WHERE u.id = $1`,
    [u.id],
  );

  const next = {};
  if (req.body.full_name !== undefined) next.full_name = requireText(req.body.full_name, 'Họ tên', 100);
  if (req.body.phone !== undefined) {
    // Khách hàng bắt buộc có SĐT (dùng để liên lạc khi đặt xe); nhân viên có thể bỏ trống
    const empty = !String(req.body.phone).trim();
    if (empty && isCustomer) throw new HttpError(400, 'Khách hàng phải có số điện thoại để tài xế liên lạc');
    next.phone = empty ? null : requirePhone(req.body.phone);
  }
  if (req.body.email !== undefined) next.email = requireEmail(String(req.body.email).trim());

  const changed = Object.keys(next).filter((k) => (next[k] || null) !== (cur[k] || null));
  if (!changed.length) return res.json(await loadProfile(req));

  // Đổi SĐT / email (kênh liên lạc và lấy lại mật khẩu) phải xác nhận bằng mật khẩu hiện tại
  if (changed.includes('phone') || changed.includes('email')) {
    const pw = typeof req.body.current_password === 'string' ? req.body.current_password.slice(0, 128) : '';
    if (!pw) throw new HttpError(400, 'Nhập mật khẩu hiện tại để đổi số điện thoại hoặc email');
    if (!(await verifyPassword(pw, cur.password_hash))) {
      await audit(req, 'profile_update_failed', { detail: { fields: changed } });
      throw new HttpError(400, 'Mật khẩu hiện tại không đúng');
    }
  }

  await withTransaction(async (db) => {
    const val = (k) => (changed.includes(k) ? next[k] : cur[k]);
    await db.query('UPDATE users SET full_name = $1 WHERE id = $2', [val('full_name'), u.id]);
    if (isCustomer) {
      await db.query('UPDATE customers SET full_name = $1, phone = $2, email = $3 WHERE id = $4',
        [val('full_name'), val('phone'), val('email'), u.customer_id]);
      // Khách đã là tài xế đối tác -> đồng bộ họ tên, SĐT sang hồ sơ tài xế
      await db.query('UPDATE drivers SET full_name = $1, phone = $2 WHERE user_id = $3',
        [val('full_name'), val('phone'), u.id]);
    } else {
      await db.query('UPDATE users SET phone = $1, email = $2 WHERE id = $3', [val('phone'), val('email'), u.id]);
    }
    const detail = { fields: changed };
    if (changed.includes('full_name')) detail.full_name = { from: cur.full_name, to: next.full_name };
    await audit(req, 'profile_update', { detail, db });
  }).catch((err) => {
    if (err.code === '23505') throw new HttpError(409, 'Số điện thoại này đã được tài khoản khác sử dụng');
    throw err;
  });

  req.user.full_name = changed.includes('full_name') ? next.full_name : req.user.full_name;
  res.json(await loadProfile(req));
}));

router.post('/profile/sessions/revoke-others', requireAuth, wrap(async (req, res) => {
  const n = await revokeSessions(req.user.id, req.sessionHash);
  await audit(req, 'session_revoke_others', { detail: { revoked_sessions: n } });
  res.json({ revoked: n });
}));

router.post('/profile/sessions/:id/revoke', requireAuth, wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!new RegExp(`^[0-9a-f]{${SESSION_ID_LEN}}$`).test(id)) throw new HttpError(400, 'Mã phiên không hợp lệ');
  if (req.sessionHash.startsWith(id)) throw new HttpError(400, 'Đây là phiên hiện tại - hãy dùng nút Đăng xuất');
  const { rowCount } = await pool.query(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND left(token_hash, ${SESSION_ID_LEN}) = $2 AND revoked_at IS NULL`,
    [req.user.id, id],
  );
  if (!rowCount) throw new HttpError(404, 'Không tìm thấy phiên đăng nhập');
  await audit(req, 'session_revoke', { detail: { revoked_sessions: rowCount } });
  res.json({ revoked: rowCount });
}));

module.exports = { router };
