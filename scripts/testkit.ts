/**
 * 单测脚本共用的最小断言输出套件：PASS/FAIL 打印 + failures 计数。
 * 各 unit*.ts 以 tsx 直接运行（无测试框架），import 本模块即可；
 * 脚本末尾调用 finish() 汇总并以非零退出码报告失败。
 */

import { errMessage } from '../src/err';

let failures = 0;

export const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/** try/catch 包装：异常即 FAIL。 */
export async function checkAsync(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    check(name, true);
  } catch (err) {
    check(name, false, errMessage(err));
  }
}

/** 汇总打印并退出：有失败时退出码为 1。 */
export function finish(): void {
  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}
