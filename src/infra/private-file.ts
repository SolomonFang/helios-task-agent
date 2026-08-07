import fs from 'fs';
import path from 'path';

/**
 * 私有数据文件写入：统一 0600 权限（memory.json、synced-sources.json、audit.log、
 * watch-state.json、update-check.json 都含个人数据）。mode 只对新建生效，
 * 对已存在文件（历史遗留的 0644）再 chmod 一次。
 */
export function writeFilePrivateSync(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }
}

export function appendFilePrivateSync(filePath: string, content: string): void {
  fs.appendFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }
}

/**
 * 私有数据目录创建：统一 0700（~/.helios-task-agent/ 下有 memory.json、audit.log、
 * .env 等个人数据），本机其他用户不得列举。mkdir 的 mode 只对新建生效，
 * 对已存在目录（历史遗留按 umask 0755 创建的）再 chmod 收紧一次。
 */
export function ensurePrivateDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
}

/**
 * 原子写私有文件：ensurePrivateDirSync(所在目录 0700) → 同目录 tmp 文件（0600）→ rename 就位。
 * 避免写盘中途被杀导致目标截断（.env 凭证 / memory.json / watch-state.json 等丢失）；
 * rename 后目标一定是新建的 0600 文件（writeFilePrivateSync 内含 chmod）。
 * config / memory / source-registry / kanban watcher 共用这一个实现，别再复制。
 */
export function writeFileAtomicPrivateSync(filePath: string, content: string): void {
  ensurePrivateDirSync(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFilePrivateSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
