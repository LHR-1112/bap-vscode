// BAP 历史 webview（Lit）：复刻 GitLens commit details 布局。
// 顶部过滤栏 + commit 列表 + 选中 commit 的文件改动树。
// 与扩展通过 acquireVsCodeApi().postMessage / window message 通信。
import { LitElement, html, css } from 'lit';
import type { TemplateResult } from 'lit';

interface Commit {
  versionNo?: number;
  comments?: string;
  commiter?: string;
  commitTime?: number;
  uuid?: string;
  key?: string;
}

interface FileItem {
  key?: string;
  uuid?: string;
  versionNo?: number;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => { postMessage: (m: unknown) => void };
  }
}

const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : { postMessage: () => {} };

function ago(t?: number): string {
  if (!t) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} days ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} months ago`;
  return `${Math.floor(mo / 12)} years ago`;
}

function shortHash(commit: Commit): string {
  // 版本号作 hash 展示：无真实 hash，用前 7 位 uuid
  const u = commit.uuid ?? '';
  return u.slice(0, 7);
}

export class HistoryApp extends LitElement {
  // 普通字段 + 手动 requestUpdate（避免依赖 + 装饰器，简单可靠）
  private commits: Commit[] = [];
  private files: FileItem[] = [];
  private sel?: Commit;
  private filter = '';

  setCommits(commits: Commit[]): void {
    this.commits = commits;
    this.sel = undefined;
    this.files = [];
    this.requestUpdate();
  }

  setFiles(files: FileItem[]): void {
    this.files = files;
    this.requestUpdate();
  }

  private filtered(): Commit[] {
    const q = this.filter.trim().toLowerCase();
    if (!q) return this.commits;
    return this.commits.filter((c) =>
      `${c.comments ?? ''} ${c.commiter ?? ''} ${c.versionNo ?? ''}`.toLowerCase().includes(q),
    );
  }

  private select(commit: Commit): void {
    this.sel = commit;
    this.files = [];
    this.requestUpdate();
    vscode.postMessage({ type: 'select', commit });
  }

  private openDiff(file: FileItem): void {
    vscode.postMessage({ type: 'openDiff', file });
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('message', (e) => {
      const data = e.data as { type?: string; commits?: Commit[]; files?: FileItem[] };
      if (data?.type === 'commits' && data.commits) this.setCommits(data.commits);
      if (data?.type === 'files' && data.files) this.setFiles(data.files);
    });
    vscode.postMessage({ type: 'init' });
  }

  disconnectedCallback(): void {
    window.removeEventListener('message', () => {});
    super.disconnectedCallback();
  }

  protected render(): TemplateResult {
    const hasFiles = this.sel && this.files.length > 0;
    return html`
      <div class="toolbar">
        <input class="search" placeholder="Enter to search commits" .value=${this.filter}
          @input=${(e: InputEvent) => { this.filter = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
        <span class="count">${this.filtered().length} commits</span>
      </div>
      <div class="commits">
        ${this.filtered().map(
          (c) => html`
            <div class="row ${this.sel === c ? 'sel' : ''}" @click=${() => this.select(c)}>
              <span class="dot"></span>
              <span class="when">${ago(c.commitTime)}</span>
              <span class="msg">${c.comments ?? ''}</span>
              <span class="author">${c.commiter ?? ''}</span>
              <span class="hash">${shortHash(c)}</span>
            </div>
          `,
        )}
      </div>
      ${this.sel
        ? html`<div class="section">
            <div class="title">${this.sel.comments ?? ''}</div>
            <div class="files">
              ${hasFiles
                ? this.files.map(
                    (f) => html`
                      <div class="file ${f.key?.includes('/') ? 'res' : 'java'}" @click=${() => this.openDiff(f)}>
                        <span class="status ${f.key?.includes('/') ? 'a' : 'm'}">${f.key?.includes('/') ? 'A' : 'M'}</span>
                        <span class="path">${f.key ?? ''}</span>
                      </div>
                    `,
                  )
                : html`<div class="empty">加载中…</div>`}
            </div>
          </div>`
        : html``}
    `;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    .search {
      flex: 1;
      min-width: 180px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4));
      border-radius: 3px;
      padding: 4px 8px;
      outline: none;
    }
    .search:focus { border-color: var(--vscode-focusBorder); }
    .count { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .commits { overflow-y: auto; flex: 1; }
    .row {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 10px; cursor: pointer; white-space: nowrap; overflow: hidden;
    }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .dot {
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--vscode-gitDecoration-untrackedResourceForeground, #3fb950);
      flex: none;
    }
    .when { color: var(--vscode-descriptionForeground); width: 90px; flex: none; }
    .msg { flex: 1; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
    .author { color: var(--vscode-descriptionForeground); flex: none; }
    .hash { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); flex: none; }
    .section { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); max-height: 45%; overflow-y: auto; }
    .section .title { font-weight: 600; padding: 6px 10px; }
    .files { padding-bottom: 4px; }
    .file { display: flex; align-items: center; gap: 8px; padding: 3px 10px; cursor: pointer; }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .status { font-weight: 700; width: 12px; flex: none; }
    .status.m { color: var(--vscode-charts-yellow, #cca700); }
    .status.a { color: var(--vscode-charts-blue, #3794ff); }
    .path { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .empty { color: var(--vscode-descriptionForeground); padding: 4px 10px; }
  `;
}

if (!customElements.get('bap-history')) customElements.define('bap-history', HistoryApp);
const app = document.createElement('bap-history');
const root = document.getElementById('app');
if (root) root.appendChild(app);
