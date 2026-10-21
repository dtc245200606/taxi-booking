// Kết nối PostgreSQL bằng connection pool.
// Ứng dụng dùng tài khoản taxi_app (chỉ có quyền SELECT/INSERT/UPDATE),
// KHÔNG dùng tài khoản quản trị (least privilege).
const { Pool } = require('pg');
const log = require('./logger');

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  application_name: 'taxi-app',
});

pool.on('error', (err) => log.error('db_pool_error', { error: err.message }));

// Chạy một hàm trong transaction; tự ROLLBACK khi có lỗi.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
