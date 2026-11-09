// 读取 VotaForge server-profiles.json 当前 active profile 的 busDomainCode。
// 这是 MetadataDomain 的权威来源（用户已确认二者等价）。
//
// 约束：
// - 只读，绝不写文件；
// - 文件缺失/非法/过大/字段缺失一律返回 undefined，不抛错，由调用方回退；
// - 主格式是 activeProfileId + profiles[]（docs/architecture/workspace-protocol.md §4.2），
//   兼容旧 activeProfile 对象；activeProfileId 优先，且绝不猜测第一个 profile。
import * as fs from 'fs';
import * as path from 'path';

/** server-profiles.json 允许的最大读取体积（256 KiB）。 */
const MAX_PROFILE_FILE_BYTES = 256 * 1024;

/**
 * 读取 VotaForge 当前 active profile 的 busDomainCode。
 * 返回值去掉首尾空白后直接作为 MetadataDomain 使用；调用方只需做基础校验。
 */
export function readActiveBusDomainCode(vfRoot: string): string | undefined {
  const file = path.join(vfRoot, '.votaforge', 'server-profiles.json');
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_PROFILE_FILE_BYTES) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const profiles = Array.isArray(raw.profiles)
      ? raw.profiles.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      : [];
    const activeId = typeof raw.activeProfileId === 'string' ? raw.activeProfileId : undefined;
    const active = activeId ? profiles.find((p) => p.id === activeId) : undefined;
    const legacy =
      raw.activeProfile && typeof raw.activeProfile === 'object'
        ? (raw.activeProfile as Record<string, unknown>)
        : undefined;
    // activeProfileId 存在时只认它指向的 profile；即使该 profile 缺失/无 busDomainCode，
    // 也绝不回退到旧 activeProfile，避免把函数注册到另一个环境的域。
    const code = activeId ? active?.busDomainCode : legacy?.busDomainCode;
    return typeof code === 'string' && code.trim() ? code.trim() : undefined;
  } catch {
    return undefined;
  }
}
