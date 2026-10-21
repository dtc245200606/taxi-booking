// Metrics cho Prometheus (thư viện prom-client).
const client = require('prom-client');

const register = new client.Registry();
register.setDefaultLabels({ app: 'taxi-booking' });
client.collectDefaultMetrics({ register, prefix: 'taxi_' });

const httpRequests = new client.Counter({
  name: 'taxi_http_requests_total',
  help: 'Tổng số HTTP request theo method, route, status',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpDuration = new client.Histogram({
  name: 'taxi_http_request_duration_seconds',
  help: 'Thời gian xử lý HTTP request (giây)',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const tripsCreated = new client.Counter({
  name: 'taxi_trips_created_total',
  help: 'Số chuyến đi được đặt',
  labelNames: ['vehicle_type'],
  registers: [register],
});

const tripTransitions = new client.Counter({
  name: 'taxi_trip_status_transitions_total',
  help: 'Số lần chuyển trạng thái chuyến đi',
  labelNames: ['to_status'],
  registers: [register],
});

// Gauge được tính lại từ DB mỗi lần Prometheus scrape.
const tripsByStatus = new client.Gauge({
  name: 'taxi_trips_by_status',
  help: 'Số chuyến đi hiện có theo trạng thái',
  labelNames: ['status'],
  registers: [register],
});

const driversByStatus = new client.Gauge({
  name: 'taxi_drivers_by_status',
  help: 'Số tài xế theo trạng thái',
  labelNames: ['status'],
  registers: [register],
});

module.exports = {
  register,
  httpRequests,
  httpDuration,
  tripsCreated,
  tripTransitions,
  tripsByStatus,
  driversByStatus,
};
