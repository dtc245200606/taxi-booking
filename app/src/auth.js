// Đăng ký / đăng nhập / đăng xuất + middleware xác thực và phân quyền.
//   - Mật khẩu băm bằng scrypt (module crypto có sẵn của Node), salt ngẫu nhiên cho từng tài khoản.
//   - Phiên đăng nhập: token ngẫu nhiên 32 byte trong cookie HttpOnly; DB chỉ lưu SHA-256 của token.
//   - Cookie SameSite=Strict + API chỉ nhận JSON -> chống CSRF.
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const { pool, withTransaction } = require('./db');
const metrics = require('./metrics');
const log = require('./logger');
const { HttpError, wrap, requireText, requirePhone, requireEmail } = require('./validate');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };
const COOKIE = 'sid';
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

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

async function createSession(res, userId, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, ip, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [sha256(token), userId, ip, SESSION_TTL_HOURS],
  );
  setSessionCookie(res, token, SESSION_TTL_HOURS * 3600);
}

const publicUser = (u) => ({
  id: u.id, username: u.username, full_name: u.full_name, role: u.role, customer_id: u.customer_id,
});

// Đọc cookie -> gắn req.user nếu phiên hợp lệ (chưa hết hạn, chưa thu hồi)
const authenticate = wrap(async (req, res, next) => {
  const token = readCookie(req, COOKIE);
  if (token) {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.customer_id
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (rows.length) {
      req.user = rows[0];
      req.sessionHash = sha256(token);
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Vui lòng đăng nhập'));
  return next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new HttpError(401, 'Vui lòng đăng nhập'));
  if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Bạn không có quyền thực hiện thao tác này'));
  return next();
};

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
      `INSERT INTO users (username, password_hash, full_name, role, customer_id, last_login_at)
       VALUES ($1, $2, $3, 'customer', $4, now()) RETURNING *`,
      [username, passwordHash, fullName, c.rows[0].id],
    );
    return u.rows[0];
  }).catch((err) => {
    if (err.code === '23505') throw new HttpError(409, 'Tên đăng nhập hoặc số điện thoại đã tồn tại');
    throw err;
  });

  await createSession(res, user.id, req.ip);
  metrics.authEvents.inc({ event: 'register', result: 'success' });
  log.info('user_registered', { userId: user.id, username, customerId: user.customer_id, ip: req.ip });
  res.status(201).json(publicUser(user));
}));

router.post('/login', wrap(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !password) throw new HttpError(400, 'Nhập tên đăng nhập và mật khẩu');

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username.slice(0, 30)]);
  const user = rows[0];
  const ok = await verifyPassword(password.slice(0, 128), user ? user.password_hash : await dummyHash);
  if (!user || !ok) {
    metrics.authEvents.inc({ event: 'login', result: 'failure' });
    log.warn('login_failed', { username, ip: req.ip });
    // Thông báo chung, không tiết lộ là sai username hay sai mật khẩu
    throw new HttpError(401, 'Sai tên đăng nhập hoặc mật khẩu');
  }

  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await createSession(res, user.id, req.ip);
  metrics.authEvents.inc({ event: 'login', result: 'success' });
  log.info('login_success', { userId: user.id, username, role: user.role, ip: req.ip });
  res.json(publicUser(user));
}));

router.post('/logout', authenticate, wrap(async (req, res) => {
  if (req.sessionHash) {
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [req.sessionHash]);
    log.info('logout', { userId: req.user.id });
  }
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
}));

router.get('/me', authenticate, requireAuth, (req, res) => res.json(publicUser(req.user)));

// Tạo tài khoản điều phối viên ban đầu từ biến môi trường (chỉ khi chưa tồn tại)
async function ensureAdmin() {
  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    log.warn('admin_not_configured', { hint: 'Đặt ADMIN_PASSWORD trong .env để tạo tài khoản điều phối viên' });
    return;
  }
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role)
       VALUES ($1, $2, 'Quản trị viên', 'dispatcher') ON CONFLICT (username) DO NOTHING`,
      [username, await hashPassword(password)],
    );
    if (rowCount) log.info('admin_created', { username });
  } catch (err) {
    log.error('admin_bootstrap_failed', { error: err.message });
  }
}

module.exports = { router, authenticate, requireAuth, requireRole, ensureAdmin };
