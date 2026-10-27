# shop (repo mẫu)

Repo nhỏ làm fixture cho test của pack (E2E với fake root). Code có sẵn lỗi và
thiếu tính năng đúng như các item trong `samples/items/`. Mock fixer (`samples/mock/fixer/*.patch`)
sửa đúng những chỗ đó để gate chạy build/test thật.

Chạy test: `python -m unittest discover -t .`
