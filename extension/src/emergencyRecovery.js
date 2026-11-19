'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
function target(document, remembered) {
  if (!document || document.isClosed) throw Error('请先激活要保留的论文编辑器。');
  const uri = document.uri;
  if (uri.scheme === 'paper') {
    if (!remembered || remembered.authority !== uri.authority || uri.path !== '/' + path.basename(remembered.file)) throw Error('无法确认当前草稿所属项目，未重置。');
    return { root: remembered.root, file: remembered.file };
  }
  if (uri.scheme === 'file' && uri.fsPath.endsWith('.tex')) {
    const root = path.dirname(uri.fsPath), file = path.basename(uri.fsPath), descriptor = path.join(root, '.paper-manager/project.json');
    if (!fs.existsSync(path.join(root, '.paper-manager'))) throw Error('该文件尚未由 Paper 管理，请正常初始化。');
    let known;
    try { known = JSON.parse(fs.readFileSync(descriptor, 'utf8')).masterFile; } catch { /* A damaged descriptor can be reset from the explicitly selected file. */ }
    if (known && known !== file) throw Error('当前文件不是此目录受管理的 Master。');
    return { root, file };
  }
  throw Error('请激活 Human Draft 或受管理的 Master .tex 文件；历史、Issue 和其他页面不能用于重置。');
}
function runReset(manager, project, WorkerClass = Worker) {
  const worker = new WorkerClass(manager.serviceFile('resetWorker.js'), { workerData: project, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
  return new Promise((resolve, reject) => {
    let result, failure;
    worker.once('message', message => { result = message; });
    worker.once('error', error => { failure = error; });
    worker.once('exit', code => {
      try { require(manager.serviceFile('emergencyReset.js')).release(project.root, project.resetId); } catch (error) { failure ||= error; }
      if (failure || result?.error || code !== 0 || !result?.ok) reject(failure || Error(result?.error || '紧急重置未完成。选定正文仍保存在项目的 .paper-reset.json，可再次重试。'));
      else resolve(result);
    });
  });
}
async function recover({ vscode, manager, remembered, begin, invalidate, notify, beforeReload }, WorkerClass) {
  const document = vscode.window.activeTextEditor?.document, project = target(document, remembered);
  const ownedRoot = manager.owned && path.resolve(manager.owned.root), selectedRoot = path.resolve(project.root);
  if (ownedRoot && (process.platform === 'win32' ? ownedRoot.toLowerCase() !== selectedRoot.toLowerCase() : ownedRoot !== selectedRoot)) throw Error('请激活当前窗口所管理项目的论文编辑器。');
  const text = document.getText(), version = document.version;
  const answer = await vscode.window.showWarningMessage('强制更新 Master 并清空后台状态？', { modal: true,
    detail: '来源：当前活动编辑器（包含未保存内容），' + text.length + ' 个字符。\n目标：' + path.join(project.root, project.file) + '\n\n原历史、审计、Issue、AI 副本、冲突和 Pending 将清空，不保留旧数据备份。新正文从 r1 开始，全部待审核。此操作不会等待卡住的服务。' }, '强制更新并重置');
  if (answer !== '强制更新并重置') return false;
  if (document.isClosed || document.version !== version || vscode.window.activeTextEditor?.document !== document) throw Error('活动编辑器或正文已变化，请重新确认。');
  begin(project);
  await invalidate();
  await manager.forceStop(project.root);
  if (document.isClosed || document.version !== version) throw Error('停止服务期间正文已变化，未改写 Master，请重新执行紧急重置。');
  const { stage } = require(manager.serviceFile('emergencyReset.js'));
  const { resetId } = stage(project.root, project.file, text);
  try { await runReset(manager, { ...project, resetId }, WorkerClass); }
  catch (error) { require(manager.serviceFile('emergencyReset.js')).release(project.root, resetId); throw error; }
  await beforeReload?.(project, document);
  notify('Master 已按确认时的编辑器正文重置为 r1，全部待审核。正在重新加载窗口；未保存缓冲区由 VS Code 保留。');
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
  return true;
}
module.exports = { target, runReset, recover };
