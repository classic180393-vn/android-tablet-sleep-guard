# Android Tablet Sleep Guard — Hướng Dẫn Tiếng Việt

Bộ công cụ tối ưu pin & chống tụt pin ngầm dành cho máy tính bảng Android chạy Termux (đạt mức tiêu hao chờ qua đêm chỉ **`~0,2–0,3%/giờ`** thay vì **`1,5–3%/giờ`** khi bị kẹt Wake-Lock).

## 1. Hệ thống giải quyết vấn đề gì?
- **Chống thức giả trong balo/túi xách:** Nhiều bàn phím bao da nam châm dễ bị xê dịch làm cảm biến Hall báo "Mở nắp". `Lid Guard` kiểm tra thêm **cảm biến ánh sáng (`darkLuxThreshold = 0.8 lux`)** — nếu môi trường tối om và đang rút sạc, máy giữ nguyên trạng thái ngủ đông.
- **Chống rò `Wake-Lock` từ Termux:** Chủ động chạy `termux-wake-unlock` có kiểm chứng lại bằng `dumpsys power` (khi nối ADB) và kích hoạt `dumpsys deviceidle force-idle`.
- **Tối ưu tiến trình theo tư duy App-Nap (macOS):** Ghim các daemon theo dõi vào cụm **nhân tiết kiệm điện E-Core (`taskset -pc 0,1`)** + hạ ưu tiên **`nice +10`** để tiến trình nền gần như không ăn pin.
- **Lưu trữ Diff RLE siêu gọn:** Thay vì ghi tràn bộ nhớ mỗi phút, các khoảng thời gian có mức `%`, dòng điện, nhiệt độ và CPU ổn định được gộp chung lại thành 1 bản ghi (`hits`), giới hạn cứng tối đa `96` mốc và `14` ngày.
- **Đo pin Bàn phím rời Bluetooth:** Kèm mã nguồn Android Helper APK thuần Java (`com.atsg.btbattery`), tự đọc `%` qua API chuẩn + BLE GATT (`0x180F`/`0x2A19`), tự nhận biết nấc nhảy firmware (`1%` hay `5-10%`) và tách tốc độ hao lúc gõ vs lúc gập máy ngủ.

## 2. Cài đặt nhanh trên Termux
```bash
pkg update && pkg install -y nodejs git termux-api
git clone https://github.com/classic180393-vn/android-tablet-sleep-guard.git
cd android-tablet-sleep-guard
bash install.sh
```

## 3. Các lệnh sử dụng hằng ngày
```bash
tablet-guard status         # Xem trạng thái ngủ/thức, ADB, pin và tốc độ hao thực
tablet-guard daemon start   # Khởi động daemon Lid Guard + Battery Habit
tablet-guard eco            # Ghim helper về E-cores (0,1), nice +10 & thả wake-lock
tablet-guard battery        # Xem thống kê pin & hiệu quả gộp diff RLE
tablet-guard bt-sync        # Đo pin bàn phím/chuột/bút BT ngay lập tức
tablet-guard bt-report      # Xem tốc độ hao thực tế (%/ngày) của bàn phím rời
```

## 4. Lưu ý an toàn với gói hệ thống OEM & Tải APK dựng sẵn
- Nếu chỉ cần đo pin bàn phím Bluetooth rời mà không muốn tự biên dịch Java, tải sẵn `atsg_btbattery.apk` tại trang [**Releases**](https://github.com/classic180393-vn/android-tablet-sleep-guard/releases/latest) (tự động build công khai trên GitHub Actions).
- Script [`scripts/oem-soft-sleep.sh`](scripts/oem-soft-sleep.sh) chỉ đưa app rác thuộc **Nhóm A (UID độc lập)** vào trạng thái hạn chế chạy nền (`RUN_ANY_IN_BACKGROUND ignore` + `standby-bucket restricted`), hoàn toàn có thể đảo ngược bằng `wake` và không làm lỗi boot/OTA.
- **Không bao giờ** đưa các gói dùng chung `android.uid.system` (`uid=1000`) vào danh sách đóng băng.
- Chạy thử thành công trên máy khác? Chia sẻ tên cảm biến qua [**Mẫu báo cáo thiết bị**](https://github.com/classic180393-vn/android-tablet-sleep-guard/issues/new/choose) để mở rộng cộng đồng!

## 5. Giấy phép
Phát hành theo giấy phép mã nguồn mở **MIT** ([LICENSE](LICENSE)).
