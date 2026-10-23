'use strict';

const PANEL_COMMAND = 'chatgpt.newCodexPanel';
const { EditorGroups } = require('./editorGroups');

// Use the installed extension and native editor commands. Never embed its webview
// or infer ownership from a tab's translated/user-editable title.
class CodexPanel extends EditorGroups {
  constructor(vscode, workspaceState, target) {
    super(vscode);
    this.workspaceState = workspaceState;
    this.target = target ? { ...target } : { name: 'Codex', extensionId: 'openai.chatgpt', command: PANEL_COMMAND };
    this.stateKey = this.target.command === PANEL_COMMAND ? 'codexPanelViewTypes' : 'agentPanelViewTypes:' + this.target.command;
    this.viewTypes = new Set((workspaceState.get(this.stateKey) || []).filter(value => typeof value === 'string'));
  }

  open(column = 2) {
    if (this.pending) return this.pending;
    this.pending = this.show(column).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  isWebview(tab) { return tab.input instanceof this.vscode.TabInputWebview; }

  async show(column) {
    const vscode = this.vscode;
    const target = this.target;
    if (target.extensionId) {
      const extension = vscode.extensions.getExtension(target.extensionId);
      if (!extension) throw new Error('请先安装并启用 ' + target.name + ' 扩展（' + target.extensionId + '）。');
      await extension.activate();
    }
    if (!(await vscode.commands.getCommands(true)).includes(target.command)) {
      throw new Error('当前 ' + target.name + ' 扩展未提供命令 ' + target.command + '，请检查版本或设置自定义入口。');
    }

    // Establish the requested PDF group first, before snapshotting live tabs.
    await this.focusGroup(column);
    const existing = this.entries().filter(({ tab }) => this.isWebview(tab) && this.viewTypes.has(tab.input.viewType));
    const owner = existing.find(entry => entry.group.viewColumn === column) || existing[0];
    if (owner) { await this.reveal(owner, column); return; }

    const before = new Set(this.entries().map(entry => entry.tab));
    const created = () => {
      const fresh = this.entries().filter(({ tab }) => !before.has(tab) && this.isWebview(tab));
      // Ambiguous concurrent webviews must not become a learned Codex identity.
      return fresh.length === 1 && vscode.window.tabGroups.activeTabGroup.activeTab === fresh[0].tab ? fresh[0] : undefined;
    };
    await vscode.commands.executeCommand(target.command, ...(target.args || []));
    if (!await this.waitFor(() => !!created())) {
      vscode.window.showInformationMessage('已调用 ' + target.name + '；未能确认独立编辑器标签。若目标只提供侧栏，将保留其原布局。');
      return;
    }
    const result = created();
    if (!result) return;
    this.viewTypes.add(result.tab.input.viewType);
    await this.workspaceState.update(this.stateKey, [...this.viewTypes]);
    // Some extension versions ignore the focused group. Only move the new panel
    // while it remains active, so a focus change cannot move the user's Draft.
    if (result.group.viewColumn !== column && vscode.window.tabGroups.activeTabGroup.activeTab === result.tab) {
      await this.reveal(result, column);
    }
  }
}

module.exports = { CodexPanel };
