'use strict';
const { EditorGroups } = require('./editorGroups');
const CHAT_URL = 'https://chatgpt.com/';
const BROWSER_COMMAND = 'workbench.action.browser.open';

class ChatWeb extends EditorGroups {
  constructor(vscode, bridge, { url = CHAT_URL, name = 'ChatGPT Web' } = {}) { super(vscode); this.bridge = bridge; this.url = url; this.name = name; }
  async setBridge(bridge) {
    if (bridge === this.bridge) return;
    if (this.bridge && this.tab) {
      const old = this.entries().find(entry => entry.tab === this.tab);
      if (old && !await this.vscode.window.tabGroups.close([old.tab], true)) throw new Error('请关闭原注入页面后重试。');
      this.bridge.release(this.tab); this.tab = undefined;
    }
    this.bridge = bridge;
  }
  async enableSource() {
    if (!this.bridge) return;
    try { await this.bridge.apply(this.tab); }
    catch (error) {
      this.vscode.window.showWarningMessage("ChatGPT Web 已打开，LaTeX 源码模式尚未启用：" + error.message +
        " 请重试，或在命令面板使用“复制 ChatGPT Web LaTeX 源码脚本”。");
    }
  }
  open(column = 2) {
    if (this.pending) return this.pending;
    this.pending = this.show(column).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async show(column) {
    const vscode = this.vscode;
    if (!(await vscode.commands.getCommands(true)).includes(BROWSER_COMMAND)) {
      throw new Error('当前 VS Code 不支持内联浏览器（Integrated Browser），请更新后重试。');
    }
    await this.focusGroup(column);
    const existing = this.entries().find(entry => entry.tab === this.tab);
    if (existing) { this.tab = await this.reveal(existing, column); await this.enableSource(); return; }
    if (this.tab) this.bridge?.release(this.tab);

    const before = new Set(this.entries().map(entry => entry.tab));
    await vscode.commands.executeCommand(BROWSER_COMMAND, this.url);
    const created = () => {
      const fresh = this.entries().filter(({ tab }) => !before.has(tab));
      return fresh.length === 1 && vscode.window.tabGroups.activeTabGroup.activeTab === fresh[0].tab ? fresh[0] : undefined;
    };
    if (!await this.waitFor(() => !!created())) {
      vscode.window.showInformationMessage('已打开内联浏览器，请检查标签或浏览器窗口。');
      return;
    }
    const entry = created();
    if (!entry) return;
    // Never use reuseUrlFilter together with a root URL: that would navigate an
    // existing conversation back to the home page, possibly losing a typed prompt.
    this.tab = await this.reveal(entry, column);
    await this.enableSource();
  }
}
module.exports = { ChatWeb, CHAT_URL };
