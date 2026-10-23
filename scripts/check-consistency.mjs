// Kiểm tra số liệu có khớp nhau giữa mọi mục / chức năng (qua REST API thật, đi qua Nginx).
//   Phần A: so khớp chéo - cùng một số liệu lấy từ mọi nơi nó xuất hiện phải bằng nhau.
//   Phần B: thực hiện từng thao tác thật và kiểm tra mọi mục liên quan thay đổi đúng ±1 (hoặc ± tiền cước).
// Cách chạy (cần có dữ liệu demo: sh scripts/seed-demo.sh):
//   node scripts/check-consistency.mjs            chỉ kiểm tra (phần A), không thay đổi dữ liệu
//   node scripts/check-consistency.mjs --actions  kiểm tra cả phần B (tạo dữ liệu thử có SĐT 0399xxxxxx
//                                                 -> xóa sạch bằng: sh scripts/seed-demo.sh --reset)
// Biến môi trường: BASE_URL (mặc định https://localhost), CHECK_USER / CHECK_PASS (mặc định dieuphoi01 / demo1234)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // chứng chỉ tự ký của môi trường demo

const BASE = process.env.BASE_URL || 'https://localhost';
const STAFF = [process.env.CHECK_USER || 'dieuphoi01', process.env.CHECK_PASS || 'demo1234'];
const WITH_ACTIONS = process.argv.includes('--actions');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + Number(f(x) || 0), 0);

class Client {
  constructor() { this.cookie = ''; }

  async req(method, path, body) {
    await sleep(70); // tôn trọng giới hạn 20 request/giây của Nginx
    const res = await fetch(BASE + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error || ''}`);
    return { data, total: Number(res.headers.get('x-total-count')) };
  }

  get(path) { return this.req('GET', path).then((r) => r.data); }

  post(path, body) { return this.req('POST', path, body || {}).then((r) => r.data); }
}

// ---------- Lấy toàn bộ số liệu đang hiển thị ở mọi nơi ----------
async function snapshot(c) {
  const s = { stats: await c.get('/stats'), d: {}, tripsTotal: {} };
  const details = [['waiting'], ['serving'], ['completed', 'all'], ['completed', 'today'], ['completed', '7d'],
    ['completed', '30d'], ['cancelled', 'all'], ['drivers', 'all'], ['customers', 'all'], ['revenue', 'all'],
    ['revenue', 'today'], ['revenue', '7d'], ['revenue', '30d']];
  for (const [m, p] of details) s.d[p ? `${m}:${p}` : m] = await c.get(`/stats/detail/${m}${p ? `?period=${p}` : ''}`);
  for (const st of ['', 'requested', 'assigned', 'in_progress', 'completed', 'cancelled']) {
    s.tripsTotal[st || 'all'] = (await c.req('GET', `/trips${st ? `?status=${st}` : ''}`)).total;
  }
  s.drivers = await c.get('/drivers');
  s.customers = await c.get('/customers');
  s.pending = await c.get('/driver-applications?status=pending');
  s.approved = await c.get('/driver-applications?status=approved');
  return s;
}

let failures = 0;
function check(name, values) {
  const vals = Object.values(values);
  const ok = vals.every((v) => v === vals[0]);
  if (!ok) failures += 1;
  const detail = Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ');
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? ` (${vals[0]})` : `\n      ${detail}`}`);
}

// ---------- Phần A: so khớp chéo ----------
function crossCheck(s) {
  const { stats, d, tripsTotal } = s;
  const t = stats.trips;
  const byStatus = (st) => s.drivers.filter((x) => x.status === st).length;
  const dAll = d['drivers:all'];

  check('Chờ tài xế', {
    'thẻ tổng quan': t.requested || 0,
    'chi tiết': d.waiting.summary.count,
    'cung-cầu (cộng theo loại xe)': sum(d.waiting.supply, (x) => x.waiting),
    'danh sách chuyến (lọc chờ)': tripsTotal.requested,
  });
  check('Đang phục vụ = tài xế đang chở khách', {
    'thẻ tổng quan': (t.assigned || 0) + (t.in_progress || 0),
    'chi tiết': d.serving.summary.count,
    'chi tiết (đón + chạy)': d.serving.summary.assigned + d.serving.summary.in_progress,
    'danh sách chuyến (lọc)': tripsTotal.assigned + tripsTotal.in_progress,
    'theo loại xe': sum(d.serving.by_vehicle, (x) => x.trips),
    'tài xế đang chở (tổng quan)': stats.drivers.on_trip || 0,
    'tài xế đang chở (chi tiết)': dAll.summary.on_trip,
    'tài xế đang chở (tab Tài xế)': byStatus('on_trip'),
  });
  check('Chuyến hoàn thành', {
    'thẻ tổng quan': t.completed || 0,
    'chi tiết hoàn thành': d['completed:all'].summary.count,
    'chi tiết doanh thu': d['revenue:all'].summary.trips,
    'danh sách chuyến (lọc)': tripsTotal.completed,
    'theo loại xe': sum(d['completed:all'].by_vehicle, (x) => x.trips),
    'tab Tài xế (cộng cột hoàn thành)': sum(s.drivers, (x) => x.completed_trips),
    'chi tiết tài xế (cộng từng người)': sum(dAll.drivers, (x) => x.trips),
  });
  check('Tổng doanh thu', {
    'chi tiết hoàn thành': d['completed:all'].summary.revenue,
    'chi tiết doanh thu': d['revenue:all'].summary.revenue,
    'doanh thu theo loại xe': sum(d['revenue:all'].by_vehicle, (x) => x.revenue),
    'cộng doanh thu từng tài xế': sum(dAll.drivers, (x) => x.revenue),
  });
  check('Doanh thu hôm nay', {
    'thẻ tổng quan': stats.revenueToday,
    'chi tiết doanh thu': d['revenue:today'].summary.revenue,
    'cộng theo từng giờ': sum(d['revenue:today'].series.points, (x) => x.value),
  });
  check('Chuyến hoàn thành hôm nay', {
    'thẻ tổng quan': stats.completedToday,
    'chi tiết doanh thu': d['revenue:today'].summary.trips,
    'chi tiết hoàn thành': d['completed:today'].summary.count,
    'cộng theo từng giờ': sum(d['completed:today'].series.points, (x) => x.value),
  });
  for (const p of ['7d', '30d']) {
    check(`Doanh thu ${p} = cộng biểu đồ theo ngày`, {
      'tổng': d[`revenue:${p}`].summary.revenue, 'biểu đồ': sum(d[`revenue:${p}`].series.points, (x) => x.value),
    });
    check(`Chuyến hoàn thành ${p} = cộng biểu đồ theo ngày`, {
      'tổng': d[`completed:${p}`].summary.count, 'biểu đồ': sum(d[`completed:${p}`].series.points, (x) => x.value),
      'chi tiết doanh thu': d[`revenue:${p}`].summary.trips,
    });
  }
  const cAll = d['cancelled:all'].summary;
  check('Chuyến bị hủy', {
    'thẻ tổng quan': t.cancelled || 0,
    'chi tiết': cAll.count,
    'trước + sau khi có tài xế': cAll.before_assign + cAll.after_assign,
    'danh sách chuyến (lọc)': tripsTotal.cancelled,
  });
  check('Tỉ lệ hủy = hủy / (hủy + hoàn thành)', {
    'chi tiết': cAll.cancel_rate.toFixed(6), 'tự tính': (cAll.count / (cAll.count + (t.completed || 0))).toFixed(6),
  });
  check('Tổng số tài xế', {
    'thẻ tổng quan (dòng phụ)': stats.driversTotal,
    'chi tiết tài xế': dAll.summary.total,
    'tab Tài xế': s.drivers.length,
    'sẵn sàng + đang chở + nghỉ': dAll.summary.available + dAll.summary.on_trip + dAll.summary.offline,
    'bảng theo loại xe': sum(dAll.matrix, (x) => x.available + x.on_trip + x.offline),
  });
  check('Tài xế sẵn sàng', {
    'thẻ tổng quan': stats.drivers.available || 0,
    'chi tiết tài xế': dAll.summary.available,
    'tab Tài xế': byStatus('available'),
    'cung-cầu (cộng theo loại xe)': sum(d.waiting.supply, (x) => x.available),
  });
  check('Tài xế nghỉ', { 'tổng quan': stats.drivers.offline || 0, 'chi tiết': dAll.summary.offline, 'tab Tài xế': byStatus('offline') });
  check('Tổng khách hàng', {
    'thẻ tổng quan': stats.customers, 'chi tiết khách hàng': d['customers:all'].summary.total, 'tab Khách hàng': s.customers.length,
  });
  check('Khách có tài khoản', {
    'thẻ tổng quan (dòng phụ)': stats.customersWithAccount, 'chi tiết khách hàng': d['customers:all'].summary.with_account,
  });
  check('Tổng số chuyến', {
    'danh sách chuyến (tất cả)': tripsTotal.all,
    'cộng các trạng thái (tổng quan)': sum(Object.values(t)),
    'tab Khách hàng (cộng cột tổng chuyến)': sum(s.customers, (x) => x.trip_count),
  });
  check('Tài xế gắn tài khoản khách = hồ sơ đã duyệt', {
    'tài xế có tài khoản': s.drivers.filter((x) => x.user_id).length, 'hồ sơ đã duyệt': s.approved.length,
  });
}

// ---------- Phần B: thao tác thật và kiểm tra thay đổi ----------
// expect: { 'tên số liệu': [hàm lấy giá trị từ snapshot, mức thay đổi mong đợi] }
async function step(c, name, action, expect) {
  const before = await snapshot(c);
  const ctx = await action(before);
  const after = await snapshot(c);
  console.log(`\n▶ ${name}`);
  for (const [label, [get, delta]] of Object.entries(expect)) {
    const d = typeof delta === 'function' ? delta(ctx) : delta;
    const got = get(after, ctx) - get(before, ctx);
    const ok = got === d;
    if (!ok) failures += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${get(before, ctx)} → ${get(after, ctx)} (${got >= 0 ? '+' : ''}${got}${ok ? '' : `, mong đợi ${d >= 0 ? '+' : ''}${d}`})`);
  }
  return { ctx, after };
}

const M = { // các số liệu hay dùng
  waiting: (s) => s.stats.trips.requested || 0,
  serving: (s) => (s.stats.trips.assigned || 0) + (s.stats.trips.in_progress || 0),
  inProgress: (s) => s.stats.trips.in_progress || 0,
  completed: (s) => s.stats.trips.completed || 0,
  cancelled: (s) => s.stats.trips.cancelled || 0,
  cancelledBefore: (s) => s.d['cancelled:all'].summary.before_assign,
  driversTotal: (s) => s.stats.driversTotal,
  driversTab: (s) => s.drivers.length,
  available: (s) => s.stats.drivers.available || 0,
  offline: (s) => s.stats.drivers.offline || 0,
  onTrip: (s) => s.stats.drivers.on_trip || 0,
  customers: (s) => s.stats.customers,
  customersTab: (s) => s.customers.length,
  withAccount: (s) => s.stats.customersWithAccount,
  pending: (s) => s.pending.length,
  approved: (s) => s.approved.length,
  revenueToday: (s) => s.stats.revenueToday,
  completedToday: (s) => s.stats.completedToday,
  allTrips: (s) => s.tripsTotal.all,
};

async function actions(staff) {
  const rand = () => String(900000 + Math.floor(Math.random() * 99999));
  const cust = new Client();
  let approvedDriverId;

  await step(staff, 'Duyệt 1 hồ sơ đăng ký tài xế', async (b) => {
    const a = b.pending[0];
    if (!a) throw new Error('Không còn hồ sơ chờ duyệt - chạy sh scripts/seed-demo.sh --reset');
    const r = await staff.post(`/driver-applications/${a.id}/approve`);
    approvedDriverId = r.driver.id;
    return a;
  }, {
    'Hồ sơ chờ duyệt (chấm đỏ trên tab)': [M.pending, -1], 'Hồ sơ đã duyệt': [M.approved, +1],
    'Tổng tài xế (thẻ tổng quan)': [M.driversTotal, +1], 'Tổng tài xế (tab Tài xế)': [M.driversTab, +1],
    'Tài xế nghỉ': [M.offline, +1], 'Tài xế sẵn sàng': [M.available, 0], 'Tổng khách hàng': [M.customers, 0],
  });

  await step(staff, 'Bật nhận chuyến cho tài xế vừa được duyệt', async () => {
    await staff.req('PATCH', `/drivers/${approvedDriverId}/status`, { status: 'available' });
  }, { 'Tài xế sẵn sàng': [M.available, +1], 'Tài xế nghỉ': [M.offline, -1], 'Tổng tài xế': [M.driversTotal, 0] });

  await step(staff, 'Từ chối 1 hồ sơ', async (b) => {
    await staff.post(`/driver-applications/${b.pending[0].id}/reject`, { reason: 'Kiểm tra tự động' });
  }, { 'Hồ sơ chờ duyệt': [M.pending, -1], 'Tổng tài xế': [M.driversTotal, 0], 'Hồ sơ đã duyệt': [M.approved, 0] });

  const phone = `0399${rand()}`;
  await step(staff, 'Khách tự đăng ký tài khoản', async () => {
    await cust.post('/auth/register', {
      full_name: 'Khách Kiểm Tra', phone, username: `kiemtra${phone.slice(-6)}`, password: 'kiemtra123',
    });
  }, {
    'Tổng khách hàng (thẻ)': [M.customers, +1], 'Tổng khách hàng (tab)': [M.customersTab, +1],
    'Khách có tài khoản': [M.withAccount, +1],
  });

  await step(staff, 'Nhân viên thêm khách (không có tài khoản)', async () => {
    await staff.post('/customers', { full_name: 'Khách Gọi Tổng Đài', phone: `0399${rand()}` });
  }, { 'Tổng khách hàng': [M.customers, +1], 'Khách có tài khoản': [M.withAccount, 0] });

  const tripOf = (s, ctx) => s.customers.find((x) => x.phone === phone)?.trip_count || 0;
  const { ctx: trip } = await step(staff, 'Khách đặt xe', async () => cust.post('/trips', {
    pickup_address: 'ĐH Công nghệ Thông tin & TT', dropoff_address: 'Ga Thái Nguyên', vehicle_type: 'car4', distance_km: 6,
  }), {
    'Chờ tài xế': [M.waiting, +1], 'Tổng chuyến': [M.allTrips, +1], 'Số chuyến của khách (tab Khách hàng)': [tripOf, +1],
  });

  const { ctx: assigned } = await step(staff, 'Điều tài xế cho chuyến vừa đặt', async () => staff.post(`/trips/${trip.id}/assign`), {
    'Chờ tài xế': [M.waiting, -1], 'Đang phục vụ': [M.serving, +1], 'Tài xế sẵn sàng': [M.available, -1],
    'Tài xế đang chở': [M.onTrip, +1],
  });
  const driverDone = (s) => s.drivers.find((x) => x.id === assigned.driver_id)?.completed_trips || 0;

  await step(staff, 'Bắt đầu chạy', async () => staff.post(`/trips/${trip.id}/start`), {
    'Đang phục vụ': [M.serving, 0], 'Đang chạy': [M.inProgress, +1], 'Tài xế đang chở': [M.onTrip, 0],
  });

  await step(staff, 'Hoàn thành chuyến', async () => staff.post(`/trips/${trip.id}/complete`), {
    'Đang phục vụ': [M.serving, -1], 'Hoàn thành': [M.completed, +1], 'Hoàn thành hôm nay': [M.completedToday, +1],
    'Doanh thu hôm nay (+ giá cước)': [M.revenueToday, trip.fare], 'Tài xế sẵn sàng': [M.available, +1],
    'Tài xế đang chở': [M.onTrip, -1], 'Chuyến hoàn thành của tài xế đó (tab Tài xế)': [driverDone, +1],
  });

  const { ctx: trip2 } = await step(staff, 'Khách đặt chuyến thứ 2', async () => cust.post('/trips', {
    pickup_address: 'Chợ Thái', dropoff_address: 'Hồ Núi Cốc', vehicle_type: 'bike', distance_km: 15,
  }), { 'Chờ tài xế': [M.waiting, +1] });

  await step(staff, 'Khách tự hủy chuyến (chưa có tài xế)', async () => cust.post(`/trips/${trip2.id}/cancel`, { reason: 'Khách đổi ý' }), {
    'Chờ tài xế': [M.waiting, -1], 'Đã hủy': [M.cancelled, +1], 'Hủy khi chưa có tài xế': [M.cancelledBefore, +1],
    'Hoàn thành': [M.completed, 0], 'Doanh thu hôm nay': [M.revenueToday, 0],
  });
  await cust.post('/auth/logout');
}

const staff = new Client();
await staff.post('/auth/login', { username: STAFF[0], password: STAFF[1] });
console.log('\n=== A. So khớp chéo số liệu giữa các mục ===');
crossCheck(await snapshot(staff));
if (WITH_ACTIONS) {
  console.log('\n=== B. Thao tác thật - mọi mục liên quan phải thay đổi đúng ===');
  await actions(staff);
  console.log('\n=== A\'. So khớp chéo lại sau các thao tác ===');
  crossCheck(await snapshot(staff));
}
await staff.post('/auth/logout');
console.log(failures ? `\n✗ CÓ ${failures} CHỖ KHÔNG KHỚP` : '\n✓ TẤT CẢ SỐ LIỆU KHỚP NHAU');
process.exit(failures ? 1 : 0);
