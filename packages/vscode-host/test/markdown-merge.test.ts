// CLAUDE.md / AGENTS.md 标记段合并：保留用户内容、幂等、换行/BOM 保持。
import { describe, it, expect } from 'vitest';
import {
  mergeMarkedSection,
  AGENT_MARKER_BEGIN,
  AGENT_MARKER_END,
} from '../src/agent/markdown-merge';

const block = (body: string): string => `${AGENT_MARKER_BEGIN}\n${body}\n${AGENT_MARKER_END}`;

describe('mergeMarkedSection', () => {
  it('无文件 → 新建，包含完整标记段', () => {
    const r = mergeMarkedSection(undefined, 'GENERATED');
    expect(r.action).toBe('created');
    expect(r.warning).toBeUndefined();
    expect(r.content).toContain(AGENT_MARKER_BEGIN);
    expect(r.content).toContain('GENERATED');
    expect(r.content).toContain(AGENT_MARKER_END);
  });

  it('空白文件 → 新建', () => {
    const r = mergeMarkedSection('  \n\n', 'GENERATED');
    expect(r.action).toBe('created');
    expect(r.content).toContain('GENERATED');
  });

  it('用户已有内容但无标记 → 追加并保留原文', () => {
    const user = '# 我的说明\n\n- 手动补充';
    const r = mergeMarkedSection(user, 'GENERATED');
    expect(r.action).toBe('appended');
    expect(r.warning).toBeUndefined();
    expect(r.content).toContain(user);
    expect(r.content.indexOf(user)).toBeLessThan(r.content.indexOf(AGENT_MARKER_BEGIN));
  });

  it('已有完整标记段 → 替换生成内容，保留前后用户内容', () => {
    const existing = `# 前\n\n${block('OLD')}\n\n# 后\n`;
    const r = mergeMarkedSection(existing, 'NEW');
    expect(r.action).toBe('updated');
    expect(r.content).toContain('# 前');
    expect(r.content).toContain('# 后');
    expect(r.content).toContain('NEW');
    expect(r.content).not.toContain('OLD');
  });

  it('重复标记段 → 合并为一个并警告', () => {
    const existing = `${block('OLD1')}\n\n${block('OLD2')}\n`;
    const r = mergeMarkedSection(existing, 'NEW');
    expect(r.action).toBe('updated');
    expect(r.warning).toContain('重复');
    expect(r.content.split(AGENT_MARKER_BEGIN)).toHaveLength(2);
    expect(r.content).toContain('NEW');
    expect(r.content).not.toContain('OLD1');
    expect(r.content).not.toContain('OLD2');
  });

  it('只有 BEGIN 没有 END → 追加并警告，保留原内容', () => {
    const existing = `# 前\n\n${AGENT_MARKER_BEGIN}\nold broken`;
    const r = mergeMarkedSection(existing, 'NEW');
    expect(r.action).toBe('appended');
    expect(r.warning).toContain('不完整');
    expect(r.content).toContain('old broken');
    expect(r.content).toContain('NEW');
  });

  it('END 在 BEGIN 之前 → 视为不完整', () => {
    const r = mergeMarkedSection(`${AGENT_MARKER_END}\n${AGENT_MARKER_BEGIN}`, 'NEW');
    expect(r.action).toBe('appended');
    expect(r.warning).toContain('不完整');
  });

  it('保留 CRLF 换行', () => {
    const existing = `${block('OLD')}\r\n\r\nuser\r\n`;
    const r = mergeMarkedSection(existing, 'NEW');
    expect(r.content).toContain('\r\n');
    expect(r.content.replace(/\r\n/g, '')).not.toContain('\n');
    expect(r.content).toContain('NEW');
  });

  it('保留 BOM', () => {
    const r = mergeMarkedSection(`﻿${block('OLD')}`, 'NEW');
    expect(r.content.startsWith('﻿')).toBe(true);
    expect(r.content).toContain('NEW');
  });

  it('幂等：同样输入二次合并内容不变', () => {
    const first = mergeMarkedSection('# 前\n', 'NEW');
    const second = mergeMarkedSection(first.content, 'NEW');
    expect(second.content).toBe(first.content);
    expect(second.action).toBe('updated');
  });

  it('只有 BEGIN 的坏标记：第二次合并不删除中间的用户内容', () => {
    const user = '手写说明';
    const first = mergeMarkedSection(`# 前\n\n${AGENT_MARKER_BEGIN}\n${user}\n`, 'NEW');
    expect(first.action).toBe('appended');
    expect(first.content).toContain(user);
    const second = mergeMarkedSection(first.content, 'NEW2');
    expect(second.content).toContain(user);
    expect(second.content).toContain('NEW2');
  });

  it('孤立 END 在 BEGIN 之前：多次合并收敛为单个标记段', () => {
    let content = `${AGENT_MARKER_END}\n\n用户内容\n`;
    for (let i = 0; i < 4; i++) {
      const r = mergeMarkedSection(content, `GEN${i}`);
      content = r.content;
    }
    expect(content.split(AGENT_MARKER_BEGIN)).toHaveLength(2);
    expect(content).toContain('用户内容');
    expect(content).toContain('GEN3');
    // 不再无限追加：再次合并内容不变。
    expect(mergeMarkedSection(content, 'GEN3').content).toBe(content);
  });

  it('标记段之后有用户内容时保持幂等（不增长空行）', () => {
    const first = mergeMarkedSection(`${block('OLD')}\n\n用户章节\n`, 'NEW');
    const second = mergeMarkedSection(first.content, 'NEW');
    const third = mergeMarkedSection(second.content, 'NEW');
    expect(second.content).toBe(first.content);
    expect(third.content).toBe(first.content);
    expect(first.content).toContain('用户章节');
  });

  it('标记段后的用户内容保留首行缩进', () => {
    const existing = `${block('OLD')}\n\n    indented user code\n    second line\n`;
    const r = mergeMarkedSection(existing, 'NEW');
    expect(r.content).toContain(`${AGENT_MARKER_END}\n\n    indented user code\n    second line\n`);
    expect(mergeMarkedSection(r.content, 'NEW').content).toBe(r.content);
  });

  it('标记段前的用户行尾空格（硬换行）不被吞掉', () => {
    const r = mergeMarkedSection('# 标题  \n\n', 'NEW');
    expect(r.content.startsWith('# 标题  \n\n')).toBe(true);
    expect(mergeMarkedSection(r.content, 'NEW').content).toBe(r.content);
  });
});
