# Đề 22: Hệ thống Đặt xe / Taxi Booking

Ứng dụng web đặt xe (chuyến đi, tài xế, khách hàng, trạng thái) triển khai bằng Docker Compose:
Node.js + PostgreSQL + pgAdmin + Nginx reverse proxy (HTTPS tự ký).

## Chạy nhanh

```bash
sh scripts/gen-env.sh        # sinh .env với mật khẩu ngẫu nhiên
docker compose up -d --build
```

- Ứng dụng: https://localhost/
- pgAdmin:  https://localhost/pgadmin/
- Grafana:  https://localhost/grafana/   (tài khoản trong `.env`)
- Prometheus: https://localhost/prometheus/  (Basic Auth trong `.env`)
- Log tập trung: Grafana → Explore → Loki (xem `docs/logql-queries.md`)
