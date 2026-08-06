/**
 * 配置向导（CLI / bot 共用）的终端交互原语：
 * 模型预设列表选择与密钥掩码输入，均遵循「rl.pause → 交互 → rl.resume」模式，
 * 避免 readline 与 raw 模式（selectList / readSecret）抢输入。
 */

import readline from 'readline';
import { currentConfig } from './config';
import { readSecret, selectList } from './ui';
import type { AskFn, ChooseFn } from './types';

/** 模型预设选择：箭头列表；重配时标题给出当前模型，避免用户忘记自己之前选的是什么。 */
export function wizardChoose(rl: readline.Interface, after?: () => void): ChooseFn {
  return async (presets) => {
    rl.pause();
    try {
      const current = currentConfig().llmModel;
      const title = `配置模型（OpenAI 兼容协议${current ? `，当前 ${current}` : ''}）：`;
      return await selectList({ title, options: presets });
    } finally {
      rl.resume();
      after?.();
    }
  };
}

/** 密钥掩码输入（仅 TTY；非 TTY 返回 undefined，向导内自动回退普通输入）。 */
export function wizardAskSecret(rl: readline.Interface, isTTY: boolean, after?: () => void): AskFn | undefined {
  if (!isTTY) return undefined;
  return async (promptText) => {
    rl.pause();
    try {
      return await readSecret(promptText);
    } finally {
      rl.resume();
      after?.();
    }
  };
}
