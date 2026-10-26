const path = require('path');
const express = require('express');
const { pool } = require('./db');
const metrics = require('./metrics');
const log = require('./logger');
const { HttpError } = require('./validate');
const auth = require('./auth');
const staff = require('./staff');
const driverApply = require('./driver-apply');
const driverMode = require('./driver-mode');
const profile = require('./profile');
const stats = require('./stats');
const { router, TRIP_STATUSES, DRIVER_STATUSES } = require('./routes');

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal'); // tin header X-Forwarded-For từ Nginx trong mạng nội bộ
app.use(express.json({ limit: '20kb' }));

// Ghi log + metrics cho mọi request
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route ? req.baseUrl + req.route.path : (res.statusCode === 404 ? 'not_found' : req.path);
    if (route === '/metrics' || route === '/healthz') return;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    metrics.httpRequests.inc(labels);
    metrics.httpDuration.observe(labels, seconds);
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level]('request', {
      method: req.method,
      path: req.originalUrl,
      route,
      status: res.statusCode,
      duration_ms: Math.round(seconds * 1000),
      ip: req.ip,
    });
  });
  next();
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'db_unavailable' });
  }
});

// Endpoint metrics: Nginx KHÔNG public đường dẫn này ra Internet (xem nginx/conf.d)
app.get('/metrics', async (req, res) => {
  try {
    const [trips, drivers] = await Promise.all([
      pool.query('SELECT status, COUNT(*)::int AS n FROM trips GROUP BY status'),
      pool.query('SELECT status, COUNT(*)::int AS n FROM drivers GROUP BY status'),
    ]);
    TRIP_STATUSES.forEach((s) => metrics.tripsByStatus.set({ status: s }, 0));
    DRIVER_STATUSES.forEach((s) => metrics.driversByStatus.set({ status: s }, 0));
    trips.rows.forEach((r) => metrics.tripsByStatus.set({ status: r.status }, r.n));
    drivers.rows.forEach((r) => metrics.driversByStatus.set({ status: r.status }, r.n));
  } catch (err) {
    log.warn('metrics_db_error', { error: err.message });
  }
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

app.use('/api/auth', auth.router);
app.use('/api/admin', auth.authenticate, staff.router);
app.use('/api', auth.authenticate, profile.router, driverApply.router, driverMode.router, stats.router, router);
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy API' }));

// Xử lý lỗi tập trung: không trả stack trace cho client
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON không hợp lệ' });
  log.error('unhandled_error', { error: err.message, code: err.code, path: req.originalUrl });
  return res.status(500).json({ error: 'Lỗi hệ thống, vui lòng thử lại sau' });
});

const server = app.listen(PORT, () => {
  log.info('server_started', { port: PORT });
  auth.ensureAdmin();
});

function shutdown(signal) {
  log.info('server_stopping', { signal });
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
