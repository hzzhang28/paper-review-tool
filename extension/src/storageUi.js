'use strict';
const defaults = { aiSessions: 3, revisions: 0, recovery: 3 };
function bytes(value) { return value < 1048576 ? (value / 1024).toFixed(1) + ' KiB' : (value / 1048576).toFixed(1) + ' MiB'; }
class StorageUi {
  constructor(vscode, current, changed) { Object.assign(this, { vscode, current, changed }); }
  async sync(client = this.current()?.client) {
    if (!client) return;
    const config = this.vscode.workspace.getConfiguration('paperReview', client.root ? this.vscode.Uri.file(client.root) : undefined);
    const policy = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, config.get('storage.' + key) ?? fallback]));
    await client.request('POST', '/v1/storage/policy', { policy });
  }
  async open() {
    const context = this.current();
    if (!context?.client) throw Error('请先打开项目。');
    const client = context.client, info = await client.request('GET', '/v1/storage');
    const choice = await this.vscode.window.showQuickPick([
      { label: '整理存储并压缩数据库', mode: 'compact', description: '回收无引用快照及过量恢复副本，保留正文历史' },
      { label: '清理已完成 AI Session', mode: 'sessions', description: '保留未提交、Pending 和冲突所需副本' },
      { label: '按保留数量清理历史', mode: 'history', description: `现有范围：r${info.oldestRevision}–r${info.masterRevision}，共 ${info.revisionCount} 个版本` },
      { label: '保留设置', mode: 'settings', description: `AI ${info.policy.aiSessions} 份；历史 ${info.policy.revisions || '无限'}；恢复 ${info.policy.recovery} 份` }
    ], { title: '存储与清理', placeHolder: `数据库 ${bytes(info.databaseBytes)} · Recovery ${bytes(info.recoveryBytes)} · AI ${bytes(info.aiSessionBytes)}`, ignoreFocusOut: true });
    if (!choice) return;
    if (choice.mode === 'settings') return this.vscode.commands.executeCommand('workbench.action.openSettings', 'paperReview.storage');
    const request = { mode: choice.mode };
    if (choice.mode === 'history') {
      const input = await this.vscode.window.showInputBox({ title: '保留最近多少个版本', prompt: `填写保留数量，例如 30。当前 Master r${info.masterRevision}，现有 ${info.revisionCount} 个版本；不足该数量则全部保留。`,
        validateInput: value => /^[1-9]\d*$/.test(value.trim()) && Number(value.trim()) <= 1000000 ? undefined : '填写 1 至 1000000 的版本保留数量。' });
      if (input === undefined) return;
      request.keepRevisions = Number(input.trim());
    }
    if (this.current()?.client !== client) throw Error('项目已切换，请重新打开存储与清理。');
    const preview = await client.request('POST', '/v1/storage/preview', request);
    const scope = preview.removedRevisions.length ? `删除 ${preview.removedRevisions.length} 个旧 Revision；` : '不删除正文 Revision；';
    const retained = request.mode === 'history' ? `保留 ${preview.retainedRevisions} 个版本（r${preview.oldestRevision}–r${preview.newestRevision}）；` : '';
    const confirmed = await this.vscode.window.showWarningMessage(`${retained}${scope}清理 ${preview.completedSessions} 个已完成 AI Session，预计回收文件 ${bytes(preview.fileBytes)}，并压缩数据库。\n当前 Master、Human Draft、审计、Issue 和未完成任务依赖保留。删除的历史不可恢复。`, { modal: true }, '确认清理');
    if (confirmed !== '确认清理') return;
    if (this.current()?.client !== client) throw Error('项目已切换，请重新预览清理范围。');
    await client.request('POST', '/v1/storage/cleanup', { ...request, token: preview.token });
    const after = await client.request('GET', '/v1/storage');
    await this.changed?.();
    if (after.warning) this.vscode.window.showWarningMessage('清理状态已保存，部分空间尚未回收：' + after.warning);
    else this.vscode.window.showInformationMessage(`存储清理完成。数据库 ${bytes(after.databaseBytes)}，Recovery ${bytes(after.recoveryBytes)}，AI ${bytes(after.aiSessionBytes)}。`);
    return after;
  }
}
module.exports = { StorageUi, bytes };
