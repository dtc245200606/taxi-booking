// Đăng ký / đăng nhập / đăng xuất / đổi mật khẩu + middleware xác thực và phân quyền.
//   - Mật khẩu băm bằng scrypt (module crypto có sẵn của Node), salt ngẫu nhiên cho từng tài khoản.
//   - Phiên đăng nhập: token ngẫu nhiên 32 byte trong cookie HttpOnly; DB chỉ lưu SHA-256 của token.
//   - Cookie SameSite=Strict + API chỉ nhận JSON -> chống CSRF.
// Vai trò: admin (quản trị) | dispatcher (nhân viên điều phối) | customer (khách hàng)
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { pool, withTransaction } = require('./db');
const metrics = require('./metrics');
const log = require('./logger');
const { audit } = require('./audit');
const { sendMail } = require('./mailer');
const { HttpError, wrap, requireText, requirePhone, requireEmail } = require('./validate');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };
const COOKIE = 'sid';
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
const STAFF_ROLES = ['admin', 'dispatcher'];

// ---------- Mật khẩu ----------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keyLen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected); // so sánh thời gian hằng, chống timing attack
}

// Hash giả để khi username không tồn tại vẫn tốn thời gian như khi sai mật khẩu
// (không để lộ username nào có thật qua thời gian phản hồi).
const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

// Mật khẩu tạm 12 ký tự cho nhân viên (bỏ các ký tự dễ nhầm: 0/O, 1/l/I)
function randomPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(letters), pick(digits), ...Array.from({ length: 10 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function requireUsername(value) {
  const v = requireText(value, 'username', 30).toLowerCase();
  if (!/^[a-z0-9_.]{3,30}$/.test(v)) {
    throw new HttpError(400, 'Tên đăng nhập 3-30 ký tự, chỉ gồm chữ không dấu, số, dấu _ hoặc .');
  }
  return v;
}

function requireNewPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new HttpError(400, 'Mật khẩu phải dài 8-128 ký tự');
  }
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) {
    throw new HttpError(400, 'Mật khẩu phải có cả chữ và số');
  }
  return value;
}

// ---------- Phiên đăng nhập ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`);
}

async function createSession(res, userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
    [sha256(token), userId, req.ip, (req.get('user-agent') || '').slice(0, 200) || null, SESSION_TTL_HOURS],
  );
  setSessionCookie(res, token, SESSION_TTL_HOURS * 3600);
}

// Thu hồi mọi phiên còn hiệu lực của một tài khoản (trừ phiên exceptHash nếu có)
async function revokeSessions(userId, exceptHash = null, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        AND ($2::text IS NULL OR token_hash <> $2)`,
    [userId, exceptHash],
  );
  return rowCount;
}

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  full_name: u.full_name,
  role: u.role,
  customer_id: u.customer_id,
  must_change_password: u.must_change_password,
});

// Đọc cookie -> gắn req.user nếu phiên hợp lệ (chưa hết hạn, chưa thu hồi, tài khoản chưa bị khóa)
const authenticate = wrap(async (req, res, next) => {
  const token = readCookie(req, COOKIE);
  if (token) {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.customer_id, u.must_change_password
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
      [sha256(token)],
    );
    if (rows.length) {
      req.user = rows[0];
      req.sessionHash = sha256(token);
    }
  }
  next();
});

// Chỉ cần đã đăng nhập (dùng cho /me, /logout, /password)
function requireSession(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Vui lòng đăng nhập'));
  return next();
}

// Đã đăng nhập VÀ đã đổi mật khẩu tạm (nếu bị yêu cầu)
function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Vui lòng đăng nhập'));
  if (req.user.must_change_password) return next(new HttpError(403, 'Bạn cần đổi mật khẩu trước khi tiếp tục'));
  return next();
}

const requireRole = (...roles) => (req, res, next) => requireAuth(req, res, (err) => {
  if (err) return next(err);
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Bạn không có quyền thực hiện thao tác này'));
  return next();
});

// ---------- API /api/auth ----------
const router = express.Router();

// Khách hàng tự đăng ký: tạo hồ sơ customers + tài khoản users trong cùng 1 transaction
router.post('/register', wrap(async (req, res) => {
  const username = requireUsername(req.body.username);
  const password = requireNewPassword(req.body.password);
  const fullName = requireText(req.body.full_name, 'full_name', 100);
  const phone = requirePhone(req.body.phone);
  const email = requireEmail(req.body.email);
  const passwordHash = await hashPassword(password);

  const user = await withTransaction(async (db) => {
    const taken = await db.query(
      `SELECT (SELECT 1 FROM users WHERE username = $1) AS u, (SELECT 1 FROM customers WHERE phone = $2) AS p`,
      [username, phone],
    );
    if (taken.rows[0].u) throw new HttpError(409, 'Tên đăng nhập đã được sử dụng');
    if (taken.rows[0].p) throw new HttpError(409, 'Số điện thoại đã được đăng ký');
    const c = await db.query(
      'INSERT INTO customers (full_name, phone, email) VALUES ($1, $2, $3) RETURNING id',
      [fullName, phone, email],
    );
    const u = await db.query(
      `INSERT INTO users (username, password_hash, full_name, role, customer_id, last_login_at, password_changed_at)
       VALUES ($1, $2, $3, 'customer', $4, now(), now()) RETURNING *`,
      [username, passwordHash, fullName, c.rows[0].id],
    );
    await audit(req, 'register', { user: u.rows[0], targetType: 'customer', targetId: c.rows[0].id, db });
    return u.rows[0];
  }).catch((err) => {
    if (err.code === '23505') throw new HttpError(409, 'Tên đăng nhập hoặc số điện thoại đã tồn tại');
    throw err;
  });

  await createSession(res, user.id, req);
  metrics.authEvents.inc({ event: 'register', result: 'success' });
  res.status(201).json(publicUser(user));
}));

router.post('/login', wrap(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 30) : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !password) throw new HttpError(400, 'Nhập tên đăng nhập và mật khẩu');

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  const ok = await verifyPassword(password.slice(0, 128), user ? user.password_hash : await dummyHash);
  if (!user || !ok) {
    metrics.authEvents.inc({ event: 'login', result: 'failure' });
    log.warn('login_failed', { username, ip: req.ip }); // dùng cho truy vấn LogQL phát hiện dò mật khẩu
    await audit(req, 'login_failed', { user: user || null, detail: user ? null : { username } });
    // Thông báo chung, không tiết lộ là sai username hay sai mật khẩu
    throw new HttpError(401, 'Sai tên đăng nhập hoặc mật khẩu');
  }
  // Chỉ báo "bị khóa" khi đã nhập đúng mật khẩu -> không lộ thông tin cho người dò mật khẩu
  if (!user.is_active) {
    metrics.authEvents.inc({ event: 'login', result: 'disabled' });
    await audit(req, 'login_blocked', { user });
    throw new HttpError(403, 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên');
  }

  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await createSession(res, user.id, req);
  metrics.authEvents.inc({ event: 'login', result: 'success' });
  await audit(req, 'login', { user });
  res.json(publicUser(user));
}));

router.post('/logout', authenticate, wrap(async (req, res) => {
  if (req.sessionHash) {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [req.sessionHash]);
    await audit(req, 'logout');
  }
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
}));

router.get('/me', authenticate, requireSession, (req, res) => res.json(publicUser(req.user)));

// Đổi mật khẩu của chính mình; các phiên đăng nhập khác (thiết bị khác) bị thu hồi
router.post('/password', authenticate, requireSession, wrap(async (req, res) => {
  const current = typeof req.body.current_password === 'string' ? req.body.current_password.slice(0, 128) : '';
  const next = requireNewPassword(req.body.new_password);
  if (current === next) throw new HttpError(400, 'Mật khẩu mới phải khác mật khẩu hiện tại');

  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(current, rows[0].password_hash))) {
    await audit(req, 'password_change_failed');
    throw new HttpError(400, 'Mật khẩu hiện tại không đúng');
  }
  await pool.query(
    `UPDATE users SET password_hash = $1, must_change_password = false, password_changed_at = now()
      WHERE id = $2`,
    [await hashPassword(next), req.user.id],
  );
  const revoked = await revokeSessions(req.user.id, req.sessionHash);
  await audit(req, 'password_change', { detail: { revoked_sessions: revoked } });
  res.json({ ...publicUser(req.user), must_change_password: false });
}));

// ---------- Quên mật khẩu (khách hàng) ----------
const RESET_TTL_MINUTES = 30;
const RESET_MAX_PER_HOUR = 3; // mỗi tài khoản tối đa 3 email đặt lại / giờ, chống spam hộp thư
// Link trong email lấy từ cấu hình, KHÔNG lấy từ header Host (chống Host header injection)
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://localhost').replace(/\/+$/, '');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function resetEmail(user, link) {
  const name = escapeHtml(user.full_name);
  return {
    subject: 'Đặt lại mật khẩu Taxi Booking',
    text: `Xin chào ${user.full_name},\n\n`
      + `Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản "${user.username}".\n`
      + `Mở liên kết sau để đặt mật khẩu mới (hiệu lực ${RESET_TTL_MINUTES} phút, chỉ dùng được 1 lần):\n\n${link}\n\n`
      + 'Nếu bạn không yêu cầu, hãy bỏ qua email này - mật khẩu của bạn không thay đổi.\n\nTaxi Booking',
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:auto;color:#0f172a">
  <h2 style="margin:0 0 12px">🚕 Đặt lại mật khẩu</h2>
  <p>Xin chào <b>${name}</b>,</p>
  <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản <b>${escapeHtml(user.username)}</b>.</p>
  <p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#f5b301;color:#1a1300;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Đặt mật khẩu mới</a></p>
  <p style="color:#64748b;font-size:13px">Liên kết có hiệu lực ${RESET_TTL_MINUTES} phút và chỉ dùng được một lần.<br>
  Nếu bạn không yêu cầu, hãy bỏ qua email này - mật khẩu của bạn không thay đổi.</p>
</div>`,
  };
}

// Xử lý yêu cầu: tìm tài khoản khách theo email, tạo token, gửi mail
async function processResetRequest(req, email) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.full_name, u.role, c.email,
            (SELECT COUNT(*)::int FROM password_resets p
              WHERE p.user_id = u.id AND p.created_at > now() - interval '1 hour') AS recent
       FROM customers c JOIN users u ON u.customer_id = c.id
      WHERE lower(c.email) = lower($1) AND u.role = 'customer' AND u.is_active
      ORDER BY u.id LIMIT 3`,
    [email],
  );
  if (!rows.length) {
    await audit(req, 'password_reset_request', { user: null, detail: { email, found: false } });
    return;
  }
  for (const user of rows) {
    if (user.recent >= RESET_MAX_PER_HOUR) {
      await audit(req, 'password_reset_request', { user, detail: { throttled: true } });
      continue;
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await withTransaction(async (db) => {
      // Link cũ chưa dùng sẽ bị vô hiệu khi có link mới
      await db.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
      await db.query(
        `INSERT INTO password_resets (token_hash, user_id, ip, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
        [sha256(token), user.id, req.ip, RESET_TTL_MINUTES],
      );
    });
    // Token đặt sau dấu # -> trình duyệt không gửi lên server, không lọt vào access log của Nginx
    await sendMail({ to: user.email, ...resetEmail(user, `${APP_BASE_URL}/#reset=${token}`) });
    await audit(req, 'password_reset_request', { user, targetType: 'user', targetId: user.id });
  }
}

// Luôn trả lời giống nhau dù email có tồn tại hay không (không cho dò email nào đã đăng ký).
// Việc tra cứu + gửi mail chạy sau khi đã trả lời -> thời gian phản hồi cũng không để lộ thông tin.
router.post('/forgot', wrap(async (req, res) => {
  const email = requireEmail(req.body.email);
  if (!email) throw new HttpError(400, 'Vui lòng nhập email');
  res.json({ ok: true });
  processResetRequest(req, email).catch((err) => log.error('password_reset_mail_failed', { error: err.message }));
}));

// Đặt mật khẩu mới bằng token trong email
router.post('/reset', wrap(async (req, res) => {
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
  const password = requireNewPassword(req.body.new_password);
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpError(400, 'Liên kết đặt lại mật khẩu không hợp lệ');

  const user = await withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT u.* FROM password_resets p JOIN users u ON u.id = p.user_id
        WHERE p.token_hash = $1 AND p.used_at IS NULL AND p.expires_at > now()
          AND u.is_active AND u.role = 'customer'
        FOR UPDATE OF p`,
      [sha256(token)],
    );
    if (!rows.length) throw new HttpError(400, 'Liên kết đã hết hạn hoặc đã được sử dụng. Hãy yêu cầu liên kết mới');
    const u = rows[0];
    await db.query('UPDATE password_resets SET used_at = now() WHERE token_hash = $1', [sha256(token)]);
    await db.query(
      `UPDATE users SET password_hash = $1, must_change_password = false, password_changed_at = now() WHERE id = $2`,
      [await hashPassword(password), u.id],
    );
    const revoked = await revokeSessions(u.id, null, db); // đăng xuất mọi thiết bị đang dùng mật khẩu cũ
    await audit(req, 'password_reset', { user: u, detail: { revoked_sessions: revoked }, db });
    return u;
  });
  res.json({ ok: true, username: user.username });
}));

// Tạo tài khoản quản trị ban đầu từ biến môi trường.
// Nếu hệ thống không còn admin nào đang hoạt động, tài khoản này được khôi phục quyền admin.
async function ensureAdmin() {
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    log.warn('admin_not_configured', { hint: 'Đặt APP_ADMIN_PASSWORD trong .env để tạo tài khoản quản trị' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, password_changed_at)
       VALUES ($1, $2, 'Quản trị viên', 'admin', now()) ON CONFLICT (username) DO NOTHING`,
      [username, await hashPassword(password)],
    );
    if (rowCount) log.info('admin_created', { username });
    const restored = await pool.query(
      `UPDATE users SET role = 'admin', is_active = true
        WHERE username = $1 AND customer_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND is_active)`,
      [username],
    );
    if (restored.rowCount) log.warn('admin_restored', { username });
  } catch (err) {
    log.error('admin_bootstrap_failed', { error: err.message });
  }
}

module.exports = {
  router,
  authenticate,
  requireAuth,
  requireRole,
  ensureAdmin,
  hashPassword,
  verifyPassword,
  requireNewPassword,
  randomPassword,
  requireUsername,
  revokeSessions,
  STAFF_ROLES,
};
