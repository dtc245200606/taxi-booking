// Giao diện điều phối viên: gọi REST API /api/*
const STATUS_TEXT = {
  requested: 'Chờ tài xế', assigned: 'Đã nhận chuyến', in_progress: 'Đang chạy',
  completed: 'Hoàn thành', cancelled: 'Đã hủy',
  available: 'Sẵn sàng', on_trip: 'Đang chở khách', offline: 'Nghỉ',
};
const VEHICLE_TEXT = { bike: 'Xe máy', car4: 'Ô tô 4 chỗ', car7: 'Ô tô 7 chỗ' };

const $ = (sel) => document.querySelector(sel);
const money = (v) => Number(v || 0).toLocaleString('vi-VN') + ' đ';
const time = (v) => (v ? new Date(v).toLocaleString('vi-VN') : '');

// Tạo phần tử DOM an toàn (dùng textContent, không dùng innerHTML với dữ liệu người dùng -> chống XSS)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  children.flat().forEach((c) => {
    if (c === null || c === undefined) return;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return node;
}

const badge = (s) => el('span', { class: `badge s-${s}` }, STATUS_TEXT[s] || s);

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

function table(target, headers, rows) {
  const t = $(target);
  t.replaceChildren(
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.length
      ? rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c))))
      : el('tr', {}, el('td', { colspan: headers.length, class: 'muted' }, 'Chưa có dữ liệu'))),
  );
}

// ---------- Tổng quan ----------
async function loadDashboard() {
  const s = await api('/stats');
  const t = s.trips;
  const cards = [
    ['Chờ tài xế', t.requested || 0],
    ['Đang phục vụ', (t.assigned || 0) + (t.in_progress || 0)],
    ['Hoàn thành', t.completed || 0],
    ['Đã hủy', t.cancelled || 0],
    ['Tài xế sẵn sàng', s.drivers.available || 0],
    ['Khách hàng', s.customers],
    ['Doanh thu hôm nay', money(s.revenueToday)],
  ];
  $('#stat-cards').replaceChildren(...cards.map(([label, value]) =>
    el('div', { class: 'card' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value))));
  const trips = (await api('/trips')).slice(0, 8);
  table('#recent-trips', ['#', 'Khách hàng', 'Lộ trình', 'Tài xế', 'Giá', 'Trạng thái'],
    trips.map((x) => [x.id, x.customer_name, `${x.pickup_address} → ${x.dropoff_address}`,
      x.driver_name || '—', money(x.fare), badge(x.status)]));
}

// ---------- Chuyến đi ----------
function tripActions(x) {
  const act = (action, label, cls = '') => el('button', {
    class: `btn ${cls}`,
    onclick: async () => {
      try {
        const body = {};
        if (action === 'cancel') {
          const reason = prompt('Lý do hủy chuyến?', 'Khách đổi ý');
          if (reason === null) return;
          body.reason = reason;
        }
        await api(`/trips/${x.id}/${action}`, { method: 'POST', body });
        toast(`Chuyến #${x.id}: ${label} thành công`);
        loadTrips();
      } catch (e) { toast(e.message, true); }
    },
  }, label);
  switch (x.status) {
    case 'requested': return [act('assign', 'Điều tài xế'), act('cancel', 'Hủy', 'danger')];
    case 'assigned': return [act('start', 'Bắt đầu chạy'), act('cancel', 'Hủy', 'danger')];
    case 'in_progress': return [act('complete', 'Hoàn thành')];
    default: return [el('span', { class: 'muted' }, '—')];
  }
}

async function loadTrips() {
  const status = $('#trip-filter').value;
  const trips = await api('/trips' + (status ? `?status=${encodeURIComponent(status)}` : ''));
  table('#trip-table', ['#', 'Khách hàng', 'Lộ trình', 'Loại xe', 'Km', 'Giá', 'Tài xế', 'Thời gian đặt', 'Trạng thái', 'Thao tác'],
    trips.map((x) => [
      x.id,
      el('div', {}, x.customer_name, el('div', { class: 'muted' }, x.customer_phone)),
      el('div', {}, x.pickup_address, el('div', { class: 'muted' }, '→ ' + x.dropoff_address)),
      VEHICLE_TEXT[x.vehicle_type],
      x.distance_km,
      money(x.fare),
      x.driver_name ? el('div', {}, x.driver_name, el('div', { class: 'muted' }, x.license_plate)) : '—',
      time(x.requested_at),
      el('div', {}, badge(x.status), x.cancel_reason ? el('div', { class: 'muted' }, x.cancel_reason) : null),
      el('div', {}, tripActions(x)),
    ]));
}

async function loadCustomerOptions() {
  const customers = await api('/customers');
  $('#trip-form select[name=customer_id]').replaceChildren(
    ...customers.map((c) => el('option', { value: c.id }, `${c.full_name} (${c.phone})`)));
}

// ---------- Tài xế ----------
async function loadDrivers() {
  const drivers = await api('/drivers');
  table('#driver-table', ['#', 'Họ tên', 'SĐT', 'Biển số', 'Loại xe', 'Đánh giá', 'Chuyến hoàn thành', 'Trạng thái', 'Thao tác'],
    drivers.map((d) => [
      d.id, d.full_name, d.phone, d.license_plate, VEHICLE_TEXT[d.vehicle_type], `${d.rating} ★`,
      d.completed_trips, badge(d.status),
      d.status === 'on_trip' ? el('span', { class: 'muted' }, 'Đang chở khách') : el('button', {
        class: 'btn',
        onclick: async () => {
          try {
            const status = d.status === 'available' ? 'offline' : 'available';
            await api(`/drivers/${d.id}/status`, { method: 'PATCH', body: { status } });
            loadDrivers();
          } catch (e) { toast(e.message, true); }
        },
      }, d.status === 'available' ? 'Cho nghỉ' : 'Bật nhận chuyến'),
    ]));
}

// ---------- Khách hàng ----------
async function loadCustomers() {
  const customers = await api('/customers');
  table('#customer-table', ['#', 'Họ tên', 'SĐT', 'Email', 'Số chuyến', 'Ngày tạo'],
    customers.map((c) => [c.id, c.full_name, c.phone, c.email || '—', c.trip_count, time(c.created_at)]));
}

// ---------- Form ----------
function bindForm(selector, path, after) {
  $(selector).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      await api(path, { method: 'POST', body });
      toast('Lưu thành công');
      form.reset();
      after();
    } catch (err) { toast(err.message, true); }
  });
}

const LOADERS = {
  dashboard: loadDashboard,
  trips: () => Promise.all([loadCustomerOptions(), loadTrips()]),
  drivers: loadDrivers,
  customers: loadCustomers,
};

function showTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === name));
  LOADERS[name]().catch((e) => toast(e.message, true));
}

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#trip-filter').addEventListener('change', () => loadTrips().catch((e) => toast(e.message, true)));
bindForm('#trip-form', '/trips', loadTrips);
bindForm('#driver-form', '/drivers', loadDrivers);
bindForm('#customer-form', '/customers', loadCustomers);
showTab('dashboard');
