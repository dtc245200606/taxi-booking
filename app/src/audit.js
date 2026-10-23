// Nhật ký hoạt động: ghi vào bảng audit_log (chỉ thêm mới) và đồng thời ra log JSON (-> Loki).
const { pool } = require('./db');
const log = require('./logger');

// Ghi một hành động. user mặc định là người đang đăng nhập (req.user).
// Truyền db = client của transaction để nhật ký được ghi cùng (hoặc rollback cùng) thao tác.
async function audit(req, action, { targetType = null, targetId = null, detail = null, user, db = pool } = {}) {
  const u = user !== undefined ? user : req.user;
  const entry = {
    userId: u ? u.id : null,
    username: u ? u.username : (detail && detail.username) || null,
    role: u ? u.role : null,
  };
  log.info('audit', { action, ...entry, targetType, targetId, ...(detail || {}), ip: req.ip });
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, username, role, action, target_type, target_id, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.userId, entry.username, entry.role, action, targetType, targetId,
        detail ? JSON.stringify(detail) : null, req.ip],
    );
  } catch (err) {
    // Trong transaction thì lỗi phải lan ra để rollback; ngoài transaction chỉ ghi log lỗi
    if (db !== pool) throw err;
    log.error('audit_write_failed', { action, error: err.message });
  }
}

module.exports = { audit };
