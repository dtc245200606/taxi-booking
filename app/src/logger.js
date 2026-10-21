// Logger ghi log dạng JSON ra stdout, mỗi dòng một sự kiện.
// Docker thu stdout -> Promtail đọc -> Loki lưu -> truy vấn bằng LogQL (| json).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function write(level, msg, fields = {}) {
  if (LEVELS[level] < minLevel) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    service: 'taxi-app',
    msg,
    ...fields,
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

module.exports = {
  debug: (msg, f) => write('debug', msg, f),
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
};
