import fs from 'fs';

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
