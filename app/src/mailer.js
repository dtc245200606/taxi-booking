// Gửi email qua SMTP (thư viện nodemailer).
// Mặc định gửi tới Mailpit - hộp thư giả trong mạng nội bộ để demo, xem thư tại https://<host>/mail/
// Muốn gửi email thật: đổi SMTP_HOST/SMTP_PORT/SMTP_SECURE/SMTP_USER/SMTP_PASS trong .env.
const nodemailer = require('nodemailer');
const log = require('./logger');

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'mailpit',
  port: Number(process.env.SMTP_PORT || 1025),
  secure: process.env.SMTP_SECURE === 'true', // true = SMTPS (465); false = thường/STARTTLS (587, 1025)
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
});

const FROM = process.env.MAIL_FROM || 'Taxi Booking <no-reply@taxi.local>';

async function sendMail({ to, subject, text, html }) {
  const info = await transport.sendMail({ from: FROM, to, subject, text, html });
  log.info('mail_sent', { subject, messageId: info.messageId });
  return info;
}

module.exports = { sendMail };
