// API quản trị (chỉ admin): quản lý tài khoản nhân viên điều phối + xem nhật ký hoạt động.
// Admin là tài khoản quản trị duy nhất (tạo từ .env), không nằm trong danh sách nhân viên
// và không thể tạo thêm / nâng quyền nhân viên lên admin qua giao diện.
const express = require('express');
const { pool, withTransaction } = require('./db');
const { audit } = require('./audit');
const {
  HttpError, wrap, requireText, requireId, requireEnum,
} = require('./validate');
const {
  requireRole, hashPassword, randomPassword, requireUsername, revokeSessions,
} = require('./auth');

const router = express.Router();
router.use(requireRole('admin'));

const STAFF_ROLE = 'dispatcher';
const STAFF_SELECT = `
  SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.must_change_password,
         u.created_at, u.last_login_at, u.password_changed_at,
         (SELECT COUNT(*)::int FROM sessions s
           WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
    FROM users u`;

// Khóa dòng nhân viên đích trong transaction (tránh 2 thao tác chồng nhau); chỉ nhận nhân viên điều phối
async function lockStaff(db, targetId) {
  const { rows } = await db.query(
    'SELECT * FROM users WHERE id = $1 AND role = $2 FOR UPDATE',
    [targetId, STAFF_ROLE],
  );
  if (!rows.length) throw new HttpError(404, 'Không tìm thấy nhân viên');
  return rows[0];
}

// ---------- Nhân viên ----------
router.get('/staff', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `${STAFF_SELECT} WHERE u.role = $1 ORDER BY u.is_active DESC, u.id`,
    [STAFF_ROLE],
  );
  res.json(rows);
}));

// Tạo nhân viên điều phối với mật khẩu tạm ngẫu nhiên (chỉ hiển thị 1 lần); bắt buộc đổi khi đăng nhập lần đầu
router.post('/staff', wrap(async (req, res) => {
  const username = requireUsername(req.body.username);
  const fullName = requireText(req.body.full_name, 'full_name', 100);
  const tempPassword = randomPassword();

  const staff = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, full_name, role, must_change_password)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [username, await hashPassword(tempPassword), fullName, STAFF_ROLE],
    ).catch((err) => {
      if (err.code === '23505') throw new HttpError(409, 'Tên đăng nhập đã được sử dụng');
      throw err;
    });
    await audit(req, 'staff_create', {
      targetType: 'user', targetId: rows[0].id, detail: { username, role: STAFF_ROLE }, db,
    });
    return (await db.query(`${STAFF_SELECT} WHERE u.id = $1`, [rows[0].id])).rows[0];
  });
  res.status(201).json({ ...staff, temp_password: tempPassword });
}));

// Sửa họ tên / khóa - mở khóa
router.patch('/staff/:id', wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const changes = {};
  if (req.body.full_name !== undefined) changes.full_name = requireText(req.body.full_name, 'full_name', 100);
  if (req.body.is_active !== undefined) {
    if (typeof req.body.is_active !== 'boolean') throw new HttpError(400, 'is_active phải là true/false');
    changes.is_active = req.body.is_active;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Không có thay đổi nào');

  const staff = await withTransaction(async (db) => {
    const before = await lockStaff(db, id);
    const sets = Object.keys(changes).map((k, i) => `${k} = $${i + 2}`); // tên cột lấy từ danh sách cố định ở trên
    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, [id, ...Object.values(changes)]);

    const diff = {};
    Object.entries(changes).forEach(([k, v]) => { if (before[k] !== v) diff[k] = { from: before[k], to: v }; });
    let revoked = 0;
    if (changes.is_active === false && before.is_active) revoked = await revokeSessions(id, null, db);

    let action = 'staff_update';
    if (diff.is_active) action = changes.is_active ? 'staff_unlock' : 'staff_lock';
    await audit(req, action, {
      targetType: 'user', targetId: id, detail: { username: before.username, ...diff, revoked_sessions: revoked }, db,
    });
    return (await db.query(`${STAFF_SELECT} WHERE u.id = $1`, [id])).rows[0];
  });
  res.json(staff);
}));

// Đặt lại mật khẩu: sinh mật khẩu tạm mới, đăng xuất mọi thiết bị, bắt buộc đổi khi đăng nhập
router.post('/staff/:id/reset-password', wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const tempPassword = randomPassword();

  await withTransaction(async (db) => {
    const target = await lockStaff(db, id);
    await db.query(
      `UPDATE users SET password_hash = $1, must_change_password = true, password_changed_at = now() WHERE id = $2`,
      [await hashPassword(tempPassword), id],
    );
    const revoked = await revokeSessions(id, null, db);
    await audit(req, 'staff_password_reset', {
      targetType: 'user', targetId: id, detail: { username: target.username, revoked_sessions: revoked }, db,
    });
  });
  res.json({ temp_password: tempPassword });
}));

// Đăng xuất nhân viên khỏi mọi thiết bị
router.post('/staff/:id/revoke-sessions', wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const revoked = await withTransaction(async (db) => {
    const target = await lockStaff(db, id);
    const n = await revokeSessions(id, null, db);
    await audit(req, 'staff_revoke_sessions', {
      targetType: 'user', targetId: id, detail: { username: target.username, revoked_sessions: n }, db,
    });
    return n;
  });
  res.json({ revoked });
}));

// ---------- Nhật ký hoạt động ----------
// Lọc theo nhóm hành động, tên đăng nhập, khoảng ngày; phân trang bằng before_id (id giảm dần)
const ACTION_GROUPS = {
  auth: ['login', 'login_failed', 'login_blocked', 'logout', 'register', 'password_change', 'password_change_failed',
    'password_reset_request', 'password_reset', 'profile_update', 'profile_update_failed',
    'session_revoke', 'session_revoke_others'],
  staff: ['staff_create', 'staff_update', 'staff_role_change', 'staff_lock', 'staff_unlock',
    'staff_password_reset', 'staff_revoke_sessions'],
  trip: ['trip_create', 'trip_assign', 'trip_start', 'trip_complete', 'trip_cancel'],
  data: ['driver_create', 'driver_status', 'customer_create',
    'driver_apply', 'driver_apply_cancel', 'driver_apply_approve', 'driver_apply_reject'],
};

router.get('/audit', wrap(async (req, res) => {
  const params = [];
  const conds = [];
  const add = (sql, value) => { params.push(value); conds.push(sql.replace('?', `$${params.length}`)); };

  if (req.query.group) add('action = ANY(?)', ACTION_GROUPS[requireEnum(req.query.group, Object.keys(ACTION_GROUPS), 'group')]);
  if (req.query.action) add('action = ?', requireText(req.query.action, 'action', 40));
  if (req.query.username) add('username ILIKE ?', `%${requireText(req.query.username, 'username', 30).replace(/[%_\\]/g, '\\$&')}%`);
  if (req.query.from) add('at >= ?::date', requireText(req.query.from, 'from', 10));
  if (req.query.to) add(`at < ?::date + 1`, requireText(req.query.to, 'to', 10));
  if (req.query.before_id) add('id < ?', requireId(req.query.before_id));
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, at, user_id, username, role, action, target_type, target_id, detail, ip
       FROM audit_log ${where} ORDER BY id DESC LIMIT ${limit + 1}`,
    params,
  ).catch((err) => {
    if (err.code === '22007' || err.code === '22008') throw new HttpError(400, 'Ngày không hợp lệ (YYYY-MM-DD)');
    throw err;
  });
  res.json({ items: rows.slice(0, limit), has_more: rows.length > limit });
}));

module.exports = { router };
