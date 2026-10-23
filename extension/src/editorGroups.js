'use strict';
const GROUP_NAMES = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth'];

class EditorGroups {
  constructor(vscode) { this.vscode = vscode; }
  entries() {
    return this.vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ group, tab })));
  }
  waitFor(predicate) {
    if (predicate()) return Promise.resolve(true);
    return new Promise(resolve => {
      const groups = this.vscode.window.tabGroups;
      let timer;
      const finish = value => { clearTimeout(timer); tabs.dispose(); changes.dispose(); resolve(value); };
      const check = () => { if (predicate()) finish(true); };
      const tabs = groups.onDidChangeTabs(check);
      const changes = groups.onDidChangeTabGroups(check);
      timer = setTimeout(() => finish(false), 1500);
      check();
    });
  }
  async focusGroup(column) {
    const name = GROUP_NAMES[column - 1];
    if (!name) throw new Error('自动定位仅支持前八个编辑器组，请手动移动标签。');
    await this.vscode.commands.executeCommand('workbench.action.focus' + name + 'EditorGroup');
    if (!await this.waitFor(() => this.vscode.window.tabGroups.activeTabGroup.viewColumn === column)) {
      throw new Error('无法聚焦目标编辑器组，请手动选择标签。');
    }
  }
  // The caller creates/focuses the destination BEFORE taking a tab snapshot.
  async reveal(entry, column) {
    await this.focusGroup(entry.group.viewColumn);
    const index = entry.group.tabs.indexOf(entry.tab);
    if (index < 0) throw new Error('标签已关闭，请重试。');
    await this.vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index);
    if (!await this.waitFor(() => this.vscode.window.tabGroups.activeTabGroup.activeTab === entry.tab)) {
      throw new Error('未能切回已有标签，请从标签栏选择；未新建页面。');
    }
    if (entry.group.viewColumn !== column) {
      if (this.vscode.window.tabGroups.activeTabGroup.activeTab !== entry.tab) throw new Error('焦点已改变，未移动其他标签。');
      await this.vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'group', value: column });
      if (!await this.waitFor(() => this.vscode.window.tabGroups.activeTabGroup.viewColumn === column)) {
        throw new Error('未能移动到目标组，请手动拖动标签。');
      }
    }
    return this.vscode.window.tabGroups.activeTabGroup.activeTab;
  }
}
module.exports = { EditorGroups };
