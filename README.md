# Đề 22: Hệ thống Đặt xe / Taxi Booking

Ứng dụng web đặt xe (khách hàng, tài xế, chuyến đi, trạng thái chuyến) được triển khai hoàn toàn bằng
**Docker Compose**, kèm reverse proxy HTTPS, giám sát, log tập trung và các biện pháp hardening.

| Thành phần | Công nghệ |
|---|---|
| Ứng dụng web | Node.js 20 + Express, giao diện HTML/JS thuần |
| Cơ sở dữ liệu | PostgreSQL 16 |
| Công cụ quản trị DB | pgAdmin 4 |
| Reverse proxy | Nginx 1.27 (unprivileged) + HTTPS tự ký + security headers + rate limit |
| Giám sát | Prometheus + Grafana + cAdvisor + Node Exporter + Postgres Exporter + Nginx Exporter |
| Log tập trung | Loki + Promtail, truy vấn bằng LogQL |

## 1. Kiến trúc

```
                         Internet / Trình duyệt
                                   │  :80 (redirect) / :443 (HTTPS)
                     ┌─────────────▼──────────────┐   mạng frontend
                     │   Nginx reverse proxy      │
                     │  /  /api  /pgadmin/        │
                     │  /grafana/  /prometheus/   │
                     └──┬──────────────────────┬──┘
     mạng backend       │                      │        mạng monitoring
     (internal)         │                      │
  ┌───────────┐   ┌─────▼─────┐          ┌─────▼──────┐   ┌──────────┐
  │ pgAdmin 4 │   │ taxi-app  │          │  Grafana   │──▶│   Loki   │◀── Promtail ◀── Docker logs
  └─────┬─────┘   │ (Node.js) │          └─────┬──────┘   └──────────┘
        │         └─────┬─────┘                │
        │   ┌───────────▼──┐             ┌─────▼──────┐
        └──▶│ PostgreSQL   │◀── postgres-│ Prometheus │◀── cAdvisor, node-exporter,
            └──────────────┘    exporter─┤            │    nginx-exporter, nginx:8081/app-metrics
                                         └────────────┘
```

- **frontend**: chỉ có Nginx, là dịch vụ duy nhất mở cổng ra máy host (80, 443).
- **backend** (`internal: true`): app, PostgreSQL, pgAdmin – không ra được Internet, không publish cổng.
- **monitoring**: Prometheus, Grafana, Loki, Promtail, các exporter.
- Nginx và postgres-exporter nối nhiều mạng để làm cầu nối có kiểm soát.

## 2. Cấu trúc thư mục

```
taxi-booking/
├── docker-compose.yml          # Toàn bộ hệ thống (13 container)
├── .env.example                # Mẫu biến môi trường (KHÔNG chứa mật khẩu thật)
├── app/                        # Ứng dụng Node.js (Dockerfile multi-stage, user node)
│   ├── src/                    # server.js, routes.js, db.js, metrics.js, logger.js
│   └── public/                 # Giao diện web
├── db/
│   ├── init/                   # 01-schema.sql, 02-roles.sh (phân quyền), 03-seed.sql
│   └── pg_hba.conf             # Chỉ cho phép mạng backend, SCRAM-SHA-256
├── nginx/                      # nginx.conf, conf.d/taxi.conf, snippets/security-headers.conf
├── pgadmin/servers.json        # Khai báo sẵn server PostgreSQL trong pgAdmin
├── monitoring/
│   ├── prometheus/             # prometheus.yml, rules/alerts.yml
│   ├── grafana/                # provisioning (datasource) + 2 dashboard JSON
│   ├── loki/loki-config.yml
│   └── promtail/promtail-config.yml
├── scripts/
│   ├── gen-env.sh              # Sinh .env với mật khẩu ngẫu nhiên mạnh
│   ├── certgen.sh              # Sinh chứng chỉ tự ký + htpasswd (chạy trong container)
│   └── check-hardening.sh      # Kiểm tra/demo các biện pháp hardening
└── docs/logql-queries.md       # Các truy vấn LogQL
```

## 3. Yêu cầu

- Docker Engine 24+ và Docker Compose v2 (Docker Desktop trên Windows/macOS hoặc Docker trên Linux).
- Cổng 80 và 443 trên máy còn trống.
- RAM trống khoảng 3 GB.

## 4. Cài đặt và chạy

```bash
git clone https://github.com/<MA_SO_SINH_VIEN>/taxi-booking.git
cd taxi-booking

# 1) Tạo file .env với mật khẩu ngẫu nhiên (Linux/macOS/Git Bash trên Windows)
sh scripts/gen-env.sh
#    Trên Windows không có Git Bash: copy .env.example thành .env rồi tự đổi mọi giá trị CHANGE_ME_...

# 2) Build và chạy toàn bộ hệ thống
docker compose up -d --build

# 3) Kiểm tra trạng thái (các service có healthcheck phải là "healthy")
docker compose ps
```

(Tùy chọn) Truy cập bằng tên miền `taxi.local`: thêm dòng `127.0.0.1 taxi.local` vào
`/etc/hosts` (Linux/macOS) hoặc `C:\Windows\System32\drivers\etc\hosts` (Windows).

Trình duyệt sẽ cảnh báo "Your connection is not private" vì chứng chỉ tự ký → chọn **Advanced → Proceed**.

### Địa chỉ truy cập

| Dịch vụ | URL | Tài khoản |
|---|---|---|
| Ứng dụng đặt xe | https://localhost/ | không cần |
| pgAdmin 4 | https://localhost/pgadmin/ | `PGADMIN_EMAIL` / `PGADMIN_PASSWORD` trong `.env` |
| Grafana | https://localhost/grafana/ | `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` |
| Prometheus | https://localhost/prometheus/ | Basic Auth `MONITOR_BASIC_AUTH_USER` / `MONITOR_BASIC_AUTH_PASSWORD` |

Xem mật khẩu: `cat .env`.

Trong pgAdmin, server **Taxi Booking DB** đã được khai báo sẵn, đăng nhập bằng `POSTGRES_USER` / `POSTGRES_PASSWORD`.

## 5. Chức năng ứng dụng

- **Khách hàng**: thêm mới, xem danh sách và số chuyến đã đi.
- **Tài xế**: thêm mới (loại xe: xe máy, ô tô 4 chỗ, 7 chỗ), bật/tắt nhận chuyến, xem số chuyến hoàn thành.
- **Chuyến đi**: đặt xe (tự tính giá cước theo loại xe và quãng đường), điều tài xế (tự chọn tài xế rảnh cùng loại xe),
  bắt đầu, hoàn thành, hủy (có lý do). Mỗi lần đổi trạng thái được ghi vào bảng `trip_status_history`.
- **Tổng quan**: số chuyến theo trạng thái, tài xế sẵn sàng, doanh thu trong ngày.

Luồng trạng thái: `requested → assigned → in_progress → completed`, hủy được ở `requested` hoặc `assigned`.

REST API chính: `GET/POST /api/customers`, `GET/POST /api/drivers`, `PATCH /api/drivers/:id/status`,
`GET/POST /api/trips`, `GET /api/trips/:id`, `POST /api/trips/:id/{assign|start|complete|cancel}`, `GET /api/stats`.

## 6. Giám sát (Prometheus + Grafana)

Prometheus thu thập metrics mỗi 15 giây từ:

| Job | Nguồn | Giám sát |
|---|---|---|
| `taxi-app` | `nginx:8081/app-metrics` → app `/metrics` | request/s, độ trễ, status code, số chuyến theo trạng thái |
| `nginx` | nginx-exporter ← `stub_status` | request, kết nối của web server |
| `postgres` | postgres-exporter (user `taxi_monitor`) | kết nối, giao dịch, dung lượng DB |
| `cadvisor` | cAdvisor | CPU/RAM/network từng container |
| `node-exporter` | Node Exporter | CPU/RAM/disk máy host |
| `prometheus`, `grafana`, `loki`, `promtail` | chính các dịch vụ | tình trạng hệ thống giám sát |

Grafana đã provisioning sẵn datasource **Prometheus**, **Loki** và 2 dashboard trong thư mục *Taxi Booking*:
- **Taxi Booking - Giám sát hệ thống**
- **Taxi Booking - Log tập trung (Loki)**

Có thể import thêm dashboard cộng đồng (Dashboards → New → Import): Node Exporter Full `1860`,
cAdvisor `14282`, PostgreSQL `9628`, Nginx `12708`.

Luật cảnh báo trong `monitoring/prometheus/rules/alerts.yml` (xem tại Prometheus → Alerts).

## 7. Log tập trung (Loki + Promtail + LogQL)

Promtail đọc log mọi container của project qua Docker socket (chỉ đọc), gắn label
`service`, `container`, `level`… rồi đẩy về Loki. Truy vấn tại **Grafana → Explore → Loki**:

```logql
{service="app", level=~"error|warn"}
{service="app"} | json | msg="trip_status_changed" | line_format "Chuyến #{{.tripId}}: {{.from}} -> {{.to}}"
sum by (status) (count_over_time({service="nginx"} | json | __error__="" [5m]))
{service="postgres"} |~ "(?i)password authentication failed|FATAL"
```

Danh sách đầy đủ và cách tạo dữ liệu demo: [docs/logql-queries.md](docs/logql-queries.md).

## 8. Hardening

| Biện pháp | Cách thực hiện |
|---|---|
| Non-root container | app (`node` 1000), nginx-unprivileged (101), Grafana (472), Prometheus/exporters (`nobody`), Loki (10001), pgAdmin (5050); PostgreSQL tự hạ quyền xuống user `postgres` |
| Giảm Linux capabilities | `cap_drop: ALL` cho mọi container, chỉ thêm lại quyền tối thiểu (PostgreSQL, pgAdmin) |
| Chống leo thang đặc quyền | `security_opt: no-new-privileges:true` |
| Root filesystem chỉ đọc | `read_only: true` + `tmpfs` cho thư mục tạm |
| Giới hạn tài nguyên | `deploy.resources.limits` (CPU, RAM, số tiến trình) chống DoS/fork bomb |
| Network isolation | 3 mạng tách biệt, `backend` là `internal`, chỉ Nginx publish cổng |
| Mật khẩu mạnh | Không có mật khẩu trong mã nguồn; `.env` sinh ngẫu nhiên 24 ký tự, quyền 600, nằm trong `.gitignore` |
| Least privilege CSDL | `taxi_app` chỉ SELECT/INSERT/UPDATE (không DELETE/DDL), `taxi_report` chỉ đọc, `taxi_monitor` chỉ `pg_monitor`; lịch sử chuyến đi chỉ được thêm |
| Xác thực CSDL | SCRAM-SHA-256, `pg_hba.conf` chỉ chấp nhận dải mạng backend, từ chối phần còn lại |
| Nginx | HTTPS (TLS 1.2/1.3), HTTP→HTTPS, HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, ẩn version, rate limit API và trang đăng nhập, giới hạn kích thước request, chặn `/.env`, `/.git`, `/metrics` |
| Bảo vệ công cụ quản trị | pgAdmin khóa sau 5 lần sai; Grafana tắt đăng ký/ẩn danh, cookie secure; Prometheus bảo vệ bằng Basic Auth |
| Ứng dụng | Truy vấn tham số hóa (chống SQL Injection), validate dữ liệu, không trả stack trace, render bằng `textContent` (chống XSS) |
| Log | Xoay vòng log Docker (10 MB × 3) |

Kiểm tra toàn bộ: `sh scripts/check-hardening.sh`

Ngoại lệ có chủ đích: **cAdvisor** (cần root để đọc cgroup của host) và **Promtail** (cần đọc Docker socket)
vẫn chạy root nhưng mount chỉ đọc, không mở cổng, chỉ nằm trong mạng monitoring.

## 9. Lệnh vận hành thường dùng

```bash
docker compose ps                         # trạng thái
docker compose logs -f app nginx          # xem log
docker compose restart nginx              # nạp lại cấu hình Nginx
docker compose exec nginx nginx -t        # kiểm tra cú pháp Nginx
docker compose down                       # dừng (giữ dữ liệu)
docker compose down -v                    # dừng và XÓA toàn bộ dữ liệu (DB, Grafana, Loki...)
```

## 10. Xử lý sự cố

- **Cổng 80/443 đã bị chiếm**: đổi `HTTP_PORT`, `HTTPS_PORT` trong `.env` (khi đó truy cập `https://localhost:<HTTPS_PORT>`).
- **cAdvisor không có số liệu container** (dashboard CPU/RAM container trống, log cAdvisor báo
  `failed to identify the read-write layer ID`): Docker đang dùng *containerd image store*. Trên Docker Desktop vào
  Settings → General → bỏ chọn *Use containerd for pulling and storing images*; trên Linux thêm
  `{"features": {"containerd-snapshotter": false}}` vào `/etc/docker/daemon.json` rồi khởi động lại Docker.
- **Đổi mật khẩu sau khi đã chạy**: mật khẩu PostgreSQL chỉ áp dụng khi tạo volume lần đầu. Chạy
  `docker compose down -v` rồi `up -d` lại (mất dữ liệu demo) hoặc đổi bằng `ALTER ROLE` trong pgAdmin.
- **Đổi `POSTGRES_DB`/`POSTGRES_USER`**: sửa tên tương ứng trong `db/pg_hba.conf` và `pgadmin/servers.json`.

## 11. Lịch sử commit theo yêu cầu đề bài

| Commit | Nội dung | Yêu cầu |
|---|---|---|
| 1 | App + PostgreSQL + pgAdmin + Nginx reverse proxy HTTPS | 2, 3 |
| 2 | Prometheus + Grafana giám sát container, web server, database | 4 |
| 3 | Loki + Promtail, truy vấn LogQL | 5 |
| 4 | Hardening + README | 6, 1 |
