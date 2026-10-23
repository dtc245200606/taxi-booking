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
├── docker-compose.yml          # Toàn bộ hệ thống (14 container)
├── .env.example                # Mẫu biến môi trường (KHÔNG chứa mật khẩu thật)
├── app/                        # Ứng dụng Node.js (Dockerfile multi-stage, user node)
│   ├── src/                    # server.js, auth.js, staff.js, audit.js, mailer.js, driver-apply.js, profile.js, stats.js, routes.js, validate.js, db.js, metrics.js, logger.js
│   └── public/                 # Giao diện web
├── db/
│   ├── init/                   # 01-schema.sql, 02-roles.sh (phân quyền), 03-seed.sql, 04-auth.sql, 05-staff.sql, 06-password-reset.sql, 07-driver-applications.sql, 08-profile.sql
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
| Ứng dụng đặt xe | https://localhost/ | Quản trị: `APP_ADMIN_USER` / `APP_ADMIN_PASSWORD`; nhân viên do admin tạo; khách hàng tự đăng ký |
| pgAdmin 4 | https://localhost/pgadmin/ | `PGADMIN_EMAIL` / `PGADMIN_PASSWORD` trong `.env` |
| Grafana | https://localhost/grafana/ | `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` |
| Prometheus | https://localhost/prometheus/ | Basic Auth `MONITOR_BASIC_AUTH_USER` / `MONITOR_BASIC_AUTH_PASSWORD` |
| Mailpit (hộp thư demo) | https://localhost/mail/ | Basic Auth như Prometheus |

Xem mật khẩu: `cat .env`.

Trong pgAdmin, server **Taxi Booking DB** đã được khai báo sẵn, đăng nhập bằng `POSTGRES_USER` / `POSTGRES_PASSWORD`.

## 5. Chức năng ứng dụng

- **Đăng ký / đăng nhập**: khách hàng tự đăng ký (họ tên, SĐT, email, tên đăng nhập, mật khẩu) → hệ thống tạo
  hồ sơ khách hàng và tài khoản. Tài khoản quản trị được app tạo tự động lúc khởi động từ
  `APP_ADMIN_USER` / `APP_ADMIN_PASSWORD` trong `.env` (nếu hệ thống không còn admin nào hoạt động, tài khoản này
  được khôi phục quyền admin khi app khởi động lại). Phân quyền:
  - **admin** (quản trị viên): toàn bộ chức năng điều phối + quản lý nhân viên + xem nhật ký hoạt động.
  - **dispatcher** (điều phối viên): đặt/điều chuyến, quản lý tài xế và khách hàng; không quản lý tài khoản.
  - **customer** (khách hàng): chỉ đặt xe cho mình, xem và hủy chuyến của mình.
- **Quản lý nhân viên** (tab *Nhân viên*, chỉ admin): chỉ quản lý tài khoản **điều phối viên** — tạo tài khoản với
  **mật khẩu tạm ngẫu nhiên** (chỉ hiển thị một lần, nhân viên bắt buộc đổi ở lần đăng nhập đầu), khóa/mở khóa
  (khóa = đăng xuất ngay mọi thiết bị), đặt lại mật khẩu, thu hồi phiên đăng nhập. Admin là tài khoản quản trị
  **duy nhất** (tạo từ `.env`): không hiện trong danh sách nhân viên, API quản trị không tạo thêm admin, không nâng
  quyền nhân viên lên admin và không tác động được vào tài khoản admin.
- **Hồ sơ cá nhân** (bấm vào avatar ở góc phải → menu *Hồ sơ cá nhân / Đổi mật khẩu / Thiết bị đăng nhập /
  Đăng xuất*), áp dụng cho mọi vai trò:
  - Xem thông tin tài khoản (tên đăng nhập, vai trò, ngày tạo, lần đăng nhập và đổi mật khẩu gần nhất).
  - Sửa họ tên, SĐT, email. Đổi **SĐT / email phải nhập mật khẩu hiện tại** (email là kênh lấy lại mật khẩu).
    Khách hàng bắt buộc có SĐT; khách đã là tài xế thì họ tên, SĐT được đồng bộ sang hồ sơ tài xế.
  - Đổi mật khẩu; đổi xong các thiết bị khác bị đăng xuất.
  - Xem các thiết bị đang đăng nhập (trình duyệt, hệ điều hành, IP, thời gian) và đăng xuất từng thiết bị hoặc
    tất cả thiết bị khác.
- **Quên mật khẩu** (khách hàng có khai báo email): bấm *Quên mật khẩu?* ở trang đăng nhập → nhập email → hệ thống
  gửi link đặt lại (token ngẫu nhiên, **dùng 1 lần, hết hạn 30 phút**, DB chỉ lưu SHA-256; tối đa 3 email/giờ/tài khoản).
  Luôn trả lời giống nhau dù email có tồn tại hay không (không dò được email đã đăng ký); token nằm sau dấu `#`
  của URL nên không lọt vào access log Nginx; đặt lại xong mọi phiên cũ bị đăng xuất. Nhân viên quên mật khẩu thì
  admin đặt lại trong tab *Nhân viên*.
  - Email mặc định gửi vào **Mailpit** (container `mailpit`, hộp thư giả trong mạng `backend`), xem tại
    https://localhost/mail/. Gửi email thật: đặt `SMTP_HOST/PORT/SECURE/USER/PASS` trong `.env` (vd Gmail
    `smtp.gmail.com:465` + App Password) và vì mạng `backend` không ra Internet, cần thêm cho service `app` một mạng
    có đường ra ngoài.
- **Nhật ký hoạt động** (tab *Nhật ký*, chỉ admin): bảng `audit_log` ghi ai làm gì, lúc nào, từ IP nào (đăng nhập,
  đăng nhập sai, đặt/điều/hủy chuyến, thêm tài xế, khóa tài khoản...). Lọc theo nhóm, người thực hiện, khoảng ngày.
  Tài khoản CSDL `taxi_app` chỉ có quyền `SELECT, INSERT` trên bảng này → **không sửa/xóa được dấu vết**.
  Mỗi bản ghi cũng được ghi ra log JSON (`msg="audit"`) để truy vấn trên Loki.

  Bảo mật: mật khẩu băm bằng **scrypt** + salt riêng; phiên đăng nhập là token ngẫu nhiên trong cookie
  `HttpOnly; Secure; SameSite=Strict`, DB chỉ lưu SHA-256 của token (bảng `sessions`, đăng xuất = thu hồi);
  Nginx giới hạn `/api/auth/login|register` 5 request/phút/IP; đăng nhập sai ghi log `login_failed` và metric
  `taxi_auth_events_total`.
- **Khách hàng**: thêm mới, xem danh sách và số chuyến đã đi.
- **Tài xế**: thêm mới (loại xe: xe máy, ô tô 4 chỗ, 7 chỗ), bật/tắt nhận chuyến, xem số chuyến hoàn thành.
- **Đăng ký làm tài xế** (tab *Làm tài xế* của khách hàng): khách khai thông tin cá nhân (ngày sinh - đủ 18 tuổi,
  CCCD 12 số), phương tiện (loại xe, biển số, hãng/dòng xe) và **giấy phép lái xe** - hạng GPLX lọc theo loại xe:
  xe máy `A1, A` (mẫu cũ `A2`); ô tô `B, C1, C, D1, D2, D` (mẫu cũ `B2, E`); **không nhận B1 mẫu cũ** (không được
  kinh doanh vận tải). GPLX ô tô bắt buộc nhập ngày hết hạn và phải còn hiệu lực; GPLX xe máy không thời hạn.
  Khách phải tick đồng ý **từng điều khoản hợp tác** (hợp đồng, luật giao thông, điều kiện phương tiện, quy tắc ứng
  xử, giá cước, dữ liệu cá nhân, cam kết trung thực); hệ thống lưu phiên bản điều khoản + thời điểm + IP làm bằng
  chứng. Mỗi khách chỉ có 1 hồ sơ chờ duyệt; nhân viên **duyệt / từ chối (kèm lý do)** trong tab *Tài xế* (số hồ sơ
  chờ duyệt hiện trên tab). Duyệt → tạo tài xế gắn với tài khoản khách, trạng thái *Nghỉ* cho tới khi tổng đài bật
  nhận chuyến. Mọi bước đều ghi nhật ký; tài khoản báo cáo `taxi_report` không đọc được CCCD / ngày sinh.
- **Chuyến đi**: đặt xe (tự tính giá cước theo loại xe và quãng đường), điều tài xế (tự chọn tài xế rảnh cùng loại xe),
  bắt đầu, hoàn thành, hủy (có lý do). Mỗi lần đổi trạng thái được ghi vào bảng `trip_status_history`.
- **Tổng quan**: số chuyến theo trạng thái, tài xế sẵn sàng, doanh thu trong ngày (tính theo ngày giờ Việt Nam).
  **Bấm vào từng thẻ số liệu** để mở thống kê chi tiết, có bộ lọc Hôm nay / 7 ngày / 30 ngày / Tất cả:
  - *Chờ tài xế*: thời gian chờ, cung - cầu tài xế theo loại xe (báo thiếu tài xế), danh sách khách đang chờ.
  - *Đang phục vụ*: từng chuyến đang đón / đang chạy kèm tài xế, doanh thu dự kiến.
  - *Hoàn thành*: doanh thu, giá / quãng đường / thời gian trung bình, biểu đồ theo giờ hoặc ngày, theo loại xe,
    top tài xế và top khách hàng.
  - *Đã hủy*: tỉ lệ hủy, hủy trước / sau khi có tài xế, lý do hủy, khách hủy nhiều, doanh thu bị mất.
  - *Tài xế*: trạng thái theo loại xe, tỉ lệ đang chở, hiệu suất từng tài xế (chuyến, doanh thu, bị hủy).
  - *Khách hàng*: khách mới, khách hoạt động, chi tiêu trung bình, khách lâu không đặt xe, top chi tiêu.
  - *Doanh thu*: so với kỳ trước, biểu đồ theo giờ / ngày, theo loại xe, top tài xế và khách hàng.

Luồng trạng thái: `requested → assigned → in_progress → completed`, hủy được ở `requested` hoặc `assigned`.

REST API chính: `POST /api/auth/{register|login|logout|password|forgot|reset}`, `GET /api/auth/me`, `GET /api/driver-application/{terms|me}`, `POST /api/driver-application[/cancel]`, `GET/PATCH /api/profile`, `POST /api/profile/sessions/{:id/revoke|revoke-others}`, `GET /api/driver-applications`, `POST /api/driver-applications/:id/{approve|reject}`, `GET/POST /api/admin/staff`, `PATCH /api/admin/staff/:id`, `POST /api/admin/staff/:id/{reset-password|revoke-sessions}`, `GET /api/admin/audit`, `GET/POST /api/customers`, `GET/POST /api/drivers`, `PATCH /api/drivers/:id/status`,
`GET/POST /api/trips`, `GET /api/trips/:id`, `POST /api/trips/:id/{assign|start|complete|cancel}`, `GET /api/stats`, `GET /api/stats/detail/{waiting|serving|completed|cancelled|drivers|customers|revenue}?period=today|7d|30d|all`.

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

### Dữ liệu demo (ảo)

```bash
sh scripts/seed-demo.sh            # tạo dữ liệu demo (báo lỗi nếu đã có)
sh scripts/seed-demo.sh --reset    # xóa demo cũ rồi tạo lại (ngày tháng cập nhật theo hôm nay)
sh scripts/seed-demo.sh --remove   # chỉ xóa dữ liệu demo
```

Tạo 45 khách hàng (32 có tài khoản), 3 điều phối viên (`dieuphoi01`, `dieuphoi02`; `dieuphoi03` bị khóa),
20 tài xế + 3 tài xế từ hồ sơ đã duyệt, ~600 chuyến đi trong 30 ngày (dồn vào giờ cao điểm, có chuyến đang
diễn ra), 10 hồ sơ đăng ký tài xế. Mật khẩu mọi tài khoản demo: `demo1234` (đổi bằng biến `DEMO_PASSWORD`).
Dữ liệu demo nhận diện qua SĐT `0399…` (khách), `0398…` (tài xế), `0397…` (nhân viên) nên xóa được sạch mà
không ảnh hưởng dữ liệu thật; nếu dữ liệu thật đang tham chiếu tới dữ liệu demo, lệnh xóa sẽ dừng và báo lỗi.
Script nằm ở `db/demo/` (không nằm trong `db/init/` nên không tự chạy khi khởi tạo CSDL).

### Kiểm tra số liệu khớp nhau giữa các mục

```bash
node scripts/check-consistency.mjs            # so khớp chéo, chỉ đọc - không thay đổi dữ liệu
node scripts/check-consistency.mjs --actions  # thêm: thao tác thật rồi kiểm tra từng mục thay đổi đúng ±1
sh scripts/seed-demo.sh --reset               # dọn dữ liệu thử do --actions tạo ra (SĐT 0399…)
```

- **So khớp chéo**: mỗi số liệu được lấy từ mọi nơi nó xuất hiện (thẻ Tổng quan, thống kê chi tiết,
  tab Tài xế / Khách hàng, danh sách chuyến, hồ sơ tài xế) và phải bằng nhau. Ví dụ: số chuyến đang phục vụ
  = số tài xế đang chở khách; tổng doanh thu = cộng doanh thu từng tài xế = cộng theo loại xe = cộng biểu đồ.
- **Thao tác thật**: duyệt hồ sơ tài xế (tổng tài xế +1, hồ sơ chờ −1), bật nhận chuyến, từ chối hồ sơ,
  khách đăng ký, nhân viên thêm khách, đặt xe, điều tài xế, bắt đầu, hoàn thành (doanh thu hôm nay + giá
  cước), khách hủy - kiểm tra mọi mục liên quan thay đổi đúng và mục không liên quan giữ nguyên.
- Thoát với mã 1 nếu có chỗ không khớp (dùng được trong CI). Tài khoản dùng để kiểm tra: biến `CHECK_USER`,
  `CHECK_PASS` (mặc định `dieuphoi01` / `demo1234`).

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
