# Truy vấn log bằng LogQL (Grafana → Explore → chọn datasource **Loki**)

Promtail gắn cho mỗi dòng log các label: `container`, `service` (tên service trong compose),
`stream` (stdout/stderr), `project="taxi-booking"`, và `level` (với log của app và PostgreSQL).

| #   | Mục đích                                                                 | LogQL                                                                                |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---- | --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Log lỗi và cảnh báo của ứng dụng đặt xe                                  | `{service="app", level=~"error\|warn"}`                                              |
| 2   | Theo dõi hành trình chuyến đi (đổi trạng thái), định dạng lại cho dễ đọc | `{service="app"} \| json                                                             |
| 9   | Đăng nhập ứng dụng thất bại theo IP (dò mật khẩu)                        | `sum by (ip) (count_over_time({service="app"}                                        | json | msg="login_failed" [15m]))` | \| msg="trip_status_changed" \| line_format "Chuyến #{{.tripId}}: {{.from}} -> {{.to}} (tài xế {{.driverId}})"` |
| 3   | Đếm request Nginx theo mã trạng thái HTTP trong 5 phút (metric query)    | `sum by (status) (count_over_time({service="nginx"} \| json                          |
| 9   | Đăng nhập ứng dụng thất bại theo IP (dò mật khẩu)                        | `sum by (ip) (count_over_time({service="app"}                                        | json | msg="login_failed" [15m]))` | \| **error**="" [5m]))`                                                                                         |
| 4   | Phát hiện dò mật khẩu / đăng nhập CSDL thất bại                          | `{service="postgres"} \|~ "(?i)password authentication failed\|FATAL"`               |
| 5   | Request chậm hơn 200 ms ở ứng dụng                                       | `{service="app"} \| json                                                             |
| 9   | Đăng nhập ứng dụng thất bại theo IP (dò mật khẩu)                        | `sum by (ip) (count_over_time({service="app"}                                        | json | msg="login_failed" [15m]))` | \| msg="request" \| duration_ms > 200`                                                                          |
| 6   | Top 5 API được gọi nhiều nhất trong 15 phút                              | `topk(5, sum by (route) (count_over_time({service="app"} \| json                     |
| 9   | Đăng nhập ứng dụng thất bại theo IP (dò mật khẩu)                        | `sum by (ip) (count_over_time({service="app"}                                        | json | msg="login_failed" [15m]))` | \| msg="request" [15m])))`                                                                                      |
| 7   | Tỉ lệ lỗi 5xx của Nginx (%)                                              | `sum(rate({service="nginx"} \| json                                                  |
| 9   | Đăng nhập ứng dụng thất bại theo IP (dò mật khẩu)                        | `sum by (ip) (count_over_time({service="app"}                                        | json | msg="login_failed" [15m]))` | \| status >= 500 [5m])) / sum(rate({service="nginx"} \| json [5m])) \* 100`                                     |
| 8   | Truy cập bị chặn (rate limit 429, đường dẫn ẩn 404)                      | `{service="nginx"}                                                                   |
| 9   | Đăng nhập ứng dụng thất bại theo IP (dò mật khẩu)                        | `sum by (ip) (count_over_time({service="app"}                                        | json | msg="login_failed" [15m]))` | \| json \| status=~"429\|404"`                                                                                  |
| 9   | Đăng nhập ứng dụng thất bại theo IP (dò mật khẩu)                        | `sum by (ip) (count_over_time({service="app"} \| json \| msg="login_failed" [15m]))` |

> Lưu ý: trong bảng Markdown dấu `|` được escape thành `\|`. Khi gõ vào Grafana, dùng `|` bình thường.

## Cách tạo dữ liệu để demo

```bash
# Tạo log lỗi/cảnh báo (401 chưa đăng nhập, 400 JSON hỏng)
curl -sk -X POST https://localhost/api/trips/99/assign -H 'Content-Type: application/json' -d '{}'
curl -sk -X POST https://localhost/api/trips -H 'Content-Type: application/json' -d '{bad json'

# Tạo log đăng nhập ứng dụng thất bại (quá 5 lần/phút/IP sẽ bị Nginx trả 429)
for i in 1 2 3; do curl -sk -X POST https://localhost/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"sai"}'; done

# Tạo log đăng nhập CSDL thất bại
docker exec -e PGPASSWORD=sai_mat_khau taxi-postgres psql -h 127.0.0.1 -U taxi_app -d taxi_booking -c "select 1"

# Tạo log rate limit 429 (gửi 100 request liên tiếp)
for i in $(seq 1 100); do curl -sk -o /dev/null -w "%{http_code} " https://localhost/api/stats; done
```

Dashboard **Taxi Booking - Log tập trung (Loki)** trong Grafana đã dựng sẵn các truy vấn trên.
