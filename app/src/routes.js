// REST API cho hệ thống đặt xe: khách hàng, tài xế, chuyến đi, trạng thái.
// Mọi truy vấn đều dùng tham số hóa ($1, $2...) để chống SQL Injection.
const express = require('express');
const { pool, withTransaction } = require('./db');
const metrics = require('./metrics');
const log = require('./logger');
const {
  HttpError, wrap, requireText, requirePhone, requireEmail, requireId, requireEnum,
} = require('./validate');
const { requireAuth, requireRole } = require('./auth');

const router = express.Router();

const VEHICLE_TYPES = ['bike', 'car4', 'car7'];
const DRIVER_STATUSES = ['available', 'on_trip', 'offline'];
const TRIP_STATUSES = ['requested', 'assigned', 'in_progress', 'completed', 'cancelled'];

// Giá cước: giá mở cửa + đơn giá theo km, tùy loại xe (VND).
const FARE = {
  bike: { base: 10000, perKm: 5000 },
  car4: { base: 20000, perKm: 12000 },
  car7: { base: 25000, perKm: 15000 },
};

// Các bước chuyển trạng thái hợp lệ của một chuyến đi.
const TRANSITIONS = {
  assign: { from: ['requested'], to: 'assigned' },
  start: { from: ['assigned'], to: 'in_progress' },
  complete: { from: ['in_progress'], to: 'completed' },
  cancel: { from: ['requested', 'assigned'], to: 'cancelled' },
};

function calcFare(vehicleType, distanceKm) {
  const f = FARE[vehicleType];
  return Math.round((f.base + f.perKm * distanceKm) / 1000) * 1000;
}

// Lỗi trùng khóa UNIQUE của PostgreSQL -> 409
function mapPgError(err) {
  if (err.code === '23505') return new HttpError(409, 'Dữ liệu đã tồn tại (trùng số điện thoại/biển số)');
  if (err.code === '23503') return new HttpError(400, 'Tham chiếu không tồn tại');
  return err;
}

// Mọi API bên dưới đều cần đăng nhập.
//   dispatcher : toàn quyền điều phối
//   customer   : chỉ đặt xe, xem và hủy chuyến của chính mình
router.use(requireAuth);
const dispatcherOnly = requireRole('dispatcher');
const isCustomer = (req) => req.user.role === 'customer';

// ---------- Tổng quan ----------
router.get('/stats', dispatcherOnly, wrap(async (req, res) => {
  const [trips, drivers, customers, revenue] = await Promise.all([
    pool.query('SELECT status, COUNT(*)::int AS count FROM trips GROUP BY status'),
    pool.query('SELECT status, COUNT(*)::int AS count FROM drivers GROUP BY status'),
    pool.query('SELECT COUNT(*)::int AS count FROM customers'),
    pool.query(`SELECT COALESCE(SUM(fare), 0)::bigint AS total
                FROM trips WHERE status = 'completed' AND completed_at::date = CURRENT_DATE`),
  ]);
  res.json({
    trips: Object.fromEntries(trips.rows.map((r) => [r.status, r.count])),
    drivers: Object.fromEntries(drivers.rows.map((r) => [r.status, r.count])),
    customers: customers.rows[0].count,
    revenueToday: Number(revenue.rows[0].total),
  });
}));

// ---------- Khách hàng ----------
router.get('/customers', dispatcherOnly, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.full_name, c.phone, c.email, c.created_at,
            COUNT(t.id)::int AS trip_count
       FROM customers c LEFT JOIN trips t ON t.customer_id = c.id
      GROUP BY c.id ORDER BY c.id DESC`,
  );
  res.json(rows);
}));

router.post('/customers', dispatcherOnly, wrap(async (req, res) => {
  const fullName = requireText(req.body.full_name, 'full_name', 100);
  const phone = requirePhone(req.body.phone);
  const email = requireEmail(req.body.email);
  try {
    const { rows } = await pool.query(
      'INSERT INTO customers (full_name, phone, email) VALUES ($1, $2, $3) RETURNING *',
      [fullName, phone, email],
    );
    log.info('customer_created', { customerId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) {
    throw mapPgError(err);
  }
}));

// ---------- Tài xế ----------
router.get('/drivers', dispatcherOnly, wrap(async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.status) {
    params.push(requireEnum(req.query.status, DRIVER_STATUSES, 'status'));
    where = 'WHERE d.status = $1';
  }
  const { rows } = await pool.query(
    `SELECT d.*, COUNT(t.id) FILTER (WHERE t.status = 'completed')::int AS completed_trips
       FROM drivers d LEFT JOIN trips t ON t.driver_id = d.id
       ${where}
      GROUP BY d.id ORDER BY d.id DESC`,
    params,
  );
  res.json(rows);
}));

router.post('/drivers', dispatcherOnly, wrap(async (req, res) => {
  const fullName = requireText(req.body.full_name, 'full_name', 100);
  const phone = requirePhone(req.body.phone);
  const plate = requireText(req.body.license_plate, 'license_plate', 20).toUpperCase();
  const vehicleType = requireEnum(req.body.vehicle_type, VEHICLE_TYPES, 'vehicle_type');
  try {
    const { rows } = await pool.query(
      `INSERT INTO drivers (full_name, phone, license_plate, vehicle_type)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [fullName, phone, plate, vehicleType],
    );
    log.info('driver_created', { driverId: rows[0].id, vehicleType });
    res.status(201).json(rows[0]);
  } catch (err) {
    throw mapPgError(err);
  }
}));

// Tài xế tự bật/tắt nhận chuyến (available <-> offline). Không cho đổi khi đang chở khách.
router.patch('/drivers/:id/status', dispatcherOnly, wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const status = requireEnum(req.body.status, ['available', 'offline'], 'status');
  const { rows } = await pool.query(
    `UPDATE drivers SET status = $1 WHERE id = $2 AND status <> 'on_trip' RETURNING *`,
    [status, id],
  );
  if (!rows.length) throw new HttpError(409, 'Không tìm thấy tài xế hoặc tài xế đang chở khách');
  log.info('driver_status_changed', { driverId: id, status });
  res.json(rows[0]);
}));

// ---------- Chuyến đi ----------
const TRIP_SELECT = `
  SELECT t.*, c.full_name AS customer_name, c.phone AS customer_phone,
         d.full_name AS driver_name, d.license_plate
    FROM trips t
    JOIN customers c ON c.id = t.customer_id
    LEFT JOIN drivers d ON d.id = t.driver_id`;

router.get('/trips', wrap(async (req, res) => {
  const params = [];
  const conds = [];
  if (req.query.status) {
    params.push(requireEnum(req.query.status, TRIP_STATUSES, 'status'));
    conds.push(`t.status = $${params.length}`);
  }
  if (isCustomer(req)) {
    params.push(req.user.customer_id);
    conds.push(`t.customer_id = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(`${TRIP_SELECT} ${where} ORDER BY t.id DESC LIMIT 200`, params);
  res.json(rows);
}));

router.get('/trips/:id', wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const trip = await pool.query(`${TRIP_SELECT} WHERE t.id = $1`, [id]);
  // Khách hàng xem chuyến của người khác -> báo 404 (không để lộ chuyến đó có tồn tại)
  if (!trip.rows.length || (isCustomer(req) && trip.rows[0].customer_id !== req.user.customer_id)) {
    throw new HttpError(404, 'Không tìm thấy chuyến đi');
  }
  const history = await pool.query(
    'SELECT from_status, to_status, note, changed_at FROM trip_status_history WHERE trip_id = $1 ORDER BY id',
    [id],
  );
  res.json({ ...trip.rows[0], history: history.rows });
}));

router.post('/trips', wrap(async (req, res) => {
  // Khách hàng chỉ đặt xe cho chính mình; điều phối viên chọn khách hàng
  const customerId = isCustomer(req) ? req.user.customer_id : requireId(req.body.customer_id);
  const pickup = requireText(req.body.pickup_address, 'pickup_address');
  const dropoff = requireText(req.body.dropoff_address, 'dropoff_address');
  const vehicleType = requireEnum(req.body.vehicle_type, VEHICLE_TYPES, 'vehicle_type');
  const distance = Number(req.body.distance_km);
  if (!(distance > 0 && distance <= 500)) throw new HttpError(400, 'Quãng đường phải trong khoảng 0 - 500 km');
  const fare = calcFare(vehicleType, distance);

  const trip = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO trips (customer_id, pickup_address, dropoff_address, vehicle_type, distance_km, fare)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [customerId, pickup, dropoff, vehicleType, distance, fare],
    ).catch((err) => { throw mapPgError(err); });
    await db.query(
      `INSERT INTO trip_status_history (trip_id, from_status, to_status, note)
       VALUES ($1, NULL, 'requested', 'Khách đặt xe')`,
      [rows[0].id],
    );
    return rows[0];
  });

  metrics.tripsCreated.inc({ vehicle_type: vehicleType });
  metrics.tripTransitions.inc({ to_status: 'requested' });
  log.info('trip_created', { tripId: trip.id, customerId, vehicleType, distanceKm: distance, fare });
  res.status(201).json(trip);
}));

// POST /trips/:id/{assign|start|complete|cancel}
router.post('/trips/:id/:action', wrap(async (req, res) => {
  const id = requireId(req.params.id);
  const action = req.params.action;
  const rule = TRANSITIONS[action];
  if (!rule) throw new HttpError(404, 'Hành động không hợp lệ');
  if (isCustomer(req) && action !== 'cancel') throw new HttpError(403, 'Bạn chỉ có thể hủy chuyến của mình');

  const result = await withTransaction(async (db) => {
    // Khóa dòng để tránh 2 điều phối viên thao tác cùng lúc
    const { rows } = await db.query('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length || (isCustomer(req) && rows[0].customer_id !== req.user.customer_id)) {
      throw new HttpError(404, 'Không tìm thấy chuyến đi');
    }
    const trip = rows[0];
    if (!rule.from.includes(trip.status)) {
      throw new HttpError(409, `Không thể "${action}" khi chuyến đang ở trạng thái "${trip.status}"`);
    }

    let driverId = trip.driver_id;
    let note = null;

    if (action === 'assign') {
      // Chọn tài xế được chỉ định, hoặc tự động chọn tài xế rảnh cùng loại xe
      const params = [trip.vehicle_type];
      let cond = '';
      if (req.body.driver_id) {
        params.push(requireId(req.body.driver_id));
        cond = 'AND id = $2';
      }
      const d = await db.query(
        `SELECT id, full_name FROM drivers
          WHERE status = 'available' AND vehicle_type = $1 ${cond}
          ORDER BY rating DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        params,
      );
      if (!d.rows.length) throw new HttpError(409, 'Không có tài xế rảnh phù hợp với loại xe');
      driverId = d.rows[0].id;
      note = `Giao cho tài xế ${d.rows[0].full_name}`;
      await db.query(`UPDATE drivers SET status = 'on_trip' WHERE id = $1`, [driverId]);
    }

    if ((action === 'complete' || action === 'cancel') && driverId) {
      await db.query(`UPDATE drivers SET status = 'available' WHERE id = $1`, [driverId]);
    }

    if (action === 'cancel') {
      note = req.body.reason ? requireText(req.body.reason, 'reason') : 'Hủy chuyến';
    }

    const tsColumn = {
      assign: 'assigned_at', start: 'started_at', complete: 'completed_at', cancel: 'cancelled_at',
    }[action];
    const updated = await db.query(
      `UPDATE trips SET status = $1, driver_id = $2, ${tsColumn} = now(),
              cancel_reason = COALESCE($3, cancel_reason)
        WHERE id = $4 RETURNING *`,
      [rule.to, driverId, action === 'cancel' ? note : null, id],
    );
    await db.query(
      `INSERT INTO trip_status_history (trip_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)`,
      [id, trip.status, rule.to, note],
    );
    return { trip: updated.rows[0], from: trip.status };
  });

  metrics.tripTransitions.inc({ to_status: rule.to });
  log.info('trip_status_changed', {
    tripId: id, from: result.from, to: rule.to, driverId: result.trip.driver_id, userId: req.user.id,
  });
  res.json(result.trip);
}));

module.exports = { router, TRIP_STATUSES, DRIVER_STATUSES };
