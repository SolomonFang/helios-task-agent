/**
 * 即时命令与确定性短语的分发判定（自 handler.ts 抽出的纯函数，便于单测与阅读）：
 * 不进串行队列的即时命令路由，以及「重试这个任务」「重新审查这个任务」等
 * 诊断/审查链路向用户承诺过的确定性文本短语的识别。命中后的执行逻辑仍在 handler.ts。
 */

/** 剥掉尾部标点与空白：用户随手敲成「重试这个任务。」「恢复确认！」不能静默降级为模型闲聊或查询分支。 */
export const stripTailPunct = (s: string): string => s.replace(/[\s。！？!?，,．.…~～]+$/u, '');

/** 即时命令键解析：「恢复确认」是纯文本写法，与 /confirm 同路；其余按斜杠命令原名（未命中返回 null）。 */
export function resolveInstantCommandKey(cmd: string | null, text: string): string | null {
  if (cmd === '/confirm' || stripTailPunct(text) === '恢复确认') return '/confirm';
  return cmd;
}

/**
 * 确定性短语识别（匹配前剥掉尾部标点与空白，随手敲的「重试这个任务。」也须命中）：
 * 这些短语是诊断/审查链路向用户承诺过的文本出路，须确定性命中，不能仅靠模型自觉
 * （pendingNotes 上限/LRU 淘汰/历史裁剪后承诺会失效）。
 */
export function matchDeterministicPhrase(text: string): 'retry' | 'review' | null {
  const phrase = stripTailPunct(text);
  if (phrase === '重试这个任务') return 'retry';
  if (phrase === '重新审查这个任务') return 'review';
  return null;
}
