// .develop 配置解析（支持 entry-key 与属性两种格式，字段大小写不敏感）。
// 不引入 XML 依赖（遵守轻依赖决策），用正则解析。
import * as fs from 'fs';
import * as path from 'path';
import type { DevelopConfig } from './types';

/** SDK 错误（带稳定 code）。 */
export class SdkError extends Error {
  readonly code: string;
  constructor(message: string, code = 'SDK', cause?: unknown) {
    super(message);
    this.name = 'SdkError';
    this.code = code;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

const ENTRY_RE = /<entry\s+key=["']([^"']+)["']\s*>(.*?)<\/entry>/gi;
// 属性格式：只扫描 <Development ...> 标签内部，避免把 entry 文本里的
// `MetadataDomain="FAKE"` 误当属性；分别匹配双/单引号值，值内可含另一种引号。
const DEV_TAG_RE = /<\s*Development\b((?:"[^"]*"|'[^']*'|[^>])*)>/gi;
const ATTR_PAIR_RE = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function stripComments(xml: string): string {
  return xml
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\?xml[\s\S]*?\?>/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** 属性值 XML 转义（decodeEntities 的逆函数）。 */
function encodeEntities(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 字段名 -> DevelopConfig 键
const KEY_MAP: Record<string, keyof DevelopConfig> = {
  project: 'projectUuid',
  uri: 'uri',
  wsuri: 'uri',
  user: 'user',
  pwd: 'pwd',
  password: 'pwd',
  admintool: 'adminTool',
  tool: 'adminTool',
  localnioport: 'localNioPort',
  metadatadomain: 'metadataDomain',
};

function normalizeToConfig(pairs: Array<[string, string]>): DevelopConfig {
  const cfg: Partial<DevelopConfig> = {};
  for (const [rawKey, value] of pairs) {
    const key = KEY_MAP[rawKey.toLowerCase()];
    if (!key) continue;
    // MetadataDomain 只做只读兼容：空值视为未配置，不参与域解析。
    if (key === 'metadataDomain' && !value.trim()) continue;
    cfg[key] = value.trim();
  }
  if (!cfg.projectUuid) throw new SdkError('配置缺少 Project（projectUuid）', 'CONFIG_INCOMPLETE');
  if (!cfg.uri) throw new SdkError('配置缺少 Uri（服务器地址）', 'CONFIG_INCOMPLETE');
  return cfg as DevelopConfig;
}

/** 加载并解析 workspaceRoot/.develop。不存在/缺关键字段抛 SdkError。 */
export function loadDevelop(workspaceRoot: string): DevelopConfig {
  const file = path.join(workspaceRoot, '.develop');
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    throw new SdkError(`未找到 .develop 配置: ${file}`, 'MISSING_DEVELOP');
  }

  const pairs: Array<[string, string]> = [];
  const cleaned = stripComments(xml);

  // 形式 A：<entry key="x">value</entry>
  let m: RegExpExecArray | null;
  ENTRY_RE.lastIndex = 0;
  while ((m = ENTRY_RE.exec(cleaned)) !== null) {
    pairs.push([m[1], decodeEntities(m[2] ?? '')]);
  }
  // 形式 B：<Development Project=... Uri=... />
  let tag: RegExpExecArray | null;
  DEV_TAG_RE.lastIndex = 0;
  while ((tag = DEV_TAG_RE.exec(cleaned)) !== null) {
    const body = tag[1] ?? '';
    ATTR_PAIR_RE.lastIndex = 0;
    while ((m = ATTR_PAIR_RE.exec(body)) !== null) {
      const value = m[2] !== undefined ? m[2] : (m[3] ?? '');
      pairs.push([m[1], decodeEntities(value)]);
    }
  }

  if (pairs.length === 0) {
    throw new SdkError(`.develop 配置为空或格式无法解析: ${file}`, 'CONFIG_INCOMPLETE');
  }
  return normalizeToConfig(pairs);
}

/**
 * 读取旧 .develop 中已有的 MetadataDomain（只读兼容）。
 * 文件缺失/格式不完整时视为无域：绝不新增、绝不删除、绝不清空。
 */
function readExistingMetadataDomain(workspaceRoot: string): string | undefined {
  try {
    const domain = loadDevelop(workspaceRoot).metadataDomain?.trim();
    return domain || undefined;
  } catch {
    return undefined;
  }
}

/** 写入 .develop（Java 同款单标签属性格式）。会覆盖原文件，请先确认意图。 */
export function writeDevelop(
  workspaceRoot: string,
  cfg: { projectUuid: string; uri: string; user: string; pwd: string; adminTool?: string; localNioPort?: string },
): void {
  // 覆盖写会保留原文件已有的 MetadataDomain（旧 IDEA 配置），本插件绝不新增/删除/清空该字段。
  const existingDomain = readExistingMetadataDomain(workspaceRoot);
  const domainAttr = existingDomain ? ` MetadataDomain="${encodeEntities(existingDomain)}"` : '';
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n\n` +
    `<Development Project="${encodeEntities(cfg.projectUuid)}" Uri="${encodeEntities(cfg.uri)}" AdminTool="${encodeEntities(cfg.adminTool ?? 'bap.client.BapMainFrame')}" User="${encodeEntities(cfg.user)}" Password="${encodeEntities(cfg.pwd)}" LocalNioPort="-1"${domainAttr}/>`;
  fs.writeFileSync(path.join(workspaceRoot, '.develop'), xml, 'utf8');
}
