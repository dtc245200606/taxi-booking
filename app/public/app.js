// Giao diện đặt xe / điều phối: gọi REST API /api/*
const STATUS_TEXT = {
  requested: 'Chờ tài xế', assigned: 'Đã nhận chuyến', in_progress: 'Đang chạy',
  completed: 'Hoàn thành', cancelled: 'Đã hủy',
  available: 'Sẵn sàng', on_trip: 'Đang chở khách', offline: 'Nghỉ',
};
const VEHICLE_TEXT = { bike: '🛵 Xe máy', car4: '🚗 Ô tô 4 chỗ', car7: '🚙 Ô tô 7 chỗ' };
// Bảng giá giống server (src/routes.js) - chỉ để hiển thị giá ước tính, server vẫn tự tính lại
const FARE = { bike: [10000, 5000], car4: [20000, 12000], car7: [25000, 15000] };

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const money = (v) => Number(v || 0).toLocaleString('vi-VN') + ' đ';
const time = (v) => (v ? new Date(v).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '');
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(-2).map((w) => w[0]).join('').toUpperCase();

// Tạo phần tử DOM an toàn (dùng textContent, không dùng innerHTML với dữ liệu người dùng -> chống XSS)
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  });
  children.flat().forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return node;
}

const badge = (s) => el('span', { class: `badge s-${s}` }, STATUS_TEXT[s] || s);
const person = (name, sub) => el('div', { class: 'person' },
  el('span', { class: 'avatar sm' }, initials(name)),
  el('div', {}, el('span', { class: 'strong' }, name), sub ? el('span', { class: 'muted' }, sub) : null));
const route = (from, to) => el('div', { class: 'route' },
  el('span', { class: 'stop from' }, from), el('span', { class: 'stop to muted' }, to));

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // Phiên hết hạn / chưa đăng nhập -> quay về màn hình đăng nhập
  if (res.status === 401 && !path.startsWith('/auth/')) showAuth();
  if (res.status === 429) throw new Error('Thao tác quá nhanh, vui lòng thử lại sau ít phút');
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  // withTotal: trả kèm tổng số bản ghi thật (header X-Total-Count) khi danh sách bị giới hạn số dòng
  if (options.withTotal) return { data, total: Number(res.headers.get('X-Total-Count') || data.length) };
  return data;
}

// Bảng dữ liệu; mỗi ô có thể là chuỗi hoặc { v, cls } để thêm class
function table(target, headers, rows, emptyText = 'Chưa có dữ liệu') {
  const cell = (c) => (c && typeof c === 'object' && 'v' in c ? el('td', { class: c.cls }, c.v) : el('td', {}, c));
  $(target).replaceChildren(
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.length
      ? rows.map((r, i) => {
        const tr = el('tr', {}, r.map(cell));
        tr.style.animationDelay = `${Math.min(i, 12) * 18}ms`;
        return tr;
      })
      : el('tr', {}, el('td', { colspan: headers.length, class: 'empty' },
        el('span', { class: 'empty-icon' }, '🗂️'), emptyText))),
  );
}

// Khóa nút submit khi đang gửi để tránh bấm 2 lần.
// Lưu ý: e.currentTarget chỉ có giá trị trong lúc xử lý sự kiện - sau một lệnh await nó thành null,
// nên phải lấy nút (const btn = e.currentTarget) TRƯỚC khi await hộp thoại xác nhận.
async function withBusy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); } finally { if (button) button.disabled = false; }
}

// ---------- Đăng nhập / đăng ký ----------
let currentUser = null;
const ROLE_TEXT = { admin: 'Quản trị viên', dispatcher: 'Điều phối viên', customer: 'Khách hàng' };
const isStaff = () => currentUser && ['admin', 'dispatcher'].includes(currentUser.role);
const isAdmin = () => currentUser && currentUser.role === 'admin';

function showAuth() {
  currentUser = null;
  $$('dialog[open]').forEach((d) => d.close());
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  $$('.panel').forEach((p) => p.classList.remove('active'));
  if (!$('#force-form').classList.contains('hidden')) switchAuth('login');
}

function onLogin(user) {
  currentUser = user;
  // Mật khẩu tạm -> chặn ở màn hình đổi mật khẩu, chưa cho vào ứng dụng
  if (user.must_change_password) {
    $('#app').classList.add('hidden');
    $('#auth').classList.remove('hidden');
    switchAuth('force');
    return;
  }
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#user-name').textContent = user.full_name;
  $('#user-role').textContent = ROLE_TEXT[user.role];
  $('#user-avatar').textContent = initials(user.full_name);
  $('#menu-name').textContent = user.full_name;
  $('#menu-username').textContent = '@' + user.username;
  // Ẩn chức năng không thuộc vai trò; select bị disable sẽ không được gửi lên server
  $$('[data-role]').forEach((node) => {
    const allowed = node.dataset.role.split(' ').includes(user.role);
    node.classList.toggle('role-hidden', !allowed);
    node.querySelectorAll('select, input').forEach((f) => { f.disabled = !allowed; });
  });
  $('#trip-list-title').textContent = isStaff() ? 'Danh sách chuyến đi' : 'Chuyến đi của tôi';
  renderGreeting();
  $('#tabs').classList.toggle('hidden', !isStaff()); // khách hàng không cần thanh tab
  if (isStaff()) refreshPendingCount().catch(() => {});
  showTab(isStaff() ? 'dashboard' : 'trips');
}

const AUTH_TEXT = {
  login: ['Chào mừng trở lại 👋', 'Đăng nhập để đặt xe và theo dõi chuyến đi của bạn.'],
  register: ['Tạo tài khoản mới ✨', 'Chỉ mất một phút để bắt đầu đặt chuyến đầu tiên.'],
  force: ['Đặt mật khẩu mới 🔐', 'Bước bắt buộc trước khi sử dụng hệ thống.'],
  forgot: ['Quên mật khẩu? 🔑', 'Nhập email bạn đã đăng ký, chúng tôi sẽ gửi liên kết đặt lại mật khẩu.'],
  reset: ['Đặt mật khẩu mới 🔐', 'Chọn mật khẩu mới cho tài khoản của bạn.'],
};
const AUTH_FORMS = ['login', 'register', 'force', 'forgot', 'reset'];

function switchAuth(mode) {
  $$('[data-auth]').forEach((b) => b.classList.toggle('active', b.dataset.auth === mode));
  $('.segmented').dataset.mode = mode;
  $('.segmented').classList.toggle('hidden', !['login', 'register'].includes(mode));
  AUTH_FORMS.forEach((m) => $(`#${m}-form`).classList.toggle('hidden', m !== mode));
  if (mode === 'forgot') $('#forgot-sent').classList.add('hidden');
  [$('#auth-title').textContent, $('#auth-sub').textContent] = AUTH_TEXT[mode];
  const first = $(`#${mode}-form input`);
  if (first) first.focus();
}

// ---------- Hộp thoại ----------
// Hộp thoại xác nhận chung; trả về true nếu người dùng bấm xác nhận
function confirmDialog(title, message, okLabel = 'Xác nhận', danger = false) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  const ok = $('#confirm-ok');
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'danger-solid' : 'primary'}`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true }));
}

function showTempPassword(title, desc, password) {
  $('#temp-title').textContent = title;
  $('#temp-desc').textContent = desc;
  $('#temp-password').textContent = password;
  $('#temp-copy').textContent = 'Sao chép';
  $('#temp-dialog').showModal();
}

// ---------- Tổng quan ----------
async function loadDashboard() {
  const [s, trips] = await Promise.all([api('/stats'), api('/trips')]);
  const t = s.trips;
  // Dòng phụ ghi rõ phạm vi của từng số (ngay lúc này / từ trước tới nay / hôm nay) để không bị so lệch
  const cards = [
    ['Chờ tài xế', t.requested || 0, '⏳', 'orange', 'waiting', 'ngay lúc này'],
    ['Đang phục vụ', (t.assigned || 0) + (t.in_progress || 0), '🚖', 'violet', 'serving',
      `${t.assigned || 0} đang đón · ${t.in_progress || 0} đang chạy`],
    ['Hoàn thành', t.completed || 0, '✅', 'green', 'completed', 'từ trước tới nay'],
    ['Đã hủy', t.cancelled || 0, '✖️', 'gray', 'cancelled', 'từ trước tới nay'],
    ['Tài xế sẵn sàng', s.drivers.available || 0, '🧑‍✈️', 'blue', 'drivers', `trên tổng ${s.driversTotal} tài xế`],
    ['Khách hàng', s.customers, '👥', 'amber', 'customers', `${s.customersWithAccount} có tài khoản`],
    ['Doanh thu hôm nay', money(s.revenueToday), '💰', 'amber highlight', 'revenue', `${s.completedToday} chuyến hoàn thành hôm nay`],
  ];
  $('#stat-cards').replaceChildren(...cards.map(([label, value, icon, tone, metric, sub], i) => {
    const card = el('div', {
      class: `stat clickable tone-${tone.split(' ')[0]} ${tone.includes('highlight') ? 'highlight' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${label}: ${value}. Xem thống kê chi tiết`,
      onclick: () => openDetail(metric),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(metric); } },
    },
    el('div', { class: 'stat-icon' }, icon),
    el('div', {}, el('div', { class: 'stat-label' }, label), el('div', { class: 'stat-value' }, value),
      el('div', { class: 'stat-sub' }, sub)));
    card.style.animationDelay = `${i * 40}ms`;
    return card;
  }));
  table('#recent-trips', ['#', 'Khách hàng', 'Lộ trình', 'Tài xế', 'Giá', 'Trạng thái'],
    trips.slice(0, 8).map((x) => [
      { v: `#${x.id}`, cls: 'id' }, person(x.customer_name), route(x.pickup_address, x.dropoff_address),
      x.driver_name || el('span', { class: 'muted' }, 'Chưa có'), { v: money(x.fare), cls: 'num strong' }, badge(x.status),
    ]), 'Chưa có chuyến đi nào');
}

// ---------- Thống kê chi tiết (bấm vào thẻ số liệu) ----------
const DETAIL = {
  waiting: { title: 'Chờ tài xế', icon: '⏳', sub: 'Khách đang chờ và lượng tài xế rảnh theo loại xe' },
  serving: { title: 'Đang phục vụ', icon: '🚖', sub: 'Các chuyến đã có tài xế, đang đón hoặc đang chạy' },
  completed: { title: 'Chuyến hoàn thành', icon: '✅', sub: 'Hiệu suất, tài xế và khách hàng nổi bật', period: 'all' },
  cancelled: { title: 'Chuyến bị hủy', icon: '✖️', sub: 'Tỉ lệ hủy, lý do và đối tượng liên quan', period: 'all' },
  drivers: { title: 'Tài xế', icon: '🧑‍✈️', sub: 'Trạng thái và hiệu suất từng tài xế', period: 'today' },
  customers: { title: 'Khách hàng', icon: '👥', sub: 'Tăng trưởng, mức độ hoạt động và chi tiêu', period: '30d' },
  revenue: { title: 'Doanh thu', icon: '💰', sub: 'Doanh thu theo thời gian, loại xe, tài xế và khách hàng', period: 'today' },
};
const PERIOD_TEXT = { today: 'hôm nay', '7d': '7 ngày qua', '30d': '30 ngày qua', all: 'toàn bộ' };
const PREV_TEXT = { today: 'hôm qua', '7d': '7 ngày trước đó', '30d': '30 ngày trước đó' };
let detailState = { metric: null, period: null };

const num = (v) => Number(v || 0).toLocaleString('vi-VN');
const dec = (v, d = 1) => Number(v || 0).toLocaleString('vi-VN', { maximumFractionDigits: d });
const pct = (v) => `${dec(Number(v || 0) * 100)}%`;
const compactMoney = (v) => (v >= 1e6 ? `${dec(v / 1e6)}tr` : v >= 1e3 ? `${dec(v / 1e3, 0)}k` : String(v));
function minutes(m) {
  const v = Math.round(Number(m || 0));
  if (v < 60) return `${v} phút`;
  return `${Math.floor(v / 60)} giờ ${v % 60} phút`;
}

const kpis = (items) => el('div', { class: 'kpis' }, items.map(([label, value, sub]) => el('div', { class: 'kpi' },
  el('div', { class: 'kpi-label' }, label), el('div', { class: 'kpi-value' }, value),
  sub ? el('div', { class: 'kpi-sub' }, sub) : null)));
const section = (title, note, ...children) => el('div', { class: 'detail-section' },
  el('h3', {}, title, note ? el('small', {}, note) : null), ...children);
const rank = (i) => el('span', { class: `rank ${i === 0 ? 'r1' : ''}` }, i + 1);

// Bảng gọn dùng trong hộp thoại chi tiết
function miniTable(headers, rows, empty = 'Không có dữ liệu') {
  const cell = (c) => (c && typeof c === 'object' && 'v' in c ? el('td', { class: c.cls }, c.v) : el('td', {}, c));
  return el('div', { class: 'table-wrap' }, el('table', { class: 'grid' },
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.length ? rows.map((r) => el('tr', {}, r.map(cell)))
      : el('tr', {}, el('td', { colspan: headers.length, class: 'empty' }, empty)))));
}

// Thanh ngang một màu: nhãn - thanh - giá trị (giá trị luôn hiện bằng chữ, không phụ thuộc màu)
function hbars(items, format = num) {
  const max = Math.max(1, ...items.map((x) => x.value));
  const wrap = el('div', { class: 'hbars' }, items.length ? items.map((x) => {
    const fill = el('div', { class: 'hbar-fill' });
    fill.dataset.w = `${(x.value / max) * 100}%`;
    return el('div', { class: 'hbar' }, el('span', { class: 'hbar-label', title: x.label }, x.label),
      el('div', { class: 'hbar-track' }, fill), el('span', { class: 'hbar-value' }, format(x.value)));
  }) : el('p', { class: 'muted' }, 'Không có dữ liệu'));
  requestAnimationFrame(() => wrap.querySelectorAll('.hbar-fill').forEach((f) => { f.style.width = f.dataset.w; }));
  return wrap;
}

// Biểu đồ cột SVG một chuỗi: trục y 4 vạch, tooltip khi rê chuột, vùng rê chuột rộng hơn cột
function barChart(series, format = num, label = 'Số chuyến') {
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    return n;
  };
  const wrap = el('div', { class: 'chart' });
  const tip = el('div', { class: 'chart-tip' });
  const pts = series.points;
  const bucketText = (b) => (series.unit === 'hour' ? `${b}h – ${b + 1}h`
    : new Date(`${b}T00:00:00`).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' }));
  const tickText = (b) => (series.unit === 'hour' ? `${b}h` : `${b.slice(8, 10)}/${b.slice(5, 7)}`);

  const draw = () => {
    const W = Math.max(320, wrap.clientWidth - 24);
    const H = 210;
    const m = { l: 46, r: 6, t: 12, b: 24 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    // Bước chia trục y "đẹp" (4 khoảng); số chuyến / số khách thì bước phải là số nguyên
    const raw = Math.max(1, ...pts.map((p) => p.value));
    const rawStep = raw / 4;
    const mag = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((k) => k * mag)
      .filter((v) => format === money || Number.isInteger(v))
      .find((v) => v >= rawStep) || Math.ceil(rawStep);
    const niceMax = step * 4;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': `Biểu đồ ${label}` });
    for (let i = 0; i <= 4; i += 1) { // lưới + nhãn trục y
      const y = m.t + ph - (ph * i) / 4;
      svg.append(svgEl('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: y, y2: y }));
      const t = svgEl('text', { class: 'axis-text', x: m.l - 8, y: y + 4, 'text-anchor': 'end' });
      t.textContent = format === money ? compactMoney((niceMax * i) / 4) : dec((niceMax * i) / 4, 1);
      svg.append(t);
    }
    const band = pw / pts.length;
    const bw = Math.max(2, band - 2); // khe 2px giữa các cột
    // Số nhãn trục x vừa với chiều rộng (mỗi nhãn ~44px) để không chồng nhau trên điện thoại
    const fit = Math.max(2, Math.floor(pw / 44));
    const every = series.unit === 'hour' ? Math.max(3, Math.ceil(24 / fit)) : Math.ceil(pts.length / fit);
    pts.forEach((p, i) => {
      const x = m.l + i * band + (band - bw) / 2;
      const h = (p.value / niceMax) * ph;
      const y = m.t + ph - h;
      const r = Math.min(4, bw / 2, h);
      const hit = svgEl('rect', { class: 'hit', x: m.l + i * band, y: m.t, width: band, height: ph });
      // Cột bo tròn 4px ở đầu, đáy vuông bám trục
      const bar = svgEl('path', {
        class: 'bar',
        d: h <= 0 ? '' : `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + h} Z`,
      });
      hit.addEventListener('mouseenter', () => {
        tip.replaceChildren(el('span', {}, bucketText(p.bucket)), el('strong', {}, `${label}: ${format(p.value)}`));
        tip.style.left = `${((x + bw / 2) / W) * 100}%`;
        tip.style.top = `${y + 4}px`;
        tip.classList.add('show');
        bar.classList.add('on');
      });
      hit.addEventListener('mouseleave', () => { tip.classList.remove('show'); bar.classList.remove('on'); });
      svg.append(hit, bar);
      if (i % every === 0) {
        const t = svgEl('text', { class: 'axis-text', x: m.l + i * band + band / 2, y: H - 6, 'text-anchor': 'middle' });
        t.textContent = tickText(p.bucket);
        svg.append(t);
      }
    });
    wrap.replaceChildren(svg, tip);
  };
  requestAnimationFrame(draw); // vẽ sau khi đã gắn vào hộp thoại để đo được chiều rộng
  return wrap;
}

function deltaText(cur, prev, period) {
  if (prev === null || prev === undefined || !PREV_TEXT[period]) return null;
  if (!prev) return cur ? `${PREV_TEXT[period]}: 0 đ` : null;
  const d = (cur - prev) / prev;
  return el('span', {}, el('span', { class: d >= 0 ? 'delta-up' : 'delta-down' }, `${d >= 0 ? '▲' : '▼'} ${pct(Math.abs(d))}`),
    ` so với ${PREV_TEXT[period]}`);
}

const driverCell = (d) => el('div', {}, el('div', { class: 'strong' }, d.full_name),
  el('span', { class: 'muted' }, `${VEHICLE_TEXT[d.vehicle_type]} · ${d.license_plate}`));
// Tên cột phải đúng nghĩa của số liệu: chuyến hoàn thành + doanh thu thật, hoặc chuyến bị hủy + giá trị bị hủy
const COMPLETED_COLS = ['Chuyến hoàn thành', 'Doanh thu'];
const CUSTOMER_COLS = ['Chuyến hoàn thành', 'Đã chi'];
const CANCELLED_COLS = ['Chuyến bị hủy', 'Giá trị bị hủy'];
const topDriversTable = (rows, mode = 'trips', cols = COMPLETED_COLS) => miniTable(['#', 'Tài xế', ...cols],
  rows.map((d, i) => [rank(i), driverCell(d), { v: num(d.trips), cls: `num ${mode === 'trips' ? 'strong' : ''}` },
    { v: money(d.revenue), cls: `num ${mode === 'revenue' ? 'strong' : ''}` }]));
const topCustomersTable = (rows, mode = 'trips', cols = CUSTOMER_COLS) => miniTable(['#', 'Khách hàng', ...cols],
  rows.map((c, i) => [rank(i), person(c.full_name, c.phone), { v: num(c.trips), cls: `num ${mode === 'trips' ? 'strong' : ''}` },
    { v: money(c.spend), cls: `num ${mode === 'spend' ? 'strong' : ''}` }]));
const vehicleBars = (rows, key, format) => hbars(rows.map((r) => ({ label: VEHICLE_TEXT[r.vehicle_type], value: Number(r[key]) })), format);
const sinceText = (t) => minutes((Date.now() - new Date(t)) / 60000);

const RENDER = {
  waiting: (d) => [
    kpis([['Khách đang chờ', num(d.summary.count)], ['Thời gian chờ trung bình', minutes(d.summary.avg_wait_min)],
      ['Chờ lâu nhất', minutes(d.summary.max_wait_min)]]),
    section('Cung - cầu theo loại xe', 'khách chờ so với tài xế đang rảnh', miniTable(
      ['Loại xe', 'Khách đang chờ', 'Tài xế rảnh', 'Tài xế đang chở', 'Đánh giá'],
      d.supply.map((s) => [VEHICLE_TEXT[s.vehicle_type], { v: num(s.waiting), cls: 'num strong' }, { v: num(s.available), cls: 'num' },
        { v: num(s.on_trip), cls: 'num' },
        s.waiting > s.available ? el('span', { class: 'badge s-locked' }, `Thiếu ${s.waiting - s.available} tài xế`)
          : el('span', { class: 'badge s-active' }, 'Đủ tài xế')]))),
    section('Danh sách khách đang chờ', 'chờ lâu nhất ở trên', miniTable(['#', 'Khách hàng', 'Lộ trình', 'Loại xe', 'Giá', 'Đã chờ'],
      d.trips.map((x) => {
        const w = (Date.now() - new Date(x.requested_at)) / 60000;
        return [{ v: `#${x.id}`, cls: 'id' }, person(x.customer_name, x.customer_phone), route(x.pickup_address, x.dropoff_address),
          { v: VEHICLE_TEXT[x.vehicle_type], cls: 'num' }, { v: money(x.fare), cls: 'num' },
          w > 10 ? el('span', { class: 'badge s-pending' }, `⚠ ${minutes(w)}`) : { v: minutes(w), cls: 'num' }];
      }), 'Không có khách nào đang chờ 🎉')),
  ],

  serving: (d) => [
    kpis([['Đang phục vụ', num(d.summary.count)], ['Đã nhận, đang đến đón', num(d.summary.assigned)],
      ['Đang chở khách', num(d.summary.in_progress)], ['Doanh thu dự kiến', money(d.summary.revenue_pending)]]),
    section('Theo loại xe', null, vehicleBars(d.by_vehicle, 'trips', num)),
    section('Chi tiết từng chuyến', null, miniTable(['#', 'Khách hàng', 'Tài xế', 'Lộ trình', 'Trạng thái', 'Thời gian'],
      d.trips.map((x) => [{ v: `#${x.id}`, cls: 'id' }, person(x.customer_name, x.customer_phone),
        el('div', {}, el('div', { class: 'strong' }, x.driver_name), el('span', { class: 'plate' }, x.license_plate)),
        route(x.pickup_address, x.dropoff_address), badge(x.status),
        { v: x.status === 'in_progress' ? `Chạy ${sinceText(x.started_at)}` : `Nhận ${sinceText(x.assigned_at)} trước`, cls: 'num muted' }]),
      'Không có chuyến nào đang phục vụ')),
  ],

  completed: (d, p) => [
    kpis([['Chuyến hoàn thành', num(d.summary.count)], ['Doanh thu', money(d.summary.revenue)],
      ['Giá trung bình', money(Math.round(d.summary.avg_fare || 0))], ['Quãng đường trung bình', `${dec(d.summary.avg_km)} km`],
      ['Thời gian chạy trung bình', minutes(d.summary.avg_duration_min)], ['Chờ nhận chuyến trung bình', minutes(d.summary.avg_assign_min)],
      ['Khách được phục vụ', num(d.summary.customers)], ['Tài xế tham gia', num(d.summary.drivers)]]),
    section(`Số chuyến hoàn thành ${p === 'today' ? 'theo giờ' : 'theo ngày'}`, PERIOD_TEXT[p], barChart(d.series, num, 'Hoàn thành')),
    section('Theo loại xe', 'số chuyến', vehicleBars(d.by_vehicle, 'trips', num)),
    el('div', { class: 'detail-cols' },
      section('Tài xế chạy nhiều nhất', null, topDriversTable(d.top_drivers, 'trips')),
      section('Khách đi nhiều nhất', null, topCustomersTable(d.top_customers, 'trips'))),
  ],

  cancelled: (d, p) => [
    kpis([['Chuyến bị hủy', num(d.summary.count)], ['Tỉ lệ hủy', pct(d.summary.cancel_rate), 'trên tổng chuyến đã kết thúc'],
      ['Hủy khi chưa có tài xế', num(d.summary.before_assign)], ['Hủy sau khi giao tài xế', num(d.summary.after_assign)],
      ['Doanh thu bị mất', money(d.summary.lost_revenue)]]),
    section(`Số chuyến bị hủy ${p === 'today' ? 'theo giờ' : 'theo ngày'}`, PERIOD_TEXT[p], barChart(d.series, num, 'Bị hủy')),
    el('div', { class: 'detail-cols' },
      section('Lý do hủy', null, hbars(d.reasons.map((r) => ({ label: r.reason, value: r.count })), num)),
      section('Khách hủy nhiều nhất', null, topCustomersTable(d.top_customers, 'trips', CANCELLED_COLS))),
    section('Tài xế có chuyến bị hủy sau khi đã nhận', null, topDriversTable(d.top_drivers, 'trips', CANCELLED_COLS)),
    section('Chuyến hủy gần đây', null, miniTable(['#', 'Khách hàng', 'Tài xế', 'Lộ trình', 'Lý do', 'Lúc hủy'],
      d.recent.map((x) => [{ v: `#${x.id}`, cls: 'id' }, person(x.customer_name, x.customer_phone),
        x.driver_name || el('span', { class: 'muted' }, 'Chưa có'), route(x.pickup_address, x.dropoff_address),
        x.cancel_reason || '—', { v: time(x.cancelled_at), cls: 'num muted' }]))),
  ],

  drivers: (d, p) => [
    kpis([['Tổng tài xế', num(d.summary.total)], ['Sẵn sàng', num(d.summary.available)], ['Đang chở khách', num(d.summary.on_trip)],
      ['Nghỉ', num(d.summary.offline)], ['Đánh giá trung bình', `★ ${dec(d.summary.avg_rating, 2)}`],
      ['Tỉ lệ đang chở', pct(d.summary.utilization), 'trên số tài xế đang làm việc']]),
    section('Trạng thái theo loại xe', null, miniTable(['Loại xe', 'Sẵn sàng', 'Đang chở khách', 'Nghỉ'],
      d.matrix.map((r) => [VEHICLE_TEXT[r.vehicle_type], { v: num(r.available), cls: 'num strong' },
        { v: num(r.on_trip), cls: 'num' }, { v: num(r.offline), cls: 'num' }]))),
    section('Hiệu suất từng tài xế', PERIOD_TEXT[p], miniTable(
      ['Tài xế', 'Trạng thái', 'Đánh giá', 'Chuyến', 'Doanh thu', 'Bị hủy', 'Chuyến gần nhất'],
      d.drivers.map((x) => [driverCell(x), badge(x.status), el('span', { class: 'rating' }, `★ ${x.rating}`),
        { v: num(x.trips), cls: 'num strong' }, { v: money(x.revenue), cls: 'num' }, { v: num(x.cancelled), cls: 'num' },
        { v: x.last_trip_at ? time(x.last_trip_at) : '—', cls: 'num muted' }]))),
  ],

  customers: (d, p) => [
    kpis([['Tổng khách hàng', num(d.summary.total)], ['Có tài khoản', num(d.summary.with_account),
      pct(d.summary.with_account / Math.max(1, d.summary.total))],
      ['Khách mới', num(d.summary.new_customers), PERIOD_TEXT[p]], ['Khách có đặt xe', num(d.summary.active), PERIOD_TEXT[p]],
      ['Chi tiêu trung bình / khách', money(Math.round(d.summary.avg_spend)), PERIOD_TEXT[p]],
      ['Không đặt xe 30 ngày', num(d.summary.inactive_30d), 'cần chăm sóc lại']]),
    section('Khách đăng ký mới theo ngày', '30 ngày qua', barChart(d.series, num, 'Khách mới')),
    el('div', { class: 'detail-cols' },
      section('Khách chi tiêu nhiều nhất', PERIOD_TEXT[p], topCustomersTable(d.top_customers, 'spend')),
      section('Khách mới nhất', null, miniTable(['Khách hàng', 'Tài khoản', 'Tổng chuyến đã đặt', 'Ngày tạo'],
        d.newest.map((c) => [person(c.full_name, c.phone),
          c.has_account ? el('span', { class: 'badge s-active' }, 'Có') : el('span', { class: 'badge s-cancelled' }, 'Không'),
          { v: num(c.trips), cls: 'num' }, { v: time(c.created_at), cls: 'num muted' }])))),
  ],

  revenue: (d, p) => [
    kpis([['Doanh thu', money(d.summary.revenue), deltaText(d.summary.revenue, d.summary.prev_revenue, p)],
      ['Chuyến hoàn thành', num(d.summary.trips)], ['Giá trung bình / chuyến', money(Math.round(d.summary.avg_fare || 0))]]),
    section(`Doanh thu ${p === 'today' ? 'theo giờ' : 'theo ngày'}`, PERIOD_TEXT[p], barChart(d.series, money, 'Doanh thu')),
    section('Doanh thu theo loại xe', null, vehicleBars(d.by_vehicle, 'revenue', money)),
    el('div', { class: 'detail-cols' },
      section('Tài xế đem lại doanh thu cao nhất', null, topDriversTable(d.top_drivers, 'revenue')),
      section('Khách chi tiêu nhiều nhất', null, topCustomersTable(d.top_customers, 'spend'))),
  ],
};

async function loadDetail() {
  const { metric, period } = detailState;
  const body = $('#detail-body');
  body.classList.add('loading');
  try {
    const data = await api(`/stats/detail/${metric}${period ? `?period=${period}` : ''}`);
    body.replaceChildren(...RENDER[metric](data, period));
    $('#detail-sub').textContent = `${DETAIL[metric].sub} · cập nhật ${new Date(data.generated_at).toLocaleTimeString('vi-VN')}`;
  } catch (err) {
    body.replaceChildren(el('p', { class: 'muted' }, err.message));
  } finally {
    body.classList.remove('loading');
  }
}

function openDetail(metric) {
  const cfg = DETAIL[metric];
  detailState = { metric, period: cfg.period || null };
  $('#detail-icon').textContent = cfg.icon;
  $('#detail-title').textContent = cfg.title;
  $('#detail-sub').textContent = cfg.sub;
  $('#detail-period').classList.toggle('hidden', !cfg.period);
  $$('#detail-period .chip').forEach((c) => c.classList.toggle('active', c.dataset.period === cfg.period));
  $('#detail-body').replaceChildren();
  $('#detail-dialog').showModal();
  loadDetail();
}

$$('#detail-period .chip').forEach((chip) => chip.addEventListener('click', () => {
  detailState.period = chip.dataset.period;
  $$('#detail-period .chip').forEach((c) => c.classList.toggle('active', c === chip));
  loadDetail();
}));
// Đóng hộp thoại thì làm mới số liệu tổng quan
$('#detail-dialog').addEventListener('close', () => {
  if ($('#dashboard').classList.contains('active')) loadDashboard().catch(() => {});
});

// ---------- Chuyến đi ----------
let tripFilter = '';

// Hộp thoại nhập lý do hủy; trả về lý do, hoặc null nếu người dùng đóng
function askCancelReason(tripId) {
  const dlg = $('#cancel-dialog');
  $('#cancel-trip-id').textContent = `#${tripId}`;
  dlg.querySelector('input[name=reason]').value = 'Khách đổi ý';
  dlg.returnValue = ''; // nhấn Esc không đổi returnValue -> xóa giá trị của lần trước
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'confirm' ? dlg.querySelector('input[name=reason]').value : null);
    }, { once: true });
  });
}

function tripActions(x) {
  const act = (action, label, cls = '') => el('button', {
    class: `btn sm ${cls}`,
    onclick: async (e) => {
      const btn = e.currentTarget;
      const body = {};
      if (action === 'cancel') {
        const reason = await askCancelReason(x.id);
        if (reason === null) return;
        body.reason = reason;
      }
      try {
        await withBusy(btn, () => api(`/trips/${x.id}/${action}`, { method: 'POST', body }));
        toast(`Chuyến #${x.id}: ${label.toLowerCase()} thành công`);
        loadTrips();
      } catch (err) { toast(err.message, true); }
    },
  }, label);
  const none = el('span', { class: 'muted' }, '—');
  if (!isStaff()) {
    return ['requested', 'assigned'].includes(x.status) ? [act('cancel', 'Hủy chuyến', 'danger')] : [none];
  }
  switch (x.status) {
    case 'requested': return [act('assign', 'Điều tài xế', 'soft'), act('cancel', 'Hủy', 'danger')];
    case 'assigned': return [act('start', 'Bắt đầu chạy', 'soft'), act('cancel', 'Hủy', 'danger')];
    case 'in_progress': return [act('complete', 'Hoàn thành', 'soft')];
    default: return [none];
  }
}

async function loadTrips() {
  const { data: trips, total } = await api('/trips' + (tripFilter ? `?status=${encodeURIComponent(tripFilter)}` : ''),
    { withTotal: true });
  // Ghi rõ đang xem bao nhiêu trên tổng số để khớp với thẻ số liệu ở trang Tổng quan
  $('#trip-list-count').textContent = total > trips.length
    ? `${num(trips.length)} chuyến mới nhất / tổng ${num(total)}` : `${num(total)} chuyến`;
  const headers = ['#', 'Khách hàng', 'Lộ trình', 'Loại xe', 'Giá', 'Tài xế', 'Thời gian đặt', 'Trạng thái', 'Thao tác'];
  table('#trip-table', isStaff() ? headers : headers.filter((h) => h !== 'Khách hàng'),
    trips.map((x) => [
      { v: `#${x.id}`, cls: 'id' },
      isStaff() ? person(x.customer_name, x.customer_phone) : undefined,
      route(x.pickup_address, x.dropoff_address),
      { v: VEHICLE_TEXT[x.vehicle_type], cls: 'num' },
      el('div', { class: 'num' }, el('div', { class: 'strong' }, money(x.fare)),
        el('span', { class: 'muted' }, `${x.distance_km} km`)),
      x.driver_name
        ? el('div', {}, el('div', { class: 'strong' }, x.driver_name), el('span', { class: 'plate' }, x.license_plate))
        : el('span', { class: 'muted' }, 'Chưa có'),
      { v: time(x.requested_at), cls: 'num muted' },
      el('div', {}, badge(x.status), x.cancel_reason ? el('span', { class: 'muted reason' }, x.cancel_reason) : null),
      el('div', { class: 'actions' }, tripActions(x)),
    ].filter((c) => c !== undefined)),
    tripFilter ? 'Không có chuyến nào ở trạng thái này' : 'Chưa có chuyến đi nào. Hãy đặt chuyến đầu tiên!');
}

async function loadCustomerOptions() {
  const customers = await api('/customers');
  $('#trip-form select[name=customer_id]').replaceChildren(
    ...customers.map((c) => el('option', { value: c.id }, `${c.full_name} (${c.phone})`)));
}

function updateFare() {
  const form = $('#trip-form');
  const type = form.querySelector('input[name=vehicle_type]:checked')?.value;
  const km = Number(form.distance_km.value);
  const out = $('#fare-estimate');
  if (!FARE[type] || !(km > 0 && km <= 500)) { out.textContent = '—'; return; }
  const [base, perKm] = FARE[type];
  out.textContent = money(Math.round((base + perKm * km) / 1000) * 1000);
  out.classList.remove('bump');
  void out.offsetWidth; // khởi động lại animation
  out.classList.add('bump');
}

// ---------- Tài xế ----------
async function loadDrivers() {
  const drivers = await api('/drivers');
  table('#driver-table', ['#', 'Tài xế', 'Biển số', 'Loại xe', 'Đánh giá', 'Chuyến hoàn thành', 'Trạng thái', 'Thao tác'],
    drivers.map((d) => [
      { v: `#${d.id}`, cls: 'id' }, person(d.full_name, d.phone), el('span', { class: 'plate' }, d.license_plate),
      { v: VEHICLE_TEXT[d.vehicle_type], cls: 'num' }, el('span', { class: 'rating' }, `★ ${d.rating}`),
      { v: d.completed_trips, cls: 'num' }, badge(d.status),
      d.status === 'on_trip' ? el('span', { class: 'muted' }, 'Đang chở khách') : el('button', {
        class: `btn sm ${d.status === 'available' ? '' : 'soft'}`,
        onclick: async (e) => {
          try {
            const status = d.status === 'available' ? 'offline' : 'available';
            await withBusy(e.currentTarget, () => api(`/drivers/${d.id}/status`, { method: 'PATCH', body: { status } }));
            toast(`${d.full_name}: ${STATUS_TEXT[status].toLowerCase()}`);
            loadDrivers();
          } catch (err) { toast(err.message, true); }
        },
      }, d.status === 'available' ? 'Cho nghỉ' : 'Bật nhận chuyến'),
    ]));
}

// ---------- Khách hàng ----------
async function loadCustomers() {
  const customers = await api('/customers');
  table('#customer-table', ['#', 'Khách hàng', 'Email', 'Tổng chuyến đã đặt', 'Ngày tạo'],
    customers.map((c) => [
      { v: `#${c.id}`, cls: 'id' }, person(c.full_name, c.phone), c.email || el('span', { class: 'muted' }, '—'),
      { v: c.trip_count, cls: 'num strong' }, { v: time(c.created_at), cls: 'num muted' },
    ]));
}

// ---------- Đăng ký làm tài xế ----------
const APP_STATUS = {
  pending: ['s-pending', 'Chờ duyệt'],
  approved: ['s-active', 'Đã duyệt'],
  rejected: ['s-locked', 'Từ chối'],
  cancelled: ['s-cancelled', 'Đã rút'],
};
const appBadge = (s) => el('span', { class: `badge ${APP_STATUS[s][0]}` }, APP_STATUS[s][1]);
const dateOnly = (v) => (v ? new Date(v).toLocaleDateString('vi-VN') : '—');
function ageOf(dob) {
  const d = new Date(dob);
  const n = new Date();
  let a = n.getFullYear() - d.getFullYear();
  if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a -= 1;
  return a;
}
const CLASS_TEXT = {
  A1: 'A1 – xe máy đến 125 cm³',
  A: 'A – xe máy trên 125 cm³',
  A2: 'A2 – xe máy (mẫu cũ)',
  B: 'B – ô tô chở người đến 8 chỗ',
  C1: 'C1', C: 'C', D1: 'D1', D2: 'D2', D: 'D',
  B2: 'B2 (mẫu cũ)',
  E: 'E (mẫu cũ)',
};
let termsInfo = null;

// Hộp thoại nhập nội dung; trả về chuỗi đã nhập, hoặc null nếu đóng
function promptDialog(title, message, label, okLabel = 'Xác nhận') {
  const dlg = $('#prompt-dialog');
  $('#prompt-title').textContent = title;
  $('#prompt-message').textContent = message;
  $('#prompt-label').textContent = label;
  $('#prompt-ok').textContent = okLabel;
  const input = dlg.querySelector('textarea');
  input.value = '';
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    resolve(dlg.returnValue === 'confirm' && input.value.trim() ? input.value.trim() : null);
  }, { once: true }));
}

function updateLicenseOptions() {
  const form = $('#apply-form');
  const type = form.querySelector('input[name=vehicle_type]:checked').value;
  const classes = termsInfo.license_classes[type === 'bike' ? 'bike' : 'car'];
  const select = $('#license-class');
  const prev = select.value;
  select.replaceChildren(...classes.map((c) => el('option', { value: c }, CLASS_TEXT[c] || c)));
  if (classes.includes(prev)) select.value = prev;
  updateExpiryField();
}

function updateExpiryField() {
  const cls = $('#license-class').value;
  const noExpiry = termsInfo.no_expiry.includes(cls);
  const input = $('#apply-form input[name=license_expires_on]');
  input.required = !noExpiry;
  $('#expiry-field span').textContent = noExpiry ? 'Ngày hết hạn (không bắt buộc)' : 'Ngày hết hạn';
  $('#license-hint').textContent = noExpiry
    ? `GPLX hạng ${cls} không có thời hạn.`
    : `GPLX hạng ${cls} có thời hạn - phải còn hiệu lực. Không nhận GPLX hạng B1 mẫu cũ (số tự động, không được kinh doanh vận tải).`;
}

function updateTermsState() {
  const boxes = [...$$('#terms-list input')];
  const all = boxes.every((b) => b.checked);
  $('#terms-all').checked = all;
  $('#terms-all').indeterminate = !all && boxes.some((b) => b.checked);
  $('#apply-submit').disabled = !all;
}

async function loadTermsOnce() {
  if (termsInfo) return;
  termsInfo = await api('/driver-application/terms');
  $('#terms-version').textContent = `Phiên bản ${termsInfo.version}`;
  $('#terms-list').replaceChildren(...termsInfo.terms.map((t, i) => el('label', { class: 'term' },
    el('input', { type: 'checkbox', name: 'accepted_terms', value: t.id }),
    el('div', {}, el('span', { class: 'term-title' }, `${i + 1}. ${t.title}`), el('span', { class: 'term-body' }, t.body)))));
  updateLicenseOptions();
  updateTermsState();
}

function applicationStatusCard(a) {
  const info = el('div', { class: 'kv' },
    [['Loại xe', VEHICLE_TEXT[a.vehicle_type]], ['Biển số', a.license_plate], ['Xe', a.vehicle_model],
      ['GPLX', `Hạng ${a.license_class} · ${a.license_number}`], ['Ngày nộp', time(a.created_at)]]
      .map(([k, v]) => el('div', {}, el('span', {}, k), el('strong', {}, v))));
  const card = (cls, icon, title, desc, ...extra) => el('div', { class: `card status-card ${cls}` },
    el('div', { class: 'status-icon' }, icon),
    el('div', {}, el('h2', {}, title), el('p', { class: 'muted' }, desc), ...extra));

  if (a.status === 'pending') {
    return card('pending', '⏳', 'Hồ sơ đang chờ duyệt',
      'Nhân viên sẽ kiểm tra thông tin và liên hệ với bạn qua số điện thoại đã đăng ký.', info,
      el('div', { class: 'actions' }, el('button', {
        class: 'btn danger',
        onclick: async (e) => {
          const btn = e.currentTarget;
          if (!(await confirmDialog('Rút hồ sơ?', 'Hồ sơ sẽ bị hủy, bạn có thể nộp lại sau.', 'Rút hồ sơ', true))) return;
          try {
            await withBusy(btn, () => api('/driver-application/cancel', { method: 'POST' }));
            toast('Đã rút hồ sơ');
            loadBecomeDriver();
          } catch (err) { toast(err.message, true); }
        },
      }, 'Rút hồ sơ')));
  }
  if (a.status === 'approved') {
    return card('approved', '🎉', 'Chúc mừng! Bạn đã là tài xế đối tác',
      `Hồ sơ được duyệt ngày ${dateOnly(a.reviewed_at)}. Tổng đài sẽ bật nhận chuyến cho bạn sau khi ký hợp đồng.`,
      info, a.driver_status ? el('p', { class: 'muted' }, 'Trạng thái tài xế: ', badge(a.driver_status)) : null,
      a.review_note ? el('p', { class: 'muted' }, `Ghi chú: ${a.review_note}`) : null);
  }
  if (a.status === 'rejected') {
    return card('rejected', '❌', 'Hồ sơ trước đã bị từ chối',
      `Lý do: ${a.review_note || '—'}. Bạn có thể chỉnh sửa và nộp lại hồ sơ bên dưới.`);
  }
  return null;
}

async function loadBecomeDriver() {
  await loadTermsOnce();
  const { profile, application: a } = await api('/driver-application/me');
  $('#apply-name').value = profile.full_name;
  $('#apply-phone').value = profile.phone;
  const card = a ? applicationStatusCard(a) : null;
  $('#apply-status').replaceChildren(...(card ? [card] : []));
  $('#apply-form').classList.toggle('hidden', !!a && ['pending', 'approved'].includes(a.status));
}

$('#apply-form').addEventListener('change', (e) => {
  if (e.target.name === 'vehicle_type') updateLicenseOptions();
  if (e.target.id === 'license-class') updateExpiryField();
  if (e.target.id === 'terms-all') {
    $$('#terms-list input').forEach((b) => { b.checked = e.target.checked; });
  }
  if (e.target.name === 'accepted_terms' || e.target.id === 'terms-all') updateTermsState();
});

$('#apply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (!form.reportValidity()) return;
  const fd = new FormData(form);
  const body = Object.fromEntries([...fd.entries()].filter(([k, v]) => k !== 'accepted_terms' && v !== ''));
  body.accepted_terms = fd.getAll('accepted_terms');
  body.terms_version = termsInfo.version;
  try {
    await withBusy($('#apply-submit'), () => api('/driver-application', { method: 'POST', body }));
    form.reset();
    updateLicenseOptions();
    updateTermsState();
    toast('🎉 Đã gửi hồ sơ! Chúng tôi sẽ liên hệ với bạn sớm');
    loadBecomeDriver();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    if (err.message.includes('Điều khoản đã được cập nhật')) termsInfo = null;
    toast(err.message, true);
  }
});

// ---------- Duyệt hồ sơ tài xế (nhân viên) ----------
let applicationFilter = 'pending';

async function refreshPendingCount() {
  const pending = await api('/driver-applications?status=pending');
  const badgeEl = $('#pending-count');
  badgeEl.textContent = pending.length;
  badgeEl.classList.toggle('hidden', !pending.length);
}

function applicationActions(a) {
  if (a.status !== 'pending') {
    return el('div', { class: 'muted' }, a.reviewer ? `@${a.reviewer} · ${dateOnly(a.reviewed_at)}` : '—',
      a.review_note ? el('div', {}, a.review_note) : null);
  }
  const done = () => { loadApplications(); loadDrivers(); refreshPendingCount(); };
  return el('div', { class: 'actions' },
    el('button', {
      class: 'btn sm soft',
      onclick: async (e) => {
        const btn = e.currentTarget;
        const ok = await confirmDialog('Duyệt hồ sơ?',
          `${a.full_name} sẽ trở thành tài xế (${VEHICLE_TEXT[a.vehicle_type]}, ${a.license_plate}) ở trạng thái "Nghỉ". `
          + 'Hãy chắc chắn đã đối chiếu giấy tờ gốc và ký hợp đồng.', 'Duyệt');
        if (!ok) return;
        try {
          await withBusy(btn, () => api(`/driver-applications/${a.id}/approve`, { method: 'POST' }));
          toast(`Đã duyệt hồ sơ của ${a.full_name}`);
          done();
        } catch (err) { toast(err.message, true); }
      },
    }, '✓ Duyệt'),
    el('button', {
      class: 'btn sm danger',
      onclick: async (e) => {
        const btn = e.currentTarget;
        const reason = await promptDialog('Từ chối hồ sơ?', `Hồ sơ của ${a.full_name} sẽ bị từ chối. Khách hàng sẽ thấy lý do này.`,
          'Lý do từ chối', 'Từ chối');
        if (!reason) return;
        try {
          await withBusy(btn, () => api(`/driver-applications/${a.id}/reject`, { method: 'POST', body: { reason } }));
          toast('Đã từ chối hồ sơ');
          done();
        } catch (err) { toast(err.message, true); }
      },
    }, '✕ Từ chối'));
}

async function loadApplications() {
  const apps = await api('/driver-applications' + (applicationFilter ? `?status=${applicationFilter}` : ''));
  table('#application-table', ['#', 'Ứng viên', 'Tuổi / CCCD', 'Phương tiện', 'GPLX', 'Ngày nộp', 'Trạng thái', 'Xử lý'],
    apps.map((a) => [
      { v: `#${a.id}`, cls: 'id' },
      person(a.full_name, [a.phone, a.email].filter(Boolean).join(' · ')),
      el('div', {}, el('div', { class: 'strong' }, `${ageOf(a.date_of_birth)} tuổi`), el('span', { class: 'mono' }, a.national_id)),
      el('div', {}, el('div', { class: 'num' }, VEHICLE_TEXT[a.vehicle_type], ' ', el('span', { class: 'plate' }, a.license_plate)),
        el('span', { class: 'muted' }, a.vehicle_model)),
      el('div', {}, el('div', {}, el('span', { class: 'lic' }, a.license_class), ' ', el('span', { class: 'mono' }, a.license_number)),
        el('span', { class: 'muted' }, `${dateOnly(a.license_issued_on)} → ${a.license_expires_on ? dateOnly(a.license_expires_on) : 'không thời hạn'}`)),
      { v: time(a.created_at), cls: 'num muted' },
      appBadge(a.status),
      applicationActions(a),
    ]), applicationFilter === 'pending' ? 'Không có hồ sơ nào đang chờ duyệt' : 'Không có hồ sơ');
}

$$('#application-filter .chip').forEach((chip) => chip.addEventListener('click', () => {
  applicationFilter = chip.dataset.status;
  $$('#application-filter .chip').forEach((c) => c.classList.toggle('active', c === chip));
  loadApplications().catch((e) => toast(e.message, true));
}));

// ---------- Nhân viên (admin) ----------
const roleBadge = (r) => el('span', { class: `badge r-${r}` }, ROLE_TEXT[r] || r);

function staffStatus(s) {
  if (!s.is_active) return el('span', { class: 'badge s-locked' }, 'Đã khóa');
  if (s.must_change_password) return el('span', { class: 'badge s-pending' }, 'Chờ đổi mật khẩu');
  return el('span', { class: 'badge s-active' }, 'Hoạt động');
}

// Gọi API quản trị có hộp thoại xác nhận, rồi tải lại danh sách
async function staffAction(btn, { title, message, okLabel, danger, path, method = 'POST', body, done }) {
  if (!(await confirmDialog(title, message, okLabel, danger))) return;
  try {
    const res = await withBusy(btn, () => api(path, { method, body }));
    if (done) done(res);
    loadStaff();
  } catch (err) { toast(err.message, true); }
}

function staffActions(s) {
  const btn = (label, cls, opts) => el('button', {
    class: `btn sm ${cls}`, onclick: (e) => staffAction(e.currentTarget, opts),
  }, label);
  const name = `${s.full_name} (${s.username})`;
  const list = [
    btn('♻ Đặt lại MK', '', {
      title: 'Đặt lại mật khẩu?',
      message: `Hệ thống sẽ cấp mật khẩu tạm mới cho ${name} và đăng xuất họ khỏi mọi thiết bị.`,
      okLabel: 'Đặt lại',
      path: `/admin/staff/${s.id}/reset-password`,
      done: (r) => showTempPassword('Mật khẩu tạm mới', `Tài khoản: ${s.username}`, r.temp_password),
    }),
  ];
  if (s.active_sessions > 0 && s.is_active) {
    list.push(btn('📴 Thu hồi phiên', '', {
      title: 'Thu hồi phiên đăng nhập?',
      message: `${name} đang đăng nhập trên ${s.active_sessions} phiên. Tất cả sẽ bị đăng xuất.`,
      okLabel: 'Đăng xuất tất cả',
      path: `/admin/staff/${s.id}/revoke-sessions`,
      done: (r) => toast(`Đã thu hồi ${r.revoked} phiên đăng nhập`),
    }));
  }
  list.push(s.is_active
    ? btn('🔒 Khóa', 'danger', {
      title: 'Khóa tài khoản?',
      message: `${name} sẽ bị đăng xuất ngay và không thể đăng nhập cho tới khi được mở khóa.`,
      okLabel: 'Khóa tài khoản', danger: true,
      path: `/admin/staff/${s.id}`, method: 'PATCH', body: { is_active: false },
      done: () => toast(`Đã khóa tài khoản ${s.username}`),
    })
    : btn('Mở khóa', 'soft', {
      title: 'Mở khóa tài khoản?',
      message: `${name} sẽ có thể đăng nhập lại.`,
      okLabel: 'Mở khóa',
      path: `/admin/staff/${s.id}`, method: 'PATCH', body: { is_active: true },
      done: () => toast(`Đã mở khóa tài khoản ${s.username}`),
    }));
  return list;
}

async function loadStaff() {
  const staff = await api('/admin/staff');
  table('#staff-table', ['#', 'Nhân viên', 'Trạng thái', 'Đăng nhập gần nhất', 'Phiên', 'Thao tác'],
    staff.map((s) => {
      const nameCell = el('div', { class: 'person' },
        el('span', { class: 'avatar sm' }, initials(s.full_name)),
        el('div', {}, el('span', { class: 'strong' }, s.full_name), el('span', { class: 'muted' }, '@' + s.username)));
      return [
        { v: `#${s.id}`, cls: 'id' }, nameCell, staffStatus(s),
        { v: s.last_login_at ? time(s.last_login_at) : 'Chưa đăng nhập', cls: 'num muted' },
        { v: s.active_sessions, cls: 'num' },
        el('div', { class: 'actions' }, staffActions(s)),
      ];
    }));
  // Làm mờ dòng nhân viên đã bị khóa
  $$('#staff-table tbody tr').forEach((tr, i) => tr.classList.toggle('is-locked', staff[i] && !staff[i].is_active));
}

// ---------- Nhật ký hoạt động (admin) ----------
const ACTION_TEXT = {
  login: ['🔓', 'Đăng nhập', 'ok'],
  login_failed: ['⛔', 'Đăng nhập sai', 'warn'],
  login_blocked: ['🚫', 'Đăng nhập khi bị khóa', 'warn'],
  logout: ['🚪', 'Đăng xuất'],
  register: ['🆕', 'Đăng ký tài khoản', 'ok'],
  password_change: ['🔑', 'Đổi mật khẩu', 'ok'],
  password_change_failed: ['⛔', 'Đổi mật khẩu thất bại', 'warn'],
  password_reset_request: ['📧', 'Yêu cầu đặt lại mật khẩu'],
  password_reset: ['🔑', 'Đặt lại mật khẩu qua email', 'ok'],
  staff_create: ['👤', 'Tạo nhân viên', 'ok'],
  staff_update: ['✏️', 'Sửa thông tin nhân viên'],
  staff_role_change: ['🛡️', 'Đổi vai trò'],
  staff_lock: ['🔒', 'Khóa tài khoản', 'warn'],
  staff_unlock: ['🔓', 'Mở khóa tài khoản', 'ok'],
  staff_password_reset: ['♻️', 'Đặt lại mật khẩu'],
  staff_revoke_sessions: ['📴', 'Thu hồi phiên đăng nhập'],
  trip_create: ['🧭', 'Đặt chuyến'],
  trip_assign: ['🚖', 'Điều tài xế'],
  trip_start: ['▶️', 'Bắt đầu chuyến'],
  trip_complete: ['✅', 'Hoàn thành chuyến', 'ok'],
  trip_cancel: ['✖️', 'Hủy chuyến', 'warn'],
  driver_create: ['🧑‍✈️', 'Thêm tài xế'],
  driver_status: ['🔁', 'Đổi trạng thái tài xế'],
  driver_apply: ['📝', 'Nộp hồ sơ làm tài xế'],
  driver_apply_cancel: ['↩️', 'Rút hồ sơ tài xế'],
  driver_apply_approve: ['✅', 'Duyệt hồ sơ tài xế', 'ok'],
  driver_apply_reject: ['❌', 'Từ chối hồ sơ tài xế', 'warn'],
  profile_update: ['🪪', 'Cập nhật hồ sơ cá nhân'],
  profile_update_failed: ['⛔', 'Cập nhật hồ sơ thất bại (sai mật khẩu)', 'warn'],
  session_revoke: ['📴', 'Đăng xuất một thiết bị'],
  session_revoke_others: ['📴', 'Đăng xuất mọi thiết bị khác'],
  customer_create: ['👥', 'Thêm khách hàng'],
};
const TARGET_TEXT = {
  trip: 'Chuyến', driver: 'Tài xế', customer: 'Khách hàng', user: 'Tài khoản', driver_application: 'Hồ sơ tài xế',
};

// Diễn giải chi tiết (jsonb) thành câu ngắn dễ đọc
function describe(a) {
  const d = a.detail || {};
  const parts = [];
  if (d.username && a.target_type === 'user') parts.push('@' + d.username);
  if (typeof d.full_name === 'string') parts.push(d.full_name);
  if (d.license_plate) parts.push(d.license_plate);
  if (d.role && d.role.from) parts.push(`${ROLE_TEXT[d.role.from]} → ${ROLE_TEXT[d.role.to]}`);
  else if (typeof d.role === 'string') parts.push(ROLE_TEXT[d.role]);
  if (d.from && d.to) parts.push(`${STATUS_TEXT[d.from] || d.from} → ${STATUS_TEXT[d.to] || d.to}`);
  if (d.status) parts.push(STATUS_TEXT[d.status] || d.status);
  if (d.fare) parts.push(money(d.fare));
  if (d.license_class) parts.push(`GPLX hạng ${d.license_class}`);
  if (Array.isArray(d.fields)) {
    const FIELD_TEXT = { full_name: 'họ tên', phone: 'SĐT', email: 'email' };
    parts.push(`Đổi ${d.fields.map((f) => FIELD_TEXT[f] || f).join(', ')}`);
  }
  if (d.full_name && d.full_name.from) parts.push(`"${d.full_name.from}" → "${d.full_name.to}"`);
  if (d.reason) parts.push(`Lý do: ${d.reason}`);
  if (d.revoked_sessions) parts.push(`thu hồi ${d.revoked_sessions} phiên`);
  if (a.action === 'login_failed' && !a.user_id) parts.push('tên đăng nhập không tồn tại');
  if (d.found === false) parts.push(`email ${d.email} không thuộc tài khoản nào`);
  if (d.throttled) parts.push('vượt giới hạn 3 email/giờ - không gửi');
  return parts.join(' · ');
}

let auditCursor = null;

async function loadAudit(append = false) {
  const params = new URLSearchParams();
  Object.entries(Object.fromEntries(new FormData($('#audit-filter')).entries()))
    .forEach(([k, v]) => { if (v) params.set(k, v); });
  if (append && auditCursor) params.set('before_id', auditCursor);
  const { items, has_more: hasMore } = await api('/admin/audit?' + params.toString());

  const rows = items.map((a) => {
    const [icon, label, tone] = ACTION_TEXT[a.action] || ['•', a.action];
    return [
      { v: time(a.at), cls: 'num muted' },
      a.username
        ? el('div', { class: 'who' }, el('span', { class: 'strong' }, '@' + a.username), a.role ? roleBadge(a.role) : null)
        : el('span', { class: 'muted' }, 'Không xác định'),
      el('span', { class: `act ${tone || ''}` }, el('span', { class: 'act-icon' }, icon), label),
      a.target_type ? { v: `${TARGET_TEXT[a.target_type] || a.target_type} #${a.target_id}`, cls: 'num' } : el('span', { class: 'muted' }, '—'),
      el('div', { class: 'detail' }, describe(a) || '—'),
      el('span', { class: 'mono' }, a.ip || ''),
    ];
  });
  const headers = ['Thời gian', 'Người thực hiện', 'Hành động', 'Đối tượng', 'Chi tiết', 'IP'];
  if (append) {
    const tbody = $('#audit-table tbody');
    rows.forEach((r) => tbody.append(el('tr', {}, r.map((c) => (c && typeof c === 'object' && 'v' in c
      ? el('td', { class: c.cls }, c.v) : el('td', {}, c))))));
  } else {
    table('#audit-table', headers, rows, 'Không có hoạt động nào khớp bộ lọc');
  }
  auditCursor = items.length ? items[items.length - 1].id : auditCursor;
  $('#audit-more').classList.toggle('hidden', !hasMore);
}

// ---------- Form ----------
function bindForm(selector, handler) {
  $(selector).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      await withBusy(form.querySelector('[type=submit]'), () => handler(body, form));
    } catch (err) { toast(err.message, true); }
  });
}

const saveAndReload = (path, msg, reload) => async (body, form) => {
  await api(path, { method: 'POST', body });
  toast(msg);
  form.reset();
  reload();
};

const LOADERS = {
  dashboard: loadDashboard,
  trips: () => Promise.all([isStaff() ? loadCustomerOptions() : null, loadTrips()]).then(updateFare),
  drivers: () => Promise.all([loadApplications(), loadDrivers(), refreshPendingCount()]),
  'become-driver': loadBecomeDriver,
  profile: loadProfile,
  customers: loadCustomers,
  staff: loadStaff,
  audit: () => loadAudit(false),
};

function showTab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === name));
  moveTabIndicator();
  LOADERS[name]().catch((e) => toast(e.message, true));
}

// Khối sáng trượt tới nút tab đang chọn (ẩn đi khi đang ở trang không có tab, vd: Hồ sơ cá nhân)
function moveTabIndicator() {
  const ind = $('.tab-indicator');
  const active = $('.tab.active:not(.role-hidden)');
  if (!active || !active.offsetWidth) { ind.style.opacity = '0'; return; }
  ind.style.left = `${active.offsetLeft}px`;
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.opacity = '1';
}
window.addEventListener('resize', moveTabIndicator);

$$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#refresh-dashboard').addEventListener('click', () => loadDashboard().then(() => toast('Đã cập nhật số liệu'))
  .catch((e) => toast(e.message, true)));

$$('#trip-filter .chip').forEach((chip) => chip.addEventListener('click', () => {
  tripFilter = chip.dataset.status;
  $$('#trip-filter .chip').forEach((c) => c.classList.toggle('active', c === chip));
  loadTrips().catch((e) => toast(e.message, true));
}));

$('#trip-form').addEventListener('input', updateFare);
$('#trip-form').addEventListener('reset', () => setTimeout(updateFare));
bindForm('#trip-form', saveAndReload('/trips', '🚕 Đặt xe thành công! Đang tìm tài xế cho bạn.', loadTrips));
bindForm('#driver-form', saveAndReload('/drivers', 'Đã thêm tài xế', loadDrivers));
bindForm('#customer-form', saveAndReload('/customers', 'Đã thêm khách hàng', loadCustomers));

$$('[data-auth]').forEach((b) => b.addEventListener('click', () => switchAuth(b.dataset.auth)));

bindForm('#login-form', async (body, form) => {
  const user = await api('/auth/login', { method: 'POST', body });
  form.reset();
  onLogin(user);
});

bindForm('#register-form', async (body, form) => {
  if (body.password !== body.password2) throw new Error('Mật khẩu nhập lại không khớp');
  delete body.password2;
  const user = await api('/auth/register', { method: 'POST', body });
  form.reset();
  toast('Đăng ký thành công, chào mừng bạn!');
  onLogin(user);
});

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  showAuth();
  switchAuth('login');
}
$('#force-logout').addEventListener('click', logout);

// ---------- Menu tài khoản ----------
const menuBtn = $('#user-menu-btn');
function toggleMenu(open) {
  $('#user-menu').classList.toggle('hidden', !open);
  menuBtn.setAttribute('aria-expanded', String(open));
  if (open) $('#user-menu button').focus();
}
menuBtn.addEventListener('click', () => toggleMenu($('#user-menu').classList.contains('hidden')));
document.addEventListener('click', (e) => { if (!e.target.closest('.user-menu')) toggleMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleMenu(false); });

$$('[data-menu]').forEach((b) => b.addEventListener('click', async () => {
  toggleMenu(false);
  const action = b.dataset.menu;
  if (action === 'logout') return logout();
  if (action === 'driver') return showTab('become-driver');
  showTab('profile');
  const target = { password: '#password-form', sessions: '#sessions-card' }[action];
  if (target) {
    setTimeout(() => {
      $(target).scrollIntoView({ behavior: 'smooth', block: 'center' });
      const first = $(target).querySelector('input');
      if (first) first.focus({ preventScroll: true });
    }, 150);
  }
  return undefined;
}));

// ---------- Hồ sơ cá nhân ----------
let profileData = null;

// Cập nhật tên hiển thị ở thanh trên + menu
function renderIdentity(name) {
  currentUser.full_name = name;
  $('#user-name').textContent = name;
  $('#user-avatar').textContent = initials(name);
  $('#menu-name').textContent = name;
  renderGreeting();
}

// Lời chào theo buổi trong ngày, gọi theo tên (chữ cuối của họ tên): "Nguyễn Văn An" -> "An"
function renderGreeting() {
  if (!currentUser) return;
  const h = new Date().getHours();
  const part = h < 11 ? 'buổi sáng' : h < 13 ? 'buổi trưa' : h < 18 ? 'buổi chiều' : 'buổi tối';
  const icon = h < 11 ? '☀️' : h < 13 ? '🌤️' : h < 18 ? '👋' : '🌙';
  const name = String(currentUser.full_name).trim().split(/\s+/).pop();
  $('#greeting-title').textContent = `Chào ${part}, ${name} ${icon}`;
}

// Nút / logo chuyển trang
const homeTab = () => (isStaff() ? 'dashboard' : 'trips');
$('#home-link').addEventListener('click', () => showTab(homeTab()));
$$('[data-goto-tab]').forEach((b) => b.addEventListener('click', () => {
  showTab(b.dataset.gotoTab);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}));

// Thẻ "Tài xế đối tác" trong hồ sơ của khách hàng
async function renderDriverCard() {
  const { application: a } = await api('/driver-application/me');
  const [text, btn] = !a || a.status === 'cancelled'
    ? ['Có xe máy hoặc ô tô? Đăng ký trở thành tài xế đối tác để chủ động thời gian và tăng thu nhập.', 'Đăng ký ngay']
    : a.status === 'pending'
      ? [`Hồ sơ đăng ký (${VEHICLE_TEXT[a.vehicle_type]}, ${a.license_plate}) đang chờ nhân viên duyệt.`, 'Xem hồ sơ']
      : a.status === 'approved'
        ? [`Bạn đã là tài xế đối tác từ ${dateOnly(a.reviewed_at)} · ${a.license_plate}.`, 'Xem chi tiết']
        : [`Hồ sơ trước bị từ chối: ${a.review_note || '—'}`, 'Nộp lại hồ sơ'];
  $('#driver-card-text').textContent = text;
  $('#driver-card-btn').textContent = btn;
}

function browserName(ua) {
  if (!ua) return 'Không rõ thiết bị';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : 'Trình duyệt khác';
  return os ? `${br} · ${os}` : br;
}

function renderProfile(p) {
  profileData = p;
  renderIdentity(p.full_name);
  $('#profile-avatar').textContent = initials(p.full_name);
  $('#profile-name').textContent = p.full_name;
  $('#profile-username').textContent = '@' + p.username;
  $('#profile-role').textContent = ROLE_TEXT[p.role];
  $('#profile-driver').replaceChildren(...(p.driver
    ? [el('span', { class: 'badge s-active' }, '🚘 Tài xế đối tác'), ' ',
      el('span', { class: 'muted' }, `${VEHICLE_TEXT[p.driver.vehicle_type]} · ${p.driver.license_plate} · `), badge(p.driver.status)]
    : []));

  const form = $('#profile-form');
  form.full_name.value = p.full_name;
  form.phone.value = p.phone || '';
  form.email.value = p.email || '';
  form.current_password.value = '';
  form.phone.required = p.role === 'customer';
  $('#profile-phone-label').textContent = p.role === 'customer' ? 'Số điện thoại' : 'Số điện thoại (không bắt buộc)';
  $('#profile-pw-field').classList.add('hidden');

  $('#profile-account').replaceChildren(...[
    ['Tên đăng nhập', '@' + p.username],
    ['Vai trò', ROLE_TEXT[p.role]],
    ['Ngày tạo tài khoản', time(p.created_at)],
    ['Đăng nhập gần nhất', p.last_login_at ? time(p.last_login_at) : '—'],
    ['Đổi mật khẩu gần nhất', p.password_changed_at ? time(p.password_changed_at) : 'Chưa đổi'],
    ['Thiết bị đang đăng nhập', String(p.sessions.length)],
  ].map(([k, v]) => el('div', {}, el('span', {}, k), el('strong', {}, v))));

  table('#session-table', ['Thiết bị', 'Địa chỉ IP', 'Đăng nhập lúc', 'Hết hạn', ''],
    p.sessions.map((s) => [
      el('div', {}, el('div', { class: 'strong' }, browserName(s.user_agent), s.current ? el('span', { class: 'tag' }, 'Thiết bị này') : null),
        el('div', { class: 'muted ua', title: s.user_agent || '' }, s.user_agent || '')),
      el('span', { class: 'mono' }, s.ip || '—'),
      { v: time(s.created_at), cls: 'num muted' },
      { v: time(s.expires_at), cls: 'num muted' },
      s.current ? el('span', { class: 'muted' }, '—') : el('button', {
        class: 'btn sm danger',
        onclick: async (e) => {
          try {
            await withBusy(e.currentTarget, () => api(`/profile/sessions/${s.id}/revoke`, { method: 'POST' }));
            toast('Đã đăng xuất thiết bị');
            loadProfile();
          } catch (err) { toast(err.message, true); }
        },
      }, 'Đăng xuất'),
    ]));
  $('#revoke-others').disabled = p.sessions.length <= 1;
}

async function loadProfile() {
  renderProfile(await api('/profile'));
  if (currentUser.role === 'customer') await renderDriverCard();
}

// Chỉ hiện ô mật khẩu khi người dùng sửa SĐT hoặc email
$('#profile-form').addEventListener('input', () => {
  const form = $('#profile-form');
  const sensitive = form.phone.value.trim() !== (profileData.phone || '') || form.email.value.trim() !== (profileData.email || '');
  $('#profile-pw-field').classList.toggle('hidden', !sensitive);
  form.current_password.required = sensitive;
});
$('#profile-form').addEventListener('reset', (e) => {
  e.preventDefault();
  renderProfile(profileData);
});
bindForm('#profile-form', async (body) => {
  if (!body.current_password) delete body.current_password;
  renderProfile(await api('/profile', { method: 'PATCH', body }));
  toast('Đã lưu thông tin cá nhân');
});

$('#revoke-others').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!(await confirmDialog('Đăng xuất mọi thiết bị khác?', 'Chỉ giữ lại phiên đăng nhập trên thiết bị này.', 'Đăng xuất tất cả', true))) return;
  try {
    const r = await withBusy(btn, () => api('/profile/sessions/revoke-others', { method: 'POST' }));
    toast(`Đã đăng xuất ${r.revoked} thiết bị`);
    loadProfile();
  } catch (err) { toast(err.message, true); }
});

// ---------- Mật khẩu ----------
async function changePassword(body) {
  if (body.new_password !== body.new_password2) throw new Error('Mật khẩu mới nhập lại không khớp');
  delete body.new_password2;
  return api('/auth/password', { method: 'POST', body });
}

bindForm('#force-form', async (body, form) => {
  const user = await changePassword(body);
  form.reset();
  toast('Đã đổi mật khẩu, chào mừng bạn!');
  onLogin(user);
});

bindForm('#password-form', async (body, form) => {
  await changePassword(body);
  form.reset();
  toast('Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất');
  loadProfile();
});

$$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$('#temp-copy').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText($('#temp-password').textContent);
    btn.textContent = 'Đã sao chép ✓';
  } catch { toast('Không sao chép được, hãy chọn và copy thủ công', true); }
});

// ---------- Quản trị ----------
bindForm('#staff-form', async (body, form) => {
  const s = await api('/admin/staff', { method: 'POST', body });
  form.reset();
  loadStaff();
  showTempPassword('Đã tạo tài khoản 🎉', `${s.full_name} · @${s.username} · Điều phối viên`, s.temp_password);
});

$('#audit-filter').addEventListener('submit', (e) => {
  e.preventDefault();
  loadAudit(false).catch((err) => toast(err.message, true));
});
$('#audit-more button').addEventListener('click', (e) => withBusy(e.currentTarget, () => loadAudit(true))
  .catch((err) => toast(err.message, true)));

// ---------- Quên mật khẩu ----------
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => switchAuth(b.dataset.goto)));

bindForm('#forgot-form', async (body) => {
  await api('/auth/forgot', { method: 'POST', body });
  $('#forgot-sent').classList.remove('hidden');
});

// Token nằm sau dấu # (#reset=...) nên không bị gửi lên server trong URL / access log
let resetToken = null;
bindForm('#reset-form', async (body, form) => {
  if (body.new_password !== body.new_password2) throw new Error('Mật khẩu nhập lại không khớp');
  const r = await api('/auth/reset', { method: 'POST', body: { token: resetToken, new_password: body.new_password } });
  form.reset();
  resetToken = null;
  switchAuth('login');
  $('#login-form input[name=username]').value = r.username;
  $('#login-form input[name=password]').focus();
  toast('Đã đặt mật khẩu mới. Hãy đăng nhập lại');
});

// Khởi động: mở từ link đặt lại mật khẩu -> hiện form đặt lại;
// còn lại: còn phiên đăng nhập thì vào thẳng ứng dụng
const resetMatch = /^#reset=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
if (resetMatch) {
  resetToken = resetMatch[1];
  history.replaceState(null, '', window.location.pathname); // xóa token khỏi thanh địa chỉ / lịch sử
  showAuth();
  switchAuth('reset');
} else {
  api('/auth/me').then(onLogin).catch(showAuth);
}
