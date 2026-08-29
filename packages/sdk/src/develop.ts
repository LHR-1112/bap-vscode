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
// 属性格式：全局匹配每个 属性="值"，不锚定标签开头（避免一次逻辑消费整行只抓第一个属性）
const ATTR_RE = /(?:^|[^A-Za-z])(Project|Uri|User|Password|AdminTool|LocalNioPort)\s*=\s*["']([^"']*)["']/gi;

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
};

function normalizeToConfig(pairs: Array<[string, string]>): DevelopConfig {
  const cfg: Partial<DevelopConfig> = {};
  for (const [rawKey, value] of pairs) {
    const key = KEY_MAP[rawKey.toLowerCase()];
    if (key) cfg[key] = value.trim();
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
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(cleaned)) !== null) {
    pairs.push([m[1], decodeEntities(m[2] ?? '')]);
  }

  if (pairs.length === 0) {
    throw new SdkError(`.develop 配置为空或格式无法解析: ${file}`, 'CONFIG_INCOMPLETE');
  }
  return normalizeToConfig(pairs);
}
