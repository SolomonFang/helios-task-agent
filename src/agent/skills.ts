/**
 * 技能子系统：frontmatter 解析、技能加载/扫描/摘要/校验、目录定位、完整文档读取
 * （skill_doc 工具用）、安装/卸载/启动迁移。
 * 提示词组装（buildSystemPrompt）在 prompt.ts，单向依赖本模块的 renderSkillsBlock。
 * 共享常量（SKILLS_DIR 等）放在 ../infra/paths.ts，避免与 prompt.ts 形成 import 循环（结论在目录下沉后仍成立）。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { defaultDataHome, SKILLS_DIR } from '../infra/paths';
import { ensurePrivateDirSync } from '../infra/private-file';
import { errMessage } from '../infra/err';

/** 用户自定义技能目录：数据目录下 skills/（升级 npm 包不会抹掉，也无安装目录写权限问题）。 */
export function userSkillsDir(): string {
  return path.join(defaultDataHome(), 'skills');
}

/** 单个技能注入系统提示词的摘要长度上限（避免每个回合倾倒全文）。 */
const DIGEST_MAX_LEN = 3500;

export interface SkillDigest {
  /** 技能名：frontmatter name，缺省回退目录名。 */
  name: string;
  /** frontmatter description——路由依据，始终注入。 */
  description: string;
  /** frontmatter digest_sections 声明的章节内容。 */
  digest: string;
  /** 相对项目根的技能目录（提示词中指引按需读取完整文档）。 */
  dir: string;
}

/**
 * 极简 frontmatter 解析：支持 `key: value`、`key: >-`/`|` 折叠/字面块、`- item` 列表。
 * 不引入 YAML 依赖；技能 frontmatter 只应使用这三种形态。
 */
export function parseFrontmatter(raw: string): { data: Record<string, string | string[]>; body: string } {
  // 统一 CRLF → LF：Windows 换行的 SKILL.md 也应能解析
  const text = raw.replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n*/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  const lines = m[1]!.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rest = ''] = kv;
    const cont: string[] = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) cont.push(lines[++i]!);
    if (rest === '>-' || rest === '>') {
      data[key!] = cont.map((l) => l.trim()).join(' ').replace(/\s+$/, '');
    } else if (rest === '|' || rest === '|-') {
      data[key!] = cont.map((l) => l.replace(/^\s+/, '')).join('\n');
    } else if (rest === '') {
      const items = cont.map((l) => l.match(/^\s+-\s+(.*)$/)?.[1]).filter(Boolean) as string[];
      if (items.length) data[key!] = items;
      else data[key!] = '';
    } else {
      data[key!] = rest;
    }
  }
  return { data, body: text.slice(m[0].length) };
}

/** 按声明的章节名（大小写不敏感的子串匹配）摘取 `## ` 章节。 */
function digestSkillBody(body: string, sections: string[]): string {
  if (!sections.length) return '';
  const keep: string[] = [];
  for (const sec of body.split(/\n(?=## )/)) {
    const title = ((sec.match(/^## (.+)/) || [])[1] || '').toLowerCase();
    if (sections.some((s) => title.includes(s.toLowerCase()))) keep.push(sec.trim());
  }
  return keep.join('\n\n').slice(0, DIGEST_MAX_LEN);
}

/** 加载单个技能目录（SKILL.md → 摘要 + 契约问题）；无 SKILL.md 返回 null。 */
export function loadSkill(absDir: string, dirName: string): { digest: SkillDigest; problems: string[] } | null {
  const skillFile = path.join(absDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  const rel = path.relative(process.cwd(), absDir) || absDir;
  const problems: string[] = [];
  // 符号链接可指向技能目录外的任意文件（含凭证），拒绝读取（与 readSkillDoc 一致）
  if (fs.lstatSync(skillFile).isSymbolicLink()) {
    return {
      digest: { name: dirName, description: '', digest: '', dir: rel },
      problems: [`技能「${dirName}」配置问题：SKILL.md 是符号链接，不予读取；文件：${skillFile}`],
    };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(skillFile, 'utf8');
  } catch (err) {
    return {
      digest: { name: dirName, description: '', digest: '', dir: rel },
      problems: [`技能「${dirName}」配置问题：SKILL.md 读取失败（${errMessage(err)}）；文件：${skillFile}`],
    };
  }
  const { data, body } = parseFrontmatter(raw);
  const name = typeof data.name === 'string' && data.name ? data.name : dirName;
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!data.name) problems.push(`技能「${dirName}」配置问题：frontmatter 缺少 name（已回退为目录名）；文件：${skillFile}`);
  if (data.name && name !== dirName)
    problems.push(`技能「${dirName}」配置问题：frontmatter name「${name}」与目录名不一致（skill_doc/skill_exec 按目录名定位将失败）；文件：${skillFile}`);
  if (!description) problems.push(`技能「${dirName}」配置问题：frontmatter 缺少 description（技能路由将不可靠）；文件：${skillFile}`);
  const sections = Array.isArray(data.digest_sections) ? data.digest_sections : [];
  const digest = digestSkillBody(body, sections);
  for (const s of sections) {
    if (!new RegExp(`^## .*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im').test(body)) {
      problems.push(`技能「${dirName}」配置问题：digest_sections「${s}」未匹配到任何章节（拼写或章节已改名？）；文件：${skillFile}`);
    }
  }
  if (!sections.length) problems.push(`技能「${dirName}」配置问题：未声明 digest_sections（仅注入 description，细节靠 skill_doc 按需读取）；文件：${skillFile}`);
  return { digest: { name, description, digest, dir: rel }, problems };
}

/** 默认扫描目录：用户数据目录优先，包内内置目录兜底；同名技能以用户目录为准。 */
const defaultSkillBaseDirs = (): string[] => [userSkillsDir(), SKILLS_DIR];

function skillEntries(baseDirs: string[] = defaultSkillBaseDirs()): Array<{ dirName: string; absDir: string }> {
  const seen = new Set<string>();
  const out: Array<{ dirName: string; absDir: string }> = [];
  for (const base of baseDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ dirName: name, absDir: path.join(base, name) });
    }
  }
  return out;
}

/**
 * 扫描 <用户数据目录>/skills 与包内 skills/ 下的 <name>/SKILL.md，为每个技能生成注入系统提示词的紧凑摘要。
 * 新增技能 = 在 <数据目录>/skills/ 下放一个含 SKILL.md（带 frontmatter）的目录，无需改代码：
 * - `name` / `description` 始终注入（路由依据）；
 * - `digest_sections` 声明哪些章节进系统提示词（契约写在技能自己头上）；
 * - 完整文档留在磁盘，用 skill_doc 工具按需读取（渐进式披露）。
 */
export function loadSkillDigests(): SkillDigest[] {
  const digests: SkillDigest[] = [];
  for (const { dirName, absDir } of skillEntries()) {
    const loaded = loadSkill(absDir, dirName);
    if (loaded) digests.push(loaded.digest);
  }
  return digests;
}

/** 启动期/测试期校验：返回所有技能的契约问题（空数组 = 全部健康）。baseDirs 缺省扫描用户目录 + 包内目录，测试可只传包内目录隔离用户环境。 */
export function validateSkills(baseDirs: string[] = defaultSkillBaseDirs()): string[] {
  const problems: string[] = [];
  for (const { dirName, absDir } of skillEntries(baseDirs)) {
    const loaded = loadSkill(absDir, dirName);
    if (loaded) problems.push(...loaded.problems);
  }
  return problems;
}

/** 渲染系统提示词尾部的技能摘要区块（无技能时返回空串）。 */
export function renderSkillsBlock(): string {
  const digests = loadSkillDigests();
  if (!digests.length) return '';
  const header =
    '# 已安装技能\n\n' +
    '以下技能已安装（用户目录 skills/ 优先，包内内置兜底）。此处只含 description 与关键章节摘要；需要完整细节时用 `skill_doc` 工具读取全文，不要臆造用法。' +
    '技能若自带脚本（node/shell/python 等），按文档说明用 `skill_exec` 工具运行（每次执行都会向用户弹确认）。';
  const blocks = digests.map((s) =>
    [
      `## 技能：${s.name}`,
      s.description,
      s.digest,
      `完整文档：\`${s.dir}/SKILL.md\`（用 skill_doc 读取）`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  return [header, ...blocks].join('\n\n');
}

/** 随包发布的内置技能目录名：启动迁移时跳过；发布新内置技能时需加入此列表。 */
const BUILTIN_SKILLS = ['helios-kanban-remote'];

/** 技能目录名规则（install/uninstall/readSkillDoc 共用，同时保证无路径分隔符）。 */
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
  // 历史崩溃可能残留 <name>.tmp-<pid> 临时目录，安装前 best-effort 清理
  try {
    for (const e of fs.readdirSync(path.dirname(dest))) {
      if (/\.tmp-\d+$/.test(e)) fs.rmSync(path.join(path.dirname(dest), e), { recursive: true, force: true });
    }
  } catch {
    /* best-effort：skills 目录不存在等场景忽略 */
  }
  fs.rmSync(tmpDest, { recursive: true, force: true });
  ensurePrivateDirSync(path.dirname(dest));
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
      throw new Error(`「${trimmed}」是包内内置技能，不能卸载（可放到 ${path.join(userSkillsDir(), trimmed)} 下覆盖它）`);
    }
    throw new Error(`未找到技能「${trimmed}」（${userSkillsDir()} 下不存在）`);
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
    const skillFile = path.join(src, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    // 符号链接可指向包外任意文件（含凭证），不迁移（与 loadSkill/readSkillDoc 的拒绝一致）
    try {
      if (fs.lstatSync(skillFile).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const dest = path.join(userSkillsDir(), e.name);
    if (fs.existsSync(dest)) continue;
    try {
      ensurePrivateDirSync(path.dirname(dest));
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
  if (!SKILL_NAME_RE.test(trimmed)) return `参数错误：非法技能名「${trimmed}」`;
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
