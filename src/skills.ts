/**
 * 技能目录定位与完整文档读取（skill_doc 工具用）。
 * 技能扫描/摘要/校验逻辑在 prompt.ts；本模块单向依赖其中的加载器。
 * 共享常量（SKILLS_DIR 等）放在 paths.ts，避免与 prompt.ts 形成 import 循环。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadSkill, loadSkillDigests, parseFrontmatter, userSkillsDir } from './prompt';
import { SKILLS_DIR } from './paths';
import { errMessage } from './err';

// SKILLS_DIR 已移到 paths.ts；re-export 兼容既有调用方（scripts/unit.ts 等）
export { SKILLS_DIR };

/** 随包发布的内置技能目录名：启动迁移时跳过；发布新内置技能时需加入此列表。 */
const BUILTIN_SKILLS = ['helios-kanban-remote'];

/** 技能目录名规则（与 readSkillDoc 的参数校验一致，同时保证无路径分隔符）。 */
const SKILL_NAME_RE = /^[\w][\w.-]*$/;

/**
 * 安装技能：把含 SKILL.md 的本地目录复制到数据目录 skills/（npm 升级不受影响，永久保留）。
 * 已存在同名技能时整目录替换（即技能更新）；先复制到临时目录再原子改名，中途失败旧版本还在。
 * 支持 ~/ 前缀。源与目标相同或互相嵌套时拒绝（先删后拷会把源一起删掉）。
 */
export function installSkill(srcPath: string): { name: string; dir: string; replaced: boolean } {
  const expanded = srcPath.trim().replace(/^~(?=$|\/)/, os.homedir());
  const src = path.resolve(expanded);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    throw new Error(`路径不存在或不是目录：${srcPath}`);
  }
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
    throw new Error(`该目录下没有 SKILL.md（技能入口文件）：${src}`);
  }
  const name = path.basename(src);
  if (!SKILL_NAME_RE.test(name)) throw new Error(`非法技能目录名「${name}」（仅允许字母数字、_、-、.）`);
  const dest = path.join(userSkillsDir(), name);
  // 源 == 目标（重装已安装技能）或一方在另一方内部：先删后拷会毁掉源，直接拒绝
  const relTo = path.relative(src, dest);
  const relFrom = path.relative(dest, src);
  if (!relTo || !relFrom || (!relTo.startsWith('..') && !path.isAbsolute(relTo)) || (!relFrom.startsWith('..') && !path.isAbsolute(relFrom))) {
    throw new Error(`源目录与安装位置相同或互相嵌套，不能安装：${src}`);
  }
  const tmpDest = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmpDest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.cpSync(src, tmpDest, { recursive: true });
  } catch (err) {
    fs.rmSync(tmpDest, { recursive: true, force: true });
    throw err;
  }
  const replaced = fs.existsSync(dest);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmpDest, dest);
  return { name, dir: dest, replaced };
}

/** 卸载技能：只删数据目录里的；包内内置技能拒绝卸载（随包发布，删除无意义且会被升级还原）。 */
export function uninstallSkill(name: string): void {
  const trimmed = name.trim();
  if (!SKILL_NAME_RE.test(trimmed)) throw new Error(`非法技能名「${trimmed}」`);
  const dir = path.join(userSkillsDir(), trimmed);
  if (!fs.existsSync(dir)) {
    if (fs.existsSync(path.join(SKILLS_DIR, trimmed))) {
      throw new Error(`「${trimmed}」是包内内置技能，不能卸载（可用同名目录放数据目录 skills/ 下覆盖它）`);
    }
    throw new Error(`未找到技能「${trimmed}」（数据目录 skills/ 下不存在）`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 启动迁移：历史上用户只能把技能放进包内 skills/（npm 安装目录），升级即被整目录替换。
 * 这里把包内的非内置技能拷入数据目录持久保存（已存在同名则不动，以数据目录为准）。
 * 返回本次迁移的技能名（供启动日志告知用户）；任何失败都不阻塞启动。
 */
export function migratePackageSkills(pkgSkillsDir: string = SKILLS_DIR): string[] {
  const migrated: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pkgSkillsDir, { withFileTypes: true });
  } catch {
    return migrated;
  }
  for (const e of entries) {
    if (!e.isDirectory() || BUILTIN_SKILLS.includes(e.name)) continue;
    const src = path.join(pkgSkillsDir, e.name);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) continue;
    const dest = path.join(userSkillsDir(), e.name);
    if (fs.existsSync(dest)) continue;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      migrated.push(e.name);
    } catch {
      /* best-effort：权限等问题留给 /skills 报错，不影响启动 */
    }
  }
  return migrated;
}

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
    const skillFile = path.join(dir, 'SKILL.md');
    // 符号链接可指向技能目录外的任意文件（含凭证），拒绝读取
    if (fs.lstatSync(skillFile).isSymbolicLink()) {
      return `已拒绝读取：技能「${trimmed}」的 SKILL.md 是符号链接，不予读取。`;
    }
    const raw = fs.readFileSync(skillFile, 'utf8');
    const { body } = parseFrontmatter(raw);
    return `# 技能 ${loaded.digest.name} 完整文档\n\n${body.trim()}`;
  } catch (err) {
    return `读取技能「${trimmed}」失败：${errMessage(err)}`;
  }
}
