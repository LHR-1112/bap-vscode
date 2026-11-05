// CLAUDE.md / AGENTS.md 的标记段合并：插件只维护自己生成的段落，用户手写内容原样保留。
// 纯函数，便于单测；保留 BOM 与原文件换行风格。
export const AGENT_MARKER_BEGIN =
  '<!-- BEGIN bap-ide-agent-instructions (auto-generated; do not edit inside) -->';
export const AGENT_MARKER_END = '<!-- END bap-ide-agent-instructions -->';

export interface MergeMarkedSectionResult {
  content: string;
  action: 'created' | 'updated' | 'appended';
  warning?: string;
}

/** 只去掉末尾的空行 / 纯空白行，保留最后一行内容自身的行尾空白（如 Markdown 硬换行）。 */
function trimTrailingBlankLines(text: string): string {
  return text.replace(/(?:\n[ \t]*)+$/, '');
}

/** 只去掉开头的空行 / 纯空白行，保留首行内容自身的缩进（如缩进代码块）。 */
function trimLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '');
}

function appendBlock(text: string, block: string): string {
  const pre = trimTrailingBlankLines(text);
  return pre ? `${pre}\n\n${block}\n` : `${block}\n`;
}

/**
 * 找出第一个「有效」标记段：某个 END 之前存在 BEGIN。
 * 取该 END 之前最近的 BEGIN，避免把孤立的 BEGIN 与后续追加段的 END 配对，
 * 从而误删两者之间的用户内容；孤立 END 在 BEGIN 之前时继续找下一个 END。
 */
function findValidBlock(text: string): { begin: number; end: number } | undefined {
  let from = 0;
  for (;;) {
    const end = text.indexOf(AGENT_MARKER_END, from);
    if (end < 0) return undefined;
    const begin = text.lastIndexOf(AGENT_MARKER_BEGIN, end - 1);
    if (begin >= 0) return { begin, end };
    from = end + AGENT_MARKER_END.length;
  }
}

/** 用标记段替换/追加生成内容；重复标记段会被合并。 */
export function mergeMarkedSection(
  existing: string | undefined,
  generated: string,
): MergeMarkedSectionResult {
  const hasBom = !!existing && existing.startsWith('﻿');
  const raw = hasBom ? existing!.slice(1) : (existing ?? '');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const text = raw.replace(/\r\n/g, '\n');
  const body = generated.replace(/\r\n/g, '\n').trim();
  const block = `${AGENT_MARKER_BEGIN}\n${body}\n${AGENT_MARKER_END}`;
  const finish = (s: string): string => (hasBom ? '﻿' : '') + s.replace(/\n/g, eol);

  if (!text.trim()) {
    return { content: finish(`${block}\n`), action: 'created' };
  }

  const first = findValidBlock(text);
  if (!first) {
    return {
      content: finish(appendBlock(text, block)),
      action: 'appended',
      ...(text.includes(AGENT_MARKER_BEGIN) || text.includes(AGENT_MARKER_END)
        ? { warning: '检测到不完整的 BAP 标记段（缺少 BEGIN 或 END），已追加新的完整标记段并保留原内容' }
        : {}),
    };
  }

  const before = text.slice(0, first.begin);
  let after = text.slice(first.end + AGENT_MARKER_END.length);

  // 去掉后续重复的完整标记段，避免多次生成后文件里堆叠多份。
  let duplicated = false;
  for (;;) {
    const b = findValidBlock(after);
    if (!b) break;
    after = after.slice(0, b.begin) + after.slice(b.end + AGENT_MARKER_END.length);
    duplicated = true;
  }

  const head = trimTrailingBlankLines(before);
  const tail = trimTrailingBlankLines(trimLeadingBlankLines(after));
  const parts = [head, block, tail].filter((p) => p.length > 0);
  return {
    content: finish(`${parts.join('\n\n')}\n`),
    action: 'updated',
    ...(duplicated ? { warning: '检测到重复的 BAP 标记段，已合并为一个' } : {}),
  };
}
