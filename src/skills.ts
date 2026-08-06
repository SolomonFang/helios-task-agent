/**
 * 技能目录定位与完整文档读取（skill_doc 工具用）。
 * 技能扫描/摘要/校验逻辑在 prompt.ts；本模块依赖其中的加载器（单向调用期使用，
 * prompt.ts 仅反向引用 SKILLS_DIR 常量）。
 */

import fs from 'fs';
import path from 'path';
import { loadSkill, loadSkillDigests, parseFrontmatter, userSkillsDir } from './prompt';

/** 包内内置技能目录（兜底；npm 全局安装目录，用户不应往里放自定义技能）。 */
export const SKILLS_DIR = path.join(__dirname, '..', 'skills');

/** 定位技能目录：用户目录优先，包内兜底；不存在返回 null。 */
export function resolveSkillDir(dirName: string): string | null {
  for (const base of [userSkillsDir(), SKILLS_DIR]) {
    const dir = path.join(base, dirName);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

/** 读取技能完整文档（skill_doc 工具用）；name 为空返回技能清单文本。 */
export function readSkillDoc(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    const digests = loadSkillDigests();
    if (!digests.length) return '（skills/ 下没有已安装技能）';
    return digests.map((s) => `- ${s.name}：${s.description || '（无 description）'}`).join('\n');
  }
  if (!/^[\w][\w.-]*$/.test(trimmed)) return `参数错误：非法技能名「${trimmed}」`;
  const dir = resolveSkillDir(trimmed);
  if (!dir) return `未找到技能「${trimmed}」。先用空 name 调用列出已安装技能。`;
  const loaded = loadSkill(dir, trimmed);
  if (!loaded) return `未找到技能「${trimmed}」。先用空 name 调用列出已安装技能。`;
  try {
    const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const { body } = parseFrontmatter(raw);
    return `# 技能 ${loaded.digest.name} 完整文档\n\n${body.trim()}`;
  } catch (err) {
    return `读取技能「${trimmed}」失败：${err instanceof Error ? err.message : err}`;
  }
}
