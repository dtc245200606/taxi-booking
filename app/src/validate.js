// Kiểm tra dữ liệu đầu vào + lỗi HTTP dùng chung cho các router.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireText(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `Thiếu trường ${field}`);
  const v = value.trim();
  if (v.length > max) throw new HttpError(400, `Trường ${field} quá dài (tối đa ${max} ký tự)`);
  return v;
}

function requirePhone(value) {
  const v = requireText(value, 'phone', 20);
  if (!/^\+?[0-9]{9,15}$/.test(v)) throw new HttpError(400, 'Số điện thoại không hợp lệ');
  return v;
}

// Email không bắt buộc: trả về null nếu bỏ trống
function requireEmail(value) {
  if (!value) return null;
  const v = requireText(value, 'email', 100);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new HttpError(400, 'Email không hợp lệ');
  return v;
}

function requireId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'ID không hợp lệ');
  return id;
}

function requireEnum(value, list, field) {
  if (!list.includes(value)) throw new HttpError(400, `${field} phải là một trong: ${list.join(', ')}`);
  return value;
}

module.exports = { HttpError, wrap, requireText, requirePhone, requireEmail, requireId, requireEnum };
