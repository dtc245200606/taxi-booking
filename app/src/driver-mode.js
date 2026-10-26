// Khu vực riêng của tài xế đối tác (khách hàng có hồ sơ tài xế đã được duyệt, drivers.user_id = tài khoản).
//   GET   /api/driver/me                         : thông tin tài xế, chuyến mới đang chờ (nổ chuyến), chuyến đang xử lý,
//                                                  chuyến gần đây, số liệu hôm nay
//   PATCH /api/driver/me/status                  : bật nhận chuyến (available) / nghỉ chạy xe (offline)
//   POST  /api/driver/trips/:id/claim            : tự nhận chuyến khách vừa đặt - ai nhận trước được trước
//   POST  /api/driver/trips/:id/{accept|reject|start|complete}
//     (accept / reject dùng cho chuyến do tổng đài giao đích danh)
//     accept   : xác nhận đón khách chuyến được điều phối giao
//     reject   : từ chối -> chuyến quay về "Chờ tài xế", không bị giao lại cho tài xế này
//     start    : đã đón khách, bắt đầu chạy (chỉ sau khi đã xác nhận)
//     complete : hoàn thành chuyến
const express = require('express');
const { pool, withTransaction } = require('./db');
const metrics = require('./metrics');
const log = require('./logger');
const { audit } = require('./audit');
const { HttpError, wrap, requireText, requireId, requireEnum } = require('./validate');
const { requireRole } = require('./auth');

const router = express.Router();
const customerOnly = requireRole('customer');

const NOT_DRIVER = 'Bạn chưa là tài xế đối tác';

async function findDriver(db, userId, lock = false) {
  const { rows } = await db.query(
    `SELECT * FROM drivers WHERE user_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  return rows[0] || null;
}

const TRIP_SELECT = `
  SELECT t.*, c.full_name AS customer_name, c.phone AS customer_phone
    FROM trips t JOIN customers c ON c.id = t.customer_id`;

// Khách hàng chưa là tài xế -> { driver: null } (giao diện dùng để ẩn mục tài xế)
router.get('/driver/me', customerOnly, wrap(async (req, res) => {
  const driver = await findDriver(pool, req.user.id);
  if (!driver) return res.json({ driver: null });
  const [open, current, recent, today] = await Promise.all([
    // Chuyến mới chỉ hiện khi tài xế đang rảnh. Chưa nhận chuyến thì không thấy SĐT khách.
    driver.status !== 'available' ? { rows: [] } : pool.query(
      `SELECT t.id, t.pickup_address, t.dropoff_address, t.vehicle_type, t.distance_km, t.fare, t.requested_at
         FROM trips t
        WHERE t.status = 'requested' AND t.vehicle_type = $1
          AND t.customer_id IS DISTINCT FROM (SELECT customer_id FROM users WHERE id = $3)
          AND NOT EXISTS (SELECT 1 FROM trip_driver_rejections r WHERE r.trip_id = t.id AND r.driver_id = $2)
        ORDER BY t.requested_at LIMIT 20`,
      [driver.vehicle_type, driver.id, req.user.id],
    ),
    pool.query(
      `${TRIP_SELECT} WHERE t.driver_id = $1 AND t.status IN ('assigned', 'in_progress') ORDER BY t.id`,
      [driver.id],
    ),
    pool.query(
      `${TRIP_SELECT} WHERE t.driver_id = $1 AND t.status IN ('completed', 'cancelled') ORDER BY t.id DESC LIMIT 10`,
      [driver.id],
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
              COALESCE(SUM(fare) FILTER (WHERE status = 'completed'), 0)::bigint AS revenue,
              (SELECT COUNT(*)::int FROM trip_driver_rejections r
                WHERE r.driver_id = $1
                  AND (r.rejected_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS rejected
         FROM trips
        WHERE driver_id = $1
          AND (completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
      [driver.id],
    ),
  ]);
  return res.json({
    driver,
    open: open.rows,
    current: current.rows,
    recent: recent.rows,
    today: { ...today.rows[0], revenue: Number(today.rows[0].revenue) },
  });
}));

// Tài xế tự bật nhận chuyến / nghỉ chạy xe. Không đổi được khi đang có chuyến.
router.patch('/driver/me/status', customerOnly, wrap(async (req, res) => {
  const status = requireEnum(req.body.status, ['available', 'offline'], 'status');
  const driver = await withTransaction(async (db) => {
    const d = await findDriver(db, req.user.id, true);
    if (!d) throw new HttpError(403, NOT_DRIVER);
    if (d.status === 'on_trip') throw new HttpError(409, 'Bạn đang có chuyến - hoàn thành chuyến trước khi đổi trạng thái');
    if (status === 'available' && d.license_expires_on && d.license_expires_on <= new Date()) {
      throw new HttpError(409, 'GPLX của bạn đã hết hạn - vui lòng liên hệ tổng đài để cập nhật');
    }
    const { rows } = await db.query('UPDATE drivers SET status = $1 WHERE id = $2 RETURNING *', [status, d.id]);
    return rows[0];
  });
  log.info('driver_status_changed', { driverId: driver.id, status, by: 'driver' });
  await audit(req, 'driver_status', {
    targetType: 'driver', targetId: driver.id, detail: { full_name: driver.full_name, status, self: true },
  });
  res.json(driver);
}));

// Tài xế tự nhận chuyến khách vừa đặt. Khóa dòng tài xế + chuyến: 2 tài xế bấm cùng lúc thì chỉ 1 người được.
router.post('/driver/trips/:id/claim', customerOnly, wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const result = await withTransaction(async (db) => {
    const driver = await findDriver(db, req.user.id, true);
    if (!driver) throw new HttpError(403, NOT_DRIVER);
    if (driver.status === 'offline') throw new HttpError(409, 'Bạn đang nghỉ - hãy bật nhận chuyến trước');
    if (driver.status === 'on_trip') throw new HttpError(409, 'Bạn đang có chuyến - hoàn thành chuyến trước khi nhận chuyến mới');
    if (driver.license_expires_on && driver.license_expires_on <= new Date()) {
      throw new HttpError(409, 'GPLX của bạn đã hết hạn - vui lòng liên hệ tổng đài để cập nhật');
    }
    const { rows } = await db.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw new HttpError(404, 'Không tìm thấy chuyến đi');
    const trip = rows[0];
    if (trip.status !== 'requested') throw new HttpError(409, 'Chuyến này đã có tài xế khác nhận hoặc khách đã hủy');
    if (trip.vehicle_type !== driver.vehicle_type) throw new HttpError(409, 'Chuyến này không cùng loại xe của bạn');
    if (trip.customer_id === req.user.customer_id) throw new HttpError(409, 'Bạn không thể nhận chuyến do chính mình đặt');
    const rejected = await db.query(
      'SELECT 1 FROM trip_driver_rejections WHERE trip_id = $1 AND driver_id = $2', [id, driver.id],
    );
    if (rejected.rows.length) throw new HttpError(409, 'Bạn đã từ chối chuyến này');

    const updated = await db.query(
      `UPDATE trips SET status = 'assigned', driver_id = $1, assigned_at = now(), driver_accepted_at = now()
        WHERE id = $2 RETURNING *`,
      [driver.id, id],
    );
    await db.query(`UPDATE drivers SET status = 'on_trip' WHERE id = $1`, [driver.id]);
    await db.query(
      `INSERT INTO trip_status_history (trip_id, from_status, to_status, note) VALUES ($1, 'requested', 'assigned', $2)`,
      [id, `Tài xế ${driver.full_name} nhận chuyến`],
    );
    return { trip: updated.rows[0], driverId: driver.id };
  });

  metrics.tripTransitions.inc({ to_status: 'assigned' });
  log.info('trip_driver_action', {
    tripId: id, action: 'claim', from: 'requested', to: 'assigned', driverId: result.driverId, userId: req.user.id,
  });
  await audit(req, 'trip_driver_claim', {
    targetType: 'trip', targetId: id, detail: { from: 'requested', to: 'assigned', driverId: result.driverId },
  });
  res.json(result.trip);
}));

// Điều kiện cho từng thao tác của tài xế trên chuyến của mình
const DRIVER_ACTIONS = {
  accept: { from: 'assigned', accepted: false },
  reject: { from: 'assigned', accepted: false },
  start: { from: 'assigned', accepted: true },
  complete: { from: 'in_progress' },
};

router.post('/driver/trips/:id/:action', customerOnly, wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const action = req.params.action;
  const rule = DRIVER_ACTIONS[action];
  if (!rule) throw new HttpError(404, 'Hành động không hợp lệ');

  const result = await withTransaction(async (db) => {
    const driver = await findDriver(db, req.user.id, true);
    if (!driver) throw new HttpError(403, NOT_DRIVER);
    const { rows } = await db.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [id]);
    // Chuyến không giao cho mình -> 404 (không để lộ chuyến của tài xế khác)
    if (!rows.length || rows[0].driver_id !== driver.id) throw new HttpError(404, 'Không tìm thấy chuyến đi');
    const trip = rows[0];
    if (trip.status !== rule.from) throw new HttpError(409, 'Chuyến đi đã thay đổi trạng thái, vui lòng tải lại');
    if (rule.accepted === false && trip.driver_accepted_at) throw new HttpError(409, 'Bạn đã xác nhận chuyến này');
    if (rule.accepted === true && !trip.driver_accepted_at) throw new HttpError(409, 'Hãy xác nhận đón khách trước');

    let updated;
    let toStatus = trip.status;
    let note;
    if (action === 'accept') {
      note = `Tài xế ${driver.full_name} xác nhận đón khách`;
      updated = await db.query('UPDATE trips SET driver_accepted_at = now() WHERE id = $1 RETURNING *', [id]);
    } else if (action === 'reject') {
      const reason = req.body.reason ? requireText(req.body.reason, 'Lý do', 200) : null;
      toStatus = 'requested';
      note = `Tài xế ${driver.full_name} từ chối${reason ? `: ${reason}` : ''}`.slice(0, 200);
      await db.query('INSERT INTO trip_driver_rejections (trip_id, driver_id, reason) VALUES ($1, $2, $3)', [id, driver.id, reason]);
      updated = await db.query(
        `UPDATE trips SET status = 'requested', driver_id = NULL, assigned_at = NULL WHERE id = $1 RETURNING *`,
        [id],
      );
      await db.query(`UPDATE drivers SET status = 'available' WHERE id = $1`, [driver.id]);
    } else if (action === 'start') {
      toStatus = 'in_progress';
      note = 'Tài xế đã đón khách';
      updated = await db.query(`UPDATE trips SET status = 'in_progress', started_at = now() WHERE id = $1 RETURNING *`, [id]);
    } else {
      toStatus = 'completed';
      note = 'Tài xế hoàn thành chuyến';
      updated = await db.query(`UPDATE trips SET status = 'completed', completed_at = now() WHERE id = $1 RETURNING *`, [id]);
      await db.query(`UPDATE drivers SET status = 'available' WHERE id = $1`, [driver.id]);
    }
    await db.query(
      'INSERT INTO trip_status_history (trip_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)',
      [id, trip.status, toStatus, note],
    );
    return { trip: updated.rows[0], from: trip.status, to: toStatus, driverId: driver.id };
  });

  if (result.from !== result.to) metrics.tripTransitions.inc({ to_status: result.to });
  log.info('trip_driver_action', {
    tripId: id, action, from: result.from, to: result.to, driverId: result.driverId, userId: req.user.id,
  });
  await audit(req, `trip_driver_${action}`, {
    targetType: 'trip', targetId: id, detail: { from: result.from, to: result.to, driverId: result.driverId },
  });
  res.json(result.trip);
}));

module.exports = { router };
