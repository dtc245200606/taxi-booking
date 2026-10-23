// Thống kê chi tiết khi bấm vào từng thẻ số liệu ở trang Tổng quan (chỉ nhân viên).
//   GET /api/stats/detail/:metric?period=today|7d|30d|all
//   metric: waiting | serving | completed | cancelled | drivers | customers | revenue
// Mọi mốc "ngày" tính theo giờ Việt Nam (CSDL chạy giờ UTC).
const express = require('express');
const { pool } = require('./db');
const { HttpError, wrap, requireEnum } = require('./validate');
const { requireRole, STAFF_ROLES } = require('./auth');

const router = express.Router();
const TZ = 'Asia/Ho_Chi_Minh';
const TODAY = `(now() AT TIME ZONE '${TZ}')::date`;
const localDate = (col) => `(${col} AT TIME ZONE '${TZ}')::date`;
const PERIODS = ['today', '7d', '30d', 'all'];
const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30 };

// Điều kiện lọc theo kỳ cho một cột thời gian (chỉ ghép chuỗi hằng - period đã được kiểm tra enum)
function inPeriod(col, period) {
  if (period === 'all') return 'TRUE';
  return `${localDate(col)} > ${TODAY} - ${PERIOD_DAYS[period]}`;
}
// Kỳ liền trước có cùng độ dài (để so sánh tăng / giảm)
function inPrevPeriod(col, period) {
  const n = PERIOD_DAYS[period];
  return `${localDate(col)} > ${TODAY} - ${2 * n} AND ${localDate(col)} <= ${TODAY} - ${n}`;
}

// Chuỗi thời gian có đủ mọi mốc (mốc không có dữ liệu = 0): theo giờ nếu "hôm nay", ngược lại theo ngày
async function series(col, where, period, valueSql = 'count(t.id)') {
  if (period === 'today') {
    const { rows } = await pool.query(
      `SELECT h AS bucket, ${valueSql}::bigint AS value
         FROM generate_series(0, 23) h
         LEFT JOIN trips t ON ${where} AND ${localDate(`t.${col}`)} = ${TODAY}
                          AND extract(hour FROM t.${col} AT TIME ZONE '${TZ}') = h
        GROUP BY h ORDER BY h`,
    );
    return { unit: 'hour', points: rows.map((r) => ({ bucket: r.bucket, value: Number(r.value) })) };
  }
  let days = PERIOD_DAYS[period];
  if (period === 'all') {
    const { rows } = await pool.query(`SELECT ${TODAY} - min(${localDate(col)}) + 1 AS n FROM trips t WHERE ${where}`);
    days = Math.min(Math.max(Number(rows[0].n) || 1, 7), 90);
  }
  const { rows } = await pool.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS bucket, ${valueSql}::bigint AS value
       FROM generate_series(${TODAY} - ${days - 1}, ${TODAY}, interval '1 day') d
       LEFT JOIN trips t ON ${where} AND ${localDate(`t.${col}`)} = d::date
      GROUP BY d ORDER BY d`,
  );
  return { unit: 'day', points: rows.map((r) => ({ bucket: r.bucket, value: Number(r.value) })) };
}

async function byVehicle(where) {
  const { rows } = await pool.query(
    `SELECT v AS vehicle_type, count(t.id)::int AS trips, COALESCE(sum(t.fare), 0)::bigint AS revenue
       FROM unnest(ARRAY['bike', 'car4', 'car7']) v LEFT JOIN trips t ON t.vehicle_type = v AND ${where}
      GROUP BY v ORDER BY array_position(ARRAY['bike', 'car4', 'car7'], v)`,
  );
  return rows.map((r) => ({ ...r, revenue: Number(r.revenue) }));
}

async function topDrivers(where, order = 'revenue') {
  const { rows } = await pool.query(
    `SELECT d.id, d.full_name, d.license_plate, d.vehicle_type, d.rating, d.status,
            count(t.id)::int AS trips, COALESCE(sum(t.fare), 0)::bigint AS revenue
       FROM trips t JOIN drivers d ON d.id = t.driver_id
      WHERE ${where}
      GROUP BY d.id ORDER BY ${order === 'trips' ? 'trips' : 'revenue'} DESC, d.id LIMIT 10`,
  );
  return rows.map((r) => ({ ...r, revenue: Number(r.revenue) }));
}

async function topCustomers(where, order = 'revenue') {
  const { rows } = await pool.query(
    `SELECT c.id, c.full_name, c.phone, count(t.id)::int AS trips, COALESCE(sum(t.fare), 0)::bigint AS spend
       FROM trips t JOIN customers c ON c.id = t.customer_id
      WHERE ${where}
      GROUP BY c.id ORDER BY ${order === 'trips' ? 'trips' : 'spend'} DESC, c.id LIMIT 10`,
  );
  return rows.map((r) => ({ ...r, spend: Number(r.spend) }));
}

const TRIP_LIST = `
  SELECT t.id, t.status, t.vehicle_type, t.pickup_address, t.dropoff_address, t.distance_km, t.fare,
         t.requested_at, t.assigned_at, t.started_at, t.cancel_reason, t.cancelled_at,
         c.full_name AS customer_name, c.phone AS customer_phone,
         d.full_name AS driver_name, d.license_plate
    FROM trips t JOIN customers c ON c.id = t.customer_id LEFT JOIN drivers d ON d.id = t.driver_id`;

// ---------- Từng loại số liệu ----------
const METRICS = {
  // Chờ tài xế: danh sách đang chờ + cung (tài xế rảnh) so với cầu theo loại xe
  async waiting() {
    const [trips, supply] = await Promise.all([
      pool.query(`${TRIP_LIST} WHERE t.status = 'requested' ORDER BY t.requested_at`),
      pool.query(`SELECT v AS vehicle_type,
                         count(d.id) FILTER (WHERE d.status = 'available')::int AS available,
                         count(d.id) FILTER (WHERE d.status = 'on_trip')::int AS on_trip,
                         (SELECT count(*) FROM trips WHERE status = 'requested' AND vehicle_type = v)::int AS waiting
                    FROM unnest(ARRAY['bike', 'car4', 'car7']) v LEFT JOIN drivers d ON d.vehicle_type = v
                   GROUP BY v ORDER BY array_position(ARRAY['bike', 'car4', 'car7'], v)`),
    ]);
    const waits = trips.rows.map((t) => (Date.now() - new Date(t.requested_at)) / 60000);
    return {
      summary: {
        count: trips.rows.length,
        avg_wait_min: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
        max_wait_min: waits.length ? Math.max(...waits) : 0,
      },
      supply: supply.rows,
      trips: trips.rows,
    };
  },

  // Đang phục vụ: chuyến đã nhận + đang chạy, kèm tài xế
  async serving() {
    const { rows } = await pool.query(
      `${TRIP_LIST} WHERE t.status IN ('assigned', 'in_progress') ORDER BY t.status DESC, t.assigned_at`,
    );
    return {
      summary: {
        count: rows.length,
        assigned: rows.filter((r) => r.status === 'assigned').length,
        in_progress: rows.filter((r) => r.status === 'in_progress').length,
        revenue_pending: rows.reduce((s, r) => s + r.fare, 0),
      },
      by_vehicle: await byVehicle(`t.status IN ('assigned', 'in_progress')`),
      trips: rows,
    };
  },

  async completed(period) {
    const where = `t.status = 'completed' AND ${inPeriod('t.completed_at', period)}`;
    const { rows: [s] } = await pool.query(
      `SELECT count(*)::int AS count, COALESCE(sum(fare), 0)::bigint AS revenue, avg(fare) AS avg_fare,
              avg(distance_km) AS avg_km,
              avg(extract(epoch FROM completed_at - started_at) / 60) AS avg_duration_min,
              avg(extract(epoch FROM assigned_at - requested_at) / 60) AS avg_assign_min,
              count(DISTINCT customer_id)::int AS customers, count(DISTINCT driver_id)::int AS drivers
         FROM trips t WHERE ${where}`,
    );
    return {
      summary: { ...s, revenue: Number(s.revenue) },
      series: await series('completed_at', `t.status = 'completed'`, period),
      by_vehicle: await byVehicle(where),
      top_drivers: await topDrivers(where, 'trips'),
      top_customers: await topCustomers(where, 'trips'),
    };
  },

  async cancelled(period) {
    const where = `t.status = 'cancelled' AND ${inPeriod('t.cancelled_at', period)}`;
    const [summary, reasons, recent, drivers] = await Promise.all([
      pool.query(
        `SELECT count(*) FILTER (WHERE status = 'cancelled' AND ${inPeriod('cancelled_at', period)})::int AS count,
                count(*) FILTER (WHERE status = 'cancelled' AND driver_id IS NULL AND ${inPeriod('cancelled_at', period)})::int AS before_assign,
                count(*) FILTER (WHERE status = 'cancelled' AND driver_id IS NOT NULL AND ${inPeriod('cancelled_at', period)})::int AS after_assign,
                count(*) FILTER (WHERE status = 'completed' AND ${inPeriod('completed_at', period)})::int AS completed,
                COALESCE(sum(fare) FILTER (WHERE status = 'cancelled' AND ${inPeriod('cancelled_at', period)}), 0)::bigint AS lost_revenue
           FROM trips`,
      ),
      pool.query(`SELECT COALESCE(cancel_reason, 'Không rõ') AS reason, count(*)::int AS count
                    FROM trips t WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
      pool.query(`${TRIP_LIST} WHERE ${where} ORDER BY t.cancelled_at DESC LIMIT 10`),
      topDrivers(`${where} AND t.driver_id IS NOT NULL`, 'trips'),
    ]);
    const s = summary.rows[0];
    const total = s.count + s.completed;
    return {
      summary: { ...s, lost_revenue: Number(s.lost_revenue), cancel_rate: total ? s.count / total : 0 },
      series: await series('cancelled_at', `t.status = 'cancelled'`, period),
      reasons: reasons.rows,
      top_customers: await topCustomers(where, 'trips'),
      top_drivers: drivers,
      recent: recent.rows,
    };
  },

  // Tài xế: phân bố trạng thái + bảng hiệu suất từng tài xế trong kỳ
  async drivers(period) {
    const [matrix, list] = await Promise.all([
      pool.query(`SELECT v AS vehicle_type,
                         count(d.id) FILTER (WHERE d.status = 'available')::int AS available,
                         count(d.id) FILTER (WHERE d.status = 'on_trip')::int AS on_trip,
                         count(d.id) FILTER (WHERE d.status = 'offline')::int AS offline
                    FROM unnest(ARRAY['bike', 'car4', 'car7']) v LEFT JOIN drivers d ON d.vehicle_type = v
                   GROUP BY v ORDER BY array_position(ARRAY['bike', 'car4', 'car7'], v)`),
      pool.query(`SELECT d.id, d.full_name, d.phone, d.license_plate, d.vehicle_type, d.status, d.rating,
                         count(t.id) FILTER (WHERE t.status = 'completed' AND ${inPeriod('t.completed_at', period)})::int AS trips,
                         COALESCE(sum(t.fare) FILTER (WHERE t.status = 'completed' AND ${inPeriod('t.completed_at', period)}), 0)::bigint AS revenue,
                         count(t.id) FILTER (WHERE t.status = 'cancelled' AND ${inPeriod('t.cancelled_at', period)})::int AS cancelled,
                         max(t.completed_at) AS last_trip_at
                    FROM drivers d LEFT JOIN trips t ON t.driver_id = d.id
                   GROUP BY d.id
                   ORDER BY array_position(ARRAY['available', 'on_trip', 'offline'], d.status), revenue DESC`),
    ]);
    const all = list.rows.map((r) => ({ ...r, revenue: Number(r.revenue), rating: Number(r.rating) }));
    return {
      summary: {
        total: all.length,
        available: all.filter((d) => d.status === 'available').length,
        on_trip: all.filter((d) => d.status === 'on_trip').length,
        offline: all.filter((d) => d.status === 'offline').length,
        avg_rating: all.length ? all.reduce((s, d) => s + d.rating, 0) / all.length : 0,
        utilization: all.length ? all.filter((d) => d.status === 'on_trip').length
          / Math.max(1, all.filter((d) => d.status !== 'offline').length) : 0,
      },
      matrix: matrix.rows,
      drivers: all,
    };
  },

  async customers(period) {
    const [summary, newest, regSeries] = await Promise.all([
      pool.query(
        `SELECT (SELECT count(*) FROM customers)::int AS total,
                (SELECT count(*) FROM users WHERE role = 'customer')::int AS with_account,
                (SELECT count(*) FROM customers WHERE ${inPeriod('created_at', period)})::int AS new_customers,
                (SELECT count(DISTINCT customer_id) FROM trips WHERE ${inPeriod('requested_at', period)})::int AS active,
                (SELECT count(*) FROM customers c WHERE NOT EXISTS (SELECT 1 FROM trips t WHERE t.customer_id = c.id
                   AND t.requested_at > now() - interval '30 days'))::int AS inactive_30d,
                (SELECT COALESCE(sum(fare), 0) FROM trips WHERE status = 'completed' AND ${inPeriod('completed_at', period)})::bigint AS revenue`,
      ),
      pool.query(`SELECT c.id, c.full_name, c.phone, c.email, c.created_at, (u.id IS NOT NULL) AS has_account,
                         (SELECT count(*) FROM trips t WHERE t.customer_id = c.id)::int AS trips
                    FROM customers c LEFT JOIN users u ON u.customer_id = c.id
                   ORDER BY c.created_at DESC LIMIT 8`),
      // Đăng ký mới theo ngày (30 ngày gần nhất)
      pool.query(`SELECT to_char(d, 'YYYY-MM-DD') AS bucket, count(c.id)::int AS value
                    FROM generate_series(${TODAY} - 29, ${TODAY}, interval '1 day') d
                    LEFT JOIN customers c ON ${localDate('c.created_at')} = d::date
                   GROUP BY d ORDER BY d`),
    ]);
    const s = summary.rows[0];
    const completedWhere = `t.status = 'completed' AND ${inPeriod('t.completed_at', period)}`;
    return {
      summary: {
        ...s,
        revenue: Number(s.revenue),
        avg_spend: s.active ? Number(s.revenue) / s.active : 0,
      },
      series: { unit: 'day', points: regSeries.rows },
      top_customers: await topCustomers(completedWhere, 'revenue'),
      newest: newest.rows,
    };
  },

  // Doanh thu: so với kỳ trước cùng độ dài, theo giờ/ngày, theo loại xe, top tài xế / khách hàng
  async revenue(period) {
    const where = `t.status = 'completed' AND ${inPeriod('t.completed_at', period)}`;
    const prevSql = period === 'all' ? 'NULL'
      : `(SELECT COALESCE(sum(fare), 0) FROM trips WHERE status = 'completed' AND ${inPrevPeriod('completed_at', period)})`;
    const { rows: [s] } = await pool.query(
      `SELECT COALESCE(sum(fare), 0)::bigint AS revenue, count(*)::int AS trips, avg(fare) AS avg_fare,
              ${prevSql}::bigint AS prev_revenue
         FROM trips t WHERE ${where}`,
    );
    return {
      summary: { ...s, revenue: Number(s.revenue), prev_revenue: s.prev_revenue === null ? null : Number(s.prev_revenue) },
      series: await series('completed_at', `t.status = 'completed'`, period, 'COALESCE(sum(t.fare), 0)'),
      by_vehicle: await byVehicle(where),
      top_drivers: await topDrivers(where, 'revenue'),
      top_customers: await topCustomers(where, 'revenue'),
    };
  },
};

router.get('/stats/detail/:metric', requireRole(...STAFF_ROLES), wrap(async (req, res) => {
  const metric = req.params.metric;
  if (!Object.hasOwn(METRICS, metric)) throw new HttpError(404, 'Không có thống kê này');
  const period = req.query.period ? requireEnum(req.query.period, PERIODS, 'period') : 'all';
  res.json({ metric, period, generated_at: new Date().toISOString(), ...(await METRICS[metric](period)) });
}));

module.exports = { router, TZ };
