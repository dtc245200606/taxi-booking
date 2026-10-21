# Truy vấn log bằng LogQL (Grafana → Explore → chọn datasource **Loki**)

Promtail gắn cho mỗi dòng log các label: `container`, `service` (tên service trong compose),
`stream` (stdout/stderr), `project="taxi-booking"`, và `level` (với log của app và PostgreSQL).

| # | Mục đích | LogQL |
|---|----------|-------|
| 1 | Log lỗi và cảnh báo của ứng dụng đặt xe | `{service="app", level=~"error\|warn"}` |
| 2 | Theo dõi hành trình chuyến đi (đổi trạng thái), định dạng lại cho dễ đọc | `{service="app"} \| json \| msg="trip_status_changed" \| line_format "Chuyến #{{.tripId}}: {{.from}} -> {{.to}} (tài xế {{.driverId}})"` |
| 3 | Đếm request Nginx theo mã trạng thái HTTP trong 5 phút (metric query) | `sum by (status) (count_over_time({service="nginx"} \| json \| __error__="" [5m]))` |
| 4 | Phát hiện dò mật khẩu / đăng nhập CSDL thất bại | `{service="postgres"} \|~ "(?i)password authentication failed\|FATAL"` |
| 5 | Request chậm hơn 200 ms ở ứng dụng | `{service="app"} \| json \| msg="request" \| duration_ms > 200` |
| 6 | Top 5 API được gọi nhiều nhất trong 15 phút | `topk(5, sum by (route) (count_over_time({service="app"} \| json \| msg="request" [15m])))` |
| 7 | Tỉ lệ lỗi 5xx của Nginx (%) | `sum(rate({service="nginx"} \| json \| status >= 500 [5m])) / sum(rate({service="nginx"} \| json [5m])) * 100` |
| 8 | Truy cập bị chặn (rate limit 429, đường dẫn ẩn 404) | `{service="nginx"} \| json \| status=~"429\|404"` |

> Lưu ý: trong bảng Markdown dấu `|` được escape thành `\|`. Khi gõ vào Grafana, dùng `|` bình thường.

## Cách tạo dữ liệu để demo

```bash
# Tạo log lỗi/cảnh báo (409, 404, 400)
curl -sk -X POST https://localhost/api/trips/99/assign -H 'Content-Type: application/json' -d '{}'
curl -sk -X POST https://localhost/api/trips -H 'Content-Type: application/json' -d '{bad json'

# Tạo log đăng nhập CSDL thất bại
docker exec -e PGPASSWORD=sai_mat_khau taxi-postgres psql -h 127.0.0.1 -U taxi_app -d taxi_booking -c "select 1"

# Tạo log rate limit 429 (gửi 100 request liên tiếp)
for i in $(seq 1 100); do curl -sk -o /dev/null -w "%{http_code} " https://localhost/api/stats; done
```

Dashboard **Taxi Booking - Log tập trung (Loki)** trong Grafana đã dựng sẵn các truy vấn trên.
