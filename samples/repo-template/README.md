# shop (repo mẫu)

Repo nhỏ để chạy thử cả trận bằng `python -m orchestrator.cli match --mock`. Code có sẵn lỗi và
thiếu tính năng đúng như các item trong `samples/items/`. Mock fixer (`samples/mock/fixer/*.patch`)
sửa đúng những chỗ đó để gate chạy build/test thật.

Chạy test: `python -m unittest discover -t .`
