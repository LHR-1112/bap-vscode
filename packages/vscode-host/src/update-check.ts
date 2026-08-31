// 检查更新：请求更新源（GitHub Release latest API 或兼容 JSON）对比当前版本。
// 仅供「手动 .vsix 安装」的感知更新：有新版本时通知用户 + 给出下载链接（VS Code 不会对手动安装的扩展自动更新）。
export const DEFAULT_FEED = 'https://api.github.com/repos/LHR-1112/bap-vscode/releases/latest';

export interface UpdateInfo {
  latest: string;
  current: string;
  url: string;
  hasUpdate: boolean;
}

/** semver 比较：candidate > current。容忍 'v' 前缀、段数不同。 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const c = parse(candidate);
  const cur = parse(current);
  const len = Math.max(c.length, cur.length);
  for (let i = 0; i < len; i++) {
    const a = c[i] || 0;
    const b = cur[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

/**
 * 从更新源拉取版本信息。期望 GitHub Release latest 格式（tag_name / html_url / assets[]），
 * 优先返回 .vsix 资产的下载地址；兼容自定义端点（返回同格式 JSON）。失败返回 undefined。
 */
export async function checkLatestRelease(feedUrl: string, currentVersion: string): Promise<UpdateInfo | undefined> {
  try {
    const res = await fetch(feedUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'bap-ide-vscode' },
    });
    // 404 = 仓库尚无任何发布（/releases/latest 无 latest）→ 视为「无更新」，避免误报「无法获取更新信息」
    if (res.status === 404) return { latest: currentVersion, current: currentVersion, url: '', hasUpdate: false };
    if (!res.ok) return undefined;
    const j = (await res.json()) as Record<string, unknown>;
    const tag = typeof j.tag_name === 'string' ? j.tag_name : '';
    if (!tag) return undefined;
    const latest = tag.replace(/^v/i, '');
    let url = typeof j.html_url === 'string' ? j.html_url : '';
    const assets = Array.isArray(j.assets)
      ? (j.assets as Array<{ name?: unknown; browser_download_url?: unknown }>)
      : [];
    const vsix = assets.find((a) => typeof a.name === 'string' && a.name.endsWith('.vsix'));
    if (vsix && typeof vsix.browser_download_url === 'string') url = vsix.browser_download_url;
    return { latest, current: currentVersion, url, hasUpdate: isNewer(latest, currentVersion) };
  } catch {
    return undefined;
  }
}
