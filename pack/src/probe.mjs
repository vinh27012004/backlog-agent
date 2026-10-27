// Worktree "probe" ở base (mục 5, ý tưởng ut-bb của harness mẫu: test không thể fail khi code sai thì không chứng minh
// gì): gate chép riêng file test của item vào đây và chạy trên code CHƯA sửa. Test mới mà vẫn pass thì nó không tái hiện
// lỗi / không kiểm thay đổi. Một probe mỗi trận, cài dependency một lần (job nền lúc tạo worktree item đầu tiên), dùng
// tuần tự vì nhiều gate có thể chạy song song. Bị kill giữa chừng thì lần dùng sau tự dọn trước khi chạy.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepareWorktreeEnv } from './environment.mjs';
import { git } from './git.mjs';

export class Probe {
  constructor({ checkoutRoot, teamWork, folder, mainMatchRoot, logDir }) {
    this.checkoutRoot = checkoutRoot;
    this.mainMatchRoot = mainMatchRoot;
    this.logDir = logDir;
    this.root = join(teamWork, 'wt', '_probe');
    this.matchRoot = join(this.root, folder);
    this.marker = join(teamWork, 'wt', '_probe.ready');
    this.setup = null;
    this.queue = Promise.resolve();
    this.error = null;
  }

  // Bắt đầu chuẩn bị (không chặn người gọi); gọi lại nhiều lần vô hại. Trả promise<boolean>.
  prepare() {
    if (existsSync(this.marker) && existsSync(join(this.root, '.git'))) return Promise.resolve(true);
    this.setup ??= (async () => {
      if (!existsSync(this.root)) {
        await git(['worktree', 'add', '--detach', this.root, 'HEAD'], { cwd: this.checkoutRoot, timeoutMs: 120_000 });
      } else {
        await this.clean();
      }
      const env = await prepareWorktreeEnv({ progress: [] }, { wtMatchRoot: this.matchRoot, mainMatchRoot: this.mainMatchRoot,
        key: 'probe', logDir: this.logDir });
      if (!env.ok) throw new Error(`probe setup failed: ${env.failure}`);
      writeFileSync(this.marker, `${new Date().toISOString()}\n`, 'utf8');
      this.error = null;
      return true;
    })().catch(error => {
      this.error = String(error?.message ?? error).slice(0, 200);
      this.setup = null;
      return false;
    });
    return this.setup;
  }

  // Chờ probe sẵn sàng tối đa `ms`.
  ready(ms) {
    return Promise.race([this.prepare(), new Promise(resolve => { setTimeout(() => resolve(false), ms).unref?.(); })]);
  }

  // Chỉ reset/clean khi thư mục đúng là worktree (có file .git riêng), nếu không git sẽ tìm lên checkout chính.
  async clean() {
    if (!existsSync(join(this.root, '.git'))) throw new Error('probe is not a git worktree');
    await git(['reset', '-q', '--hard'], { cwd: this.root, allowFail: true });
    await git(['clean', '-fdq'], { cwd: this.root, allowFail: true });
  }

  // Chạy `fn(matchRoot)` khi probe ở `base` và có thêm `files` [{path tương đối checkoutRoot, from}]; xong thì dọn.
  run(base, files, fn) {
    const task = this.queue.then(async () => {
      await this.clean();
      await git(['checkout', '-q', '--detach', base], { cwd: this.root, timeoutMs: 60_000 });
      for (const f of files) {
        const to = join(this.root, f.path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(f.from, to);
      }
      try { return await fn(this.matchRoot); } finally { await this.clean(); }
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
