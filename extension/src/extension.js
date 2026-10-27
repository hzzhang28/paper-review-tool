'use strict';
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { describeProject, projectId } = require('./projects');
const { VirtualFs } = require('./virtualFs');
const { ServiceManager } = require('./serviceManager');
const { ReviewUi } = require('./reviewUi');
const { IssueFs, serialize: issueText } = require('./issueFs');
const { CompileManager } = require('./compileManager');
const { CodexPanel } = require('./codexPanel');
const { ChatWeb, CHAT_URL } = require('./chatWeb');
const { ChatScriptBridge } = require('./chatScriptBridge');
const { TargetMenus, isChatGPT, resolveAgent, resolveWeb } = require('./targetMenus');
const { selectedProfile, profileId } = require('./compileProfiles');
const { agentInstruction } = require('./agentInstruction');
const { ConfigurationUi } = require('./configurationUi');
const { OverleafUi } = require('./overleafUi');
const { StorageUi } = require('./storageUi');
const { UpdateManager } = require('./updateManager');
const { PENDING_OPEN_KEY, workspaceMatches, projectWorkspaceAction, buildPendingOpen, delegateProjectWorkspace,
  pendingOpenForWindow, clearPendingOpen, managedProjectInFolders } = require('./projectWorkspace');
let activeManager, activeCompiler;

function activate(context) {
  const provider = new VirtualFs();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  let client, uri, ui, projectRoot, masterFile, operation = false, polling = false, transitioning = false, closingTabs = false, projectTasks = 0, buildBusy = false, buildCancelled = false;
  let lastAINotification = 0, preparedConflictId;
  const conflictStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.8);
  conflictStatus.command = 'paperReview.resolveConflict';
  const submitConflictStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49.6);
  submitConflictStatus.text = '$(check-all) 提交合并结果';
  submitConflictStatus.tooltip = '保存合并结果并同步 Master 与 Human Draft。';
  submitConflictStatus.command = 'paperReview.submitConflict';
  const output = vscode.window.createOutputChannel('Paper Review');
  const updater = new UpdateManager(vscode, context, {
    output,
    installGuard: () => !operation && !transitioning && !provider.busy && !buildBusy
  });
  context.subscriptions.push(updater);
  const buildOutput = vscode.window.createOutputChannel('Paper Build', 'paper-build-log');
  const buildStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  const buildLogStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  buildLogStatus.command = 'paperReview.buildLog';
  const pdfStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 47);
  pdfStatus.text = '$(file-pdf) 打开 PDF'; pdfStatus.command = 'paperReview.openPdf';
  pdfStatus.tooltip = '查看已有 PDF，不触发编译。';
  const codex = new CodexPanel(vscode, context.workspaceState);
  const instructionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45.5);
  instructionStatus.text = '$(copy) Agent Instruction'; instructionStatus.command = 'paperReview.copyAgentPrompt';
  instructionStatus.tooltip = '复制当前项目的 HTTP Pull / Push 指令。';
  let chatBridge;
  const chatWeb = new ChatWeb(vscode);
  const webViews = new Map([[CHAT_URL, chatWeb]]), agentPanels = new Map();
  const config = () => vscode.workspace.getConfiguration('paperReview');
  const storageUi = new StorageUi(vscode, () => client ? { client, root: projectRoot } : undefined, () => refreshStatus(true));
  const overleaf = new OverleafUi(vscode, context, () => projectRoot ? { root: projectRoot, file: masterFile } : undefined);
  context.subscriptions.push(overleaf);
  void overleaf.refresh();
  function sourceBridge() {
    if (!chatBridge) {
      chatBridge = new ChatScriptBridge(vscode, fs.readFileSync(path.join(context.extensionPath, 'resources', 'chatgptLatexSource.js'), 'utf8'));
      context.subscriptions.push(chatBridge);
    }
    return chatBridge;
  }
  async function openWebTarget(target, column) {
    let browser = webViews.get(target.url);
    if (!browser) { browser = new ChatWeb(vscode, undefined, target); webViews.set(target.url, browser); }
    const enabled = isChatGPT(target.url) && (config().get('fixChatGPTWebLatex') ?? true);
    await browser.setBridge(enabled ? sourceBridge() : undefined);
    return browser.open(column);
  }
  const targets = new TargetMenus(vscode, context.workspaceState, {
    async openAgent(target, column) {
      const key = JSON.stringify(target);
      let panel = agentPanels.get(key);
      if (!panel) { panel = new CodexPanel(vscode, context.workspaceState, target); agentPanels.set(key, panel); }
      await panel.open(column);
    },
    openWeb: openWebTarget
  });
  const settingsUi = new ConfigurationUi(vscode, targets);
  const chatStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45);
  chatStatus.text = "$(globe) ChatGPT Web"; chatStatus.command = "paperReview.openWeb";
  chatStatus.tooltip = "打开设置中的默认网页。";
  const codexStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 46);
  codexStatus.text = '$(comment-discussion) Codex'; codexStatus.command = 'paperReview.openAgent';
  codexStatus.tooltip = '打开设置中的默认 Agent。';
  function updateTargetButtons() {
    try { codexStatus.text = '$(comment-discussion) ' + resolveAgent(config(), vscode.extensions.all).name; } catch { codexStatus.text = '$(comment-discussion) Agent'; }
    try { chatStatus.text = '$(globe) ' + resolveWeb(config()).name; } catch { chatStatus.text = '$(globe) Web'; }
  }
  updateTargetButtons();
  function compileButton(busy = false) {
    let profile; try { profile = selectedProfile(config()); } catch {}
    buildStatus.text = busy ? '$(debug-stop) 停止编译' : profile?.steps.length === 0 ? '$(cloud-upload) Push（不编译）' : '$(play) Push + 编译';
    buildStatus.command = busy ? 'paperReview.cancelCompile' : 'paperReview.compile';
    buildStatus.tooltip = busy ? '停止本次编译。' : '保存 Human Draft 并 Push，随后编译：' + (profile?.name || '尚未配置') + '。';
  }
  compileButton();
  const compiler = new CompileManager({ output: buildOutput }); activeCompiler = compiler;
  const manager = new ServiceManager(context.extensionPath, output);
  activeManager = manager;
  const issueFs = new IssueFs({ workspaceState: context.workspaceState,
    getClient: issueClient,
    write: async (resource, action) => {
      if (transitioning && !closingTabs || operation || provider.busy || provider.blocked) throw new Error('正在处理项目操作，请稍后重试。');
      projectTasks++;
      try { return await action(await issueClient(resource)); } finally { projectTasks--; }
    },
    onSaved: () => refreshStatus(true)
  });
  async function issueClient(resource) {
    if (transitioning && !closingTabs) throw new Error('正在打开或关闭项目，请稍后重试。');
    if (!client) {
      const project = context.workspaceState.get('activeProject');
      if (!project || project.authority !== resource.authority) throw new Error('请先打开此 Issue 所属项目。');
      await provider.ready(vscode.Uri.from({ scheme: 'paper', authority: project.authority, path: '/' + path.basename(project.file) }));
    }
    if (resource.authority !== uri?.authority) throw new Error('请先打开此 Issue 所属项目。');
    return client;
  }
  ui = new ReviewUi(undefined, undefined);
  function idleStatus() {
    status.command = 'paperReview.openProject'; status.text = '$(folder-opened) Paper: 打开项目';
    status.tooltip = '选择 .tex 文件，打开或切换项目。'; status.show();
    preparedConflictId = undefined; conflictStatus.hide(); submitConflictStatus.hide();
    void vscode.commands.executeCommand('setContext', 'paperReview.conflictPrepared', false);
    buildStatus.hide(); buildLogStatus.hide(); pdfStatus.hide(); codexStatus.hide(); instructionStatus.hide(); chatStatus.hide();
  }
  idleStatus();
  void vscode.commands.executeCommand('setContext', 'paperReview.projectOpen', false);
  const showError = error => {
    if (error.overleafLog) return Promise.resolve(vscode.window.showErrorMessage(`Paper: ${error.message}`, '查看日志')).then(choice => {
      if (choice === '查看日志') overleaf.showLog();
    });
    return vscode.window.showErrorMessage(`Paper: ${error.message}`);
  };
  const register = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
    const protectedCommand = !['openProject', 'closeProject', 'open', 'refresh', 'state', 'copyCliPath', 'checkForUpdates', 'settings'].includes(name.split('.').at(-1));
    let entered = false;
    try {
      if (protectedCommand) {
        if (transitioning) throw new Error('正在打开或关闭项目，请稍后重试。');
        projectTasks++; entered = true;
      }
      return await callback(...args);
    } catch (error) { showError(error); }
    finally { if (entered) projectTasks--; }
  }));
  function refreshStatus(force = false) {
    if (!client || transitioning) return Promise.resolve();
    if (polling) return force === true ? polling.then(() => refreshStatus()) : polling;
    polling = updateStatus().finally(() => { polling = undefined; });
    return polling;
  }
  async function updateStatus() {
    const current = client;
    try {
      const state = await current.request('GET', '/v1/state');
      if (client !== current || transitioning) return;
      const dirty = vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString() && doc.isDirty);
      status.text = 'Master r' + state.masterRevision +
        (dirty ? ' | Unsaved' : '') + (state.unpushed ? ' | Unpushed' : '') +
        (state.updateAvailable ? ' | New Updates' : ' | Updated');
      status.tooltip = state.drift || state.reviewCount + ' 个审计范围，' + state.issueCount + ' 个未解决 Issue。点击打开章节。';
      status.show();
      const conflicts = state.conflicts;
      if (conflicts.length) {
        conflictStatus.text = '$(warning) Conflicts (' + conflicts.length + ')' + (state.pendingCount ? ' | Pending (' + state.pendingCount + ')' : '');
        conflictStatus.tooltip = '在合并编辑器中处理冲突。';
        conflictStatus.show();
      } else if (state.pendingCount) {
        conflictStatus.text = '$(clock) Pending (' + state.pendingCount + ')'; conflictStatus.command = 'paperReview.state'; conflictStatus.show();
      } else conflictStatus.hide();
      if (conflicts.length) conflictStatus.command = 'paperReview.resolveConflict';
      if (state.activeConflict) preparedConflictId = state.activeConflict.id;
      if (preparedConflictId && !conflicts.some(c => c.id === preparedConflictId)) preparedConflictId = undefined;
      if (preparedConflictId) submitConflictStatus.show(); else submitConflictStatus.hide();
      await vscode.commands.executeCommand('setContext', 'paperReview.conflictPrepared', !!preparedConflictId);
      const notice = state.aiNotification;
      if (notice && notice.sequence > lastAINotification) {
        lastAINotification = notice.sequence;
        if (notice.status === 'conflict') vscode.window.showWarningMessage('AI 提交存在冲突，请点击 Conflicts 处理。');
        else if (notice.status === 'pending') vscode.window.showInformationMessage('AI 提交已进入 Pending，当前冲突处理完成后继续。');
        else vscode.window.showInformationMessage('AI 已提交到 Master r' + notice.masterRevision + '。使用 Update Only 或 Merge Update 获取最新正文。');
      }
      if (ui) await ui.refresh();
    } catch (error) {
      if (client !== current || transitioning) return;
      status.text = 'Paper | 服务不可用'; status.tooltip = error.message; status.show();
      if (projectRoot && !operation) { try { client = await manager.ensure(projectRoot, masterFile, { requireExisting: true }); } catch (failure) { output.appendLine(failure.message); } }
    }
  }
  async function connect(project, resource) {
    if (vscode.env.remoteName) throw new Error('请使用桌面 VS Code 的本机工作区。');
    if (!vscode.workspace.isTrusted) throw new Error('请先将工作区设为受信任。');
    const { root, file } = project;
    const nextClient = await manager.ensure(root, file, { initialReview: project.initialReview, requireExisting: project.initialized !== false });
    await storageUi.sync(nextClient);
    const state = await nextClient.request('GET', '/v1/state');
    client = nextClient;
    lastAINotification = state.aiNotification?.sequence || 0;
    masterFile = state.masterFile;
    uri = resource || vscode.Uri.from({ scheme: 'paper', authority: projectId(root, masterFile), path: '/' + path.basename(masterFile) });
    provider.connect(client, uri);
    provider.version = state.draftVersion;
    projectRoot = root;
    ui?.dispose(); ui = new ReviewUi(uri, client);
    await context.workspaceState.update('activeProject', { root, file: masterFile, authority: uri.authority });
    status.command = 'paperReview.showOutline';
    compileButton(); buildStatus.show();
    buildLogStatus.text = '$(output) 编译日志'; buildLogStatus.tooltip = '打开 / 隐藏编译日志。'; buildLogStatus.show(); pdfStatus.show(); codexStatus.show(); instructionStatus.show(); chatStatus.show();
    await vscode.commands.executeCommand('setContext', 'paperReview.projectOpen', true);
    if (!profileId(config())) vscode.window.showInformationMessage('尚未配置本机编译方案。请打开 Paper: 编译设置；仅编辑正文可选择“不编译”。');
    return uri;
  }
  async function showDraft(resource = uri) {
    const document = await vscode.workspace.openTextDocument(resource);
    const latex = await vscode.languages.setTextDocumentLanguage(document, 'latex');
    await vscode.window.showTextDocument(latex, { preview: false, viewColumn: vscode.ViewColumn.One });
    await openPdf({ quiet: true });
  }
  function paperTabs() {
    return vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
      [tab.input?.uri, tab.input?.original, tab.input?.modified].some(value => ['paper', 'paper-issue', 'paper-event', 'paper-revision'].includes(value?.scheme)));
  }
  async function releaseProject() {
    // Native tab closing owns Save / Don't Save / Cancel. Never force-save or Push here.
    const tabs = paperTabs();
    if (tabs.length) {
      closingTabs = true;
      let closed;
      try { closed = await vscode.window.tabGroups.close(tabs, true); } finally { closingTabs = false; }
      if (!closed) return false;
    }
    if (!tabs.length && vscode.workspace.textDocuments.some(doc => ['paper', 'paper-issue'].includes(doc.uri.scheme) && doc.isDirty && !doc.isClosed)) return false;
    if (polling) await polling;
    if (client || manager.child) await manager.stop();
    client = undefined; uri = undefined; projectRoot = undefined; masterFile = undefined;
    provider.disconnect();
    ui?.dispose(); ui = new ReviewUi(undefined, undefined);
    await context.workspaceState.update('activeProject', undefined);
    await context.workspaceState.update('projectRoot', undefined);
    await context.workspaceState.update('masterFile', undefined);
    await vscode.commands.executeCommand('setContext', 'paperReview.projectOpen', false);
    idleStatus();
    return true;
  }
  async function openProject(selected) {
    if (operation || transitioning || projectTasks) throw new Error('正在处理项目操作，请稍后重试。');
    if (vscode.env.remoteName || !vscode.workspace.isTrusted) throw new Error('请先打开受信任的本机工作区。');
    if (selected?.scheme !== 'file') {
      const chosen = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false,
        canSelectMany: false, filters: { LaTeX: ['tex'] }, openLabel: '初始化 / 打开项目', title: '选择论文 .tex 文件（所在文件夹作为项目根目录）' });
      if (!chosen) return;
      selected = chosen[0];
    }
    const project = describeProject(selected.fsPath);
    if (client && projectRoot === project.root && masterFile === project.file) { await showDraft(); return; }
    if (!project.initialized) {
      const mode = await vscode.window.showQuickPick([
        { label: '全部已审核', description: '将现有正文视为已审核', value: 'approved' },
        { label: '全部待审核', description: '将现有正文标黄，待逐项审核', value: 'unreviewed' }
      ], { title: '选择初始审计状态', ignoreFocusOut: true });
      if (!mode) return;
      project.initialReview = mode.value;
    }
    if (operation || transitioning || projectTasks) throw new Error('正在处理项目操作，请稍后重试。');
    const plan = projectWorkspaceAction(vscode, project.root, { mode: config().get('workspace.openMode') });
    if (plan.action === 'openFolder') {
      transitioning = true;
      let delegated = false;
      try {
        delegated = await delegateProjectWorkspace(vscode, project.root, buildPendingOpen(project), {
          globalState: context.globalState,
          newWindow: plan.newWindow,
          onLog: message => output.appendLine(message)
        });
      } finally { transitioning = false; }
      if (delegated) {
        vscode.window.setStatusBarMessage('已打开论文文件夹，正在载入项目。', 6000);
        return;
      }
      output.appendLine('未能用 VS Code 打开论文文件夹，改为只打开项目。');
    }
    await openProjectDescriptor(project);
  }
  async function openProjectDescriptor(project) {
    if (operation || transitioning || projectTasks) throw new Error('正在处理项目操作，请稍后重试。');
    transitioning = true;
    try {
      if (!await releaseProject()) return;
      const resource = await connect(project);
      await showDraft(resource);
      return resource;
    } catch (error) {
      if (!client) { await manager.stop(); idleStatus(); }
      throw error;
    } finally { transitioning = false; await refreshStatus(); }
  }
  function projectFolders() { return vscode.workspace.workspaceFolders || []; }
  // A folder opened in VS Code may briefly report no folders while it loads.
  async function waitForSingleFolder(timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (projectFolders().length === 1) return true;
      if (projectFolders().length > 1) return false;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return projectFolders().length === 1;
  }
  async function resumePendingProject() {
    const state = context.globalState;
    if (!state) return;
    if (!state.get(PENDING_OPEN_KEY)) return; // never delay the common activation path
    await waitForSingleFolder();
    const pending = pendingOpenForWindow(state, projectFolders());
    if (!pending) return;
    if (pending.expired) { await clearPendingOpen(state); return; }
    if (!vscode.workspace.isTrusted) {
      output.appendLine('论文文件夹尚未受信任；信任并重新加载窗口后将自动打开项目。');
      return;
    }
    if (client || transitioning) { await clearPendingOpen(state); return; }
    try {
      const project = describeProject(path.join(pending.root, pending.file));
      if (!project.initialized && !['approved', 'unreviewed'].includes(pending.initialReview)) {
        output.appendLine('待打开项目缺少初始审计选择，请手动打开。');
        await clearPendingOpen(state);
        return;
      }
      await openProjectDescriptor({ ...project, initialReview: project.initialized ? undefined : pending.initialReview });
      await clearPendingOpen(state);
    } catch (error) {
      // Keep the record so another reload can retry; it expires on its own.
      output.appendLine('自动打开上次选择的项目失败：' + error.message);
      showError(error);
    }
  }
  async function autoOpenManagedProject() {
    if (client || transitioning || operation) return;
    if (config().get('workspace.autoOpenProject') === false) return;
    if (!vscode.workspace.isTrusted) return;
    const managed = managedProjectInFolders(projectFolders());
    if (!managed) return;
    try {
      const project = describeProject(path.join(managed.root, managed.file));
      if (!project.initialized) return;
      output.appendLine('检测到论文文件夹中的项目数据，正在载入 ' + managed.file + '。');
      await openProjectDescriptor(project);
    } catch (error) { output.appendLine('自动载入论文项目失败：' + error.message); }
  }
  register('paperReview.openProject', openProject);
  register('paperReview.setWorkspaceFolder', async () => {
    if (!projectRoot) throw new Error('请先打开项目。');
    if (workspaceMatches(vscode, projectRoot)) {
      vscode.window.showInformationMessage('VS Code 当前打开的就是论文文件夹。');
      return;
    }
    await delegateProjectWorkspace(vscode, projectRoot, buildPendingOpen({ root: projectRoot, file: masterFile }), {
      globalState: context.globalState,
      newWindow: false,
      onLog: message => output.appendLine(message)
    });
    vscode.window.setStatusBarMessage('正在用 VS Code 打开论文文件夹，随后自动载入项目。', 6000);
  });
  register('paperReview.settings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-paper-tools.paper-review-tool'));
  register('paperReview.checkForUpdates', async () => {
    if (transitioning) throw new Error('正在打开或关闭项目，请稍后重试。');
    return updater.check({ manual: true });
  });
  register('paperReview.closeProject', async () => {
    if (operation || transitioning || projectTasks) throw new Error('正在处理项目操作，请稍后重试。');
    transitioning = true;
    try { await releaseProject(); } finally { transitioning = false; await refreshStatus(); }
  });
  register('paperReview.open', async () => {
    if (transitioning) throw new Error('正在打开或关闭项目，请稍后重试。');
    const existing = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'paper' && !doc.isClosed);
    if (!client && existing) await provider.ready(existing.uri);
    if (!client) return openProject();
    await showDraft();
    await refreshStatus();
  });
  // Only a restored paper:// resource starts the remembered project's service.
  // Merely activating the extension never starts Node or creates project data.
  provider.resolve = async resource => {
    if (transitioning) throw vscode.FileSystemError.Unavailable('正在切换项目。');
    let project = context.workspaceState.get('activeProject');
    if (!project) {
      const root = context.workspaceState.get('projectRoot'), file = context.workspaceState.get('masterFile');
      if (root && file) project = { root, file, authority: 'project' }; // 0.2.0 editor restoration.
    }
    if (!project || resource.authority !== project.authority || !['/', '/' + path.basename(project.file)].includes(resource.path)) {
      throw vscode.FileSystemError.FileNotFound('请通过“初始化 / 打开项目”选择 .tex 文件。');
    }
    if (!fs.existsSync(path.join(project.root, '.paper-manager', 'state.db'))) throw vscode.FileSystemError.Unavailable('缺少项目数据，请通过“初始化 / 打开项目”重新打开。');
    await connect({ ...project, initialized: true }, vscode.Uri.from({ scheme: 'paper', authority: project.authority, path: '/' + path.basename(project.file) }));
    await refreshStatus();
    const restoredClient = client;
    setTimeout(() => {
      if (client === restoredClient && !transitioning) void openPdf({ quiet: true }).catch(error => output.appendLine(error.message));
    }, 0);
  };
  async function withDraft(kind) {
    if (operation || transitioning) throw new Error('正在处理项目操作，请稍后重试。');
    let editor = vscode.window.activeTextEditor;
    if (editor?.document.uri.scheme === 'paper-issue') { await saveIssueEditors(); editor = await savedEditor(); }
    if (!uri) throw new Error('请先打开 Human Draft。');
    if (!editor || editor.document.uri.toString() !== uri.toString()) editor = await savedEditor();
    if (provider.blocked) throw new Error('请先另存 Human Draft，再关闭并重新打开。');
    await saveIssueEditors();
    if (kind === 'update') {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.scheme === 'paper-issue' && tab.input.uri.authority === uri.authority);
      if (tabs.length && !await vscode.window.tabGroups.close(tabs, true)) return;
    }
    if (operation || transitioning) throw new Error('正在处理项目操作，请稍后重试。');
    operation = true;
    let pulled;
    try {
      const document = editor.document;
      if (document.isDirty && !await document.save()) throw new Error('Human Draft 保存失败。');
      if (document.isDirty) throw new Error('保存时 Human Draft 已变化，请保存后重试。');
      const version = document.version;
      const selections = editor.selections;
      const visible = editor.visibleRanges[0];
      provider.busy = true;
      const result = await client.request('POST', `/v1/human/${kind}`, { expectedDraftVersion: provider.version });
      if (result.text !== undefined) {
        pulled = result;
        if (document.version !== version || document.isDirty) throw new Error('同步时 Human Draft 已变化，已保留编辑器内容。请另存后关闭并重新打开。');
        provider.pendingPull = result;
        const end = document.positionAt(document.getText().length);
        const applied = await editor.edit(builder => builder.replace(new vscode.Range(new vscode.Position(0, 0), end), result.text),
          { undoStopBefore: true, undoStopAfter: true });
        if (!applied || !await document.save() || document.getText().replace(/\r\n/g, '\n') !== result.text) throw new Error('Human Draft 同步失败，请另存编辑器内容后重新打开。');
        // An unchanged document may make save() a no-op, so acknowledge even
        // when VS Code did not invoke writeFile for this particular Update.
        provider.version = result.draftVersion;
        provider.pendingPull = undefined;
        editor.selections = selections.map(selection => new vscode.Selection(document.validatePosition(selection.anchor), document.validatePosition(selection.active)));
        if (visible) editor.revealRange(document.validateRange(visible), vscode.TextEditorRevealType.AtTop);
        provider.refresh();
      }
      if (result.staleIssueDeletes?.length) vscode.window.showInformationMessage('这些 Issue 已有更新，取消了旧的删除操作，请检查后重新删除：' + result.staleIssueDeletes.join('、'));
      vscode.window.setStatusBarMessage(({ push: 'Push', update: 'Update Only', 'merge-update': 'Merge Update', pull: '同步' }[kind] || kind) + '：Master r' + result.masterRevision, 4000);
      return result;
    } catch (error) {
      if (pulled) { provider.blocked = true; provider.pendingPull = undefined; }
      if (error.result?.conflictId && ['push', 'merge-update'].includes(kind)) {
        await openConflictEditor(error.result.conflictId);
      }
      throw error;
    } finally {
      provider.busy = false; operation = false; await refreshStatus(true);
      for (const issue of ui?.issues || []) await issueFs.accept(issue, uri.authority);
    }
  }
  register('paperReview.push', () => withDraft('push'));
  register('paperReview.copyCliPath', async () => {
    const script = path.join(context.extensionPath, 'runtime', 'server', 'src', 'cli.js');
    await vscode.env.clipboard.writeText(script);
    vscode.window.showInformationMessage('已复制旧 CLI 路径；推荐使用 Agent Instruction 中的 HTTP 接口。');
  });
  // Compatibility for old keybindings only; no Pull command is contributed.
  register('paperReview.pull', () => withDraft('pull'));
  register('paperReview.mergeUpdate', () => withDraft('merge-update'));
  register('paperReview.updateOnly', async () => {
    if (!client || !uri) throw new Error('请先打开 Human Draft。');
    const state = await client.request('GET', '/v1/state');
    const dirty = vscode.workspace.textDocuments.some(doc => !doc.isClosed && doc.uri.authority === uri.authority && ['paper', 'paper-issue'].includes(doc.uri.scheme) && doc.isDirty);
    if (state.unpushed || dirty) {
      const choice = await vscode.window.showWarningMessage('Update Only 将放弃未提交的正文、审计及 Issue 修改，并载入最新 Master。', { modal: true }, 'Update Only');
      if (choice !== 'Update Only') return;
    }
    return withDraft('update');
  });
  register('paperReview.copyAgentPrompt', async () => {
    if (!client) throw new Error('请先打开项目。');
    await vscode.env.clipboard.writeText(agentInstruction(await client.connection(), config().get('agentInstruction')));
    vscode.window.showInformationMessage('Agent Instruction 已复制。');
  });
  function rightColumn() {
    // Locate the current paper's PDF tab by resource only; do not open/read it.
    const pdf = projectRoot && masterFile && path.join(projectRoot, path.basename(masterFile, '.tex') + '.pdf');
    const matches = pdf ? vscode.window.tabGroups.all.filter(group => group.tabs.some(tab => {
      const resource = tab.input?.uri;
      return resource?.scheme === 'file' && (process.platform === 'win32' ? resource.fsPath.toLowerCase() === pdf.toLowerCase() : resource.fsPath === pdf);
    })) : [];
    const owner = matches.find(group => group.viewColumn !== vscode.ViewColumn.One) || matches[0];
    return owner?.viewColumn ?? vscode.ViewColumn.Two;
  }
  register("paperReview.openCodex", () => codex.open(rightColumn()));
  register("paperReview.openChatGPT", () => openWebTarget({ name: 'ChatGPT Web', url: CHAT_URL }, rightColumn()));
  register("paperReview.openAgent", () => targets.agent(rightColumn()));
  register("paperReview.openWeb", () => targets.web(rightColumn()));
  register('paperReview.selectCompileProfile', () => settingsUi.openCompile());
  register('paperReview.configureAgent', () => targets.configureAgent());
  register('paperReview.overleafConfigure', () => overleaf.configure());
  register('paperReview.overleafPush', () => overleaf.push());
  register('paperReview.overleafCredentials', () => overleaf.credentials());
  register('paperReview.overleafForgetCredentials', () => overleaf.forgetCredentials());
  register('paperReview.overleafLog', () => overleaf.showLog());
  register("paperReview.openChatGPTExternal", async () => {
    if (!await vscode.env.openExternal(vscode.Uri.parse(CHAT_URL))) throw new Error("无法打开默认浏览器。");
  });
  register("paperReview.copyChatGPTScript", async () => {
    const script = fs.readFileSync(path.join(context.extensionPath, "resources", "chatgptLatexSource.js"), "utf8");
    await vscode.env.clipboard.writeText(script);
    vscode.window.showInformationMessage("脚本已复制，请在 ChatGPT Web 的 DevTools Console 中执行；整页重载后需重新执行。");
  });
  let pdfOperations = Promise.resolve();
  function openPdf(options = {}) {
    const current = client, root = projectRoot, file = masterFile;
    const pending = pdfOperations.then(async () => {
      if (!current || client !== current || root !== projectRoot) throw new Error('请先打开项目。');
      return showPdf(root, file, options);
    });
    pdfOperations = pending.catch(() => {});
    return pending;
  }
  async function showPdf(root, file, { quiet = false, reload = false } = {}) {
    const resource = vscode.Uri.file(path.join(root, path.basename(file, '.tex') + '.pdf'));
    const same = value => value?.scheme === 'file' && (process.platform === 'win32' ?
      value.fsPath.toLowerCase() === resource.fsPath.toLowerCase() : value.fsPath === resource.fsPath);
    const entries = () => vscode.window.tabGroups.all.flatMap(group => group.tabs
      .filter(tab => same(tab.input?.uri)).map(tab => ({ tab, column: group.viewColumn ?? vscode.ViewColumn.Two })));
    const legacy = entries().filter(entry => entry.tab.input?.viewType === 'paperReview.pdf').map(entry => entry.tab);
    if (legacy.length && !await vscode.window.tabGroups.close(legacy, true)) return false;
    if (!fs.existsSync(resource.fsPath)) {
      if (!quiet) vscode.window.showInformationMessage('当前没有已生成的 PDF。');
      return false;
    }
    const matches = entries();
    const owner = matches.find(entry => entry.column !== vscode.ViewColumn.One) || matches[0];
    // Use the existing editor and its actual group instead of always creating a right-hand tab.
    const viewType = owner?.tab.input?.viewType;
    const column = owner?.column ?? vscode.ViewColumn.Two;
    if (reload && matches.length) {
      if (matches.some(entry => entry.tab.isDirty)) {
        const message = 'PDF 编辑器有未保存修改，未重新加载。请先保存或放弃这些修改。';
        output.appendLine(message); if (!quiet) vscode.window.showInformationMessage(message);
        return false;
      }
      // VS Code exposes no generic "refresh another extension's webview" API.
      // Close/reopen this resource using the same editor so its document is loaded afresh.
      if (!await vscode.window.tabGroups.close(matches.map(entry => entry.tab), true)) return false;
    }
    const options = { viewColumn: column, preserveFocus: quiet, preview: false };
    try {
      if (viewType) await vscode.commands.executeCommand('vscode.openWith', resource, viewType, options);
      else await vscode.commands.executeCommand('vscode.open', resource, options);
      return true;
    } catch (error) {
      output.appendLine('PDF 编辑器未能打开：' + error.message);
      if (!quiet) vscode.window.showInformationMessage('请安装并配置内联 PDF 阅读扩展。');
      return false;
    }
  }
  register('paperReview.openPdf', () => openPdf());
  register('paperReview.reloadPdf', () => openPdf({ reload: true }));
  register('paperReview.showOutline', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.paperReview');
    await vscode.commands.executeCommand('paperReview.reviews.focus');
  });
  register('paperReview.cancelCompile', async () => { buildCancelled = true; await compiler.cancel(); });
  register('paperReview.buildLog', () => {
    // Read native editor visibility, so closing the panel manually never leaves
    // a guessed toggle flag out of sync. Other output channels are not hidden.
    const visible = vscode.window.visibleTextEditors.some(editor => editor.document.uri.scheme === 'output' && editor.document.languageId === 'paper-build-log');
    if (visible) buildOutput.hide(); else buildOutput.show(true);
  });
  register('paperReview.compile', async () => {
    if (buildBusy || compiler.current) throw new Error('已有编译正在运行。');
    if (!client) throw new Error('请先打开项目。');
    const profile = selectedProfile(config());
    if (!profile) { vscode.window.showInformationMessage('尚未配置编译方案。请打开 Paper: 编译设置；本次未保存或 Push。'); return; }
    buildBusy = true; buildCancelled = false;
    await vscode.commands.executeCommand('setContext', 'paperReview.compiling', true);
    compileButton(true);
    buildLogStatus.text = '$(sync~spin) 保存并 Push · 日志';
    try {
      await savedEditor();
      if (buildCancelled) { buildLogStatus.text = '$(output) 已取消 · 日志'; return { generated: false, status: 'cancelled' }; }
      const pushed = await withDraft('push');
      if (buildCancelled) {
        buildLogStatus.text = '$(output) Push 已完成 · 已取消编译 · 日志';
        buildOutput.appendLine('Push 已完成，Master r' + pushed.masterRevision + '；编译已取消。');
        return { generated: false, status: 'cancelled', masterRevision: pushed.masterRevision };
      }
      if (!profile.steps.length) {
        buildLogStatus.text = '$(output) 不编译 · 日志';
        buildOutput.appendLine('Master r' + pushed.masterRevision + ' 已 Push；当前方案不编译。');
        return { generated: false, status: 'disabled', masterRevision: pushed.masterRevision };
      }
      // Compile the real Master in root. A new revision during a pass invalidates the result.
      const snapshot = await client.request('GET', `/v1/revisions/${pushed.masterRevision}`);
      if (buildCancelled) { buildLogStatus.text = '$(output) 已取消编译 · 日志'; return { generated: false, status: 'cancelled', masterRevision: pushed.masterRevision }; }
      buildOutput.appendLine('\nPush 已完成，正在编译 Master r' + pushed.masterRevision);
      const result = await compiler.compile({ root: projectRoot, masterFile, profile, revision: pushed.masterRevision, text: snapshot.text,
        verifyRevision: async () => {
          const state = await client.request('GET', '/v1/state');
          if (state.masterRevision !== pushed.masterRevision || state.drift) throw new Error('Master 已变化，本轮编译停止，请重新编译。');
        }
      }, (index, command, total = profile.steps.length) => {
        buildLogStatus.text = '$(sync~spin) r' + pushed.masterRevision + ' ' + command + ' ' + index + '/' + total + ' · 日志';
      });
      buildLogStatus.text = result.generated ? '$(output) r' + result.pdfRevision + ' PDF' + (result.status === 'pdf-with-errors' ? ' · 有错误' : '') + ' · 日志' :
        result.status === 'cancelled' ? '$(output) 已取消 · 日志' : '$(error) 未生成新 PDF · 日志';
      buildLogStatus.tooltip = (result.error ? result.error + '\n' : '') + '点击打开 / 隐藏编译日志。';
      if (result.generated) await openPdf({ quiet: true, reload: true });
      if (!result.generated && result.status !== 'cancelled') throw new Error('Push 已完成，但未生成新 PDF。请查看编译日志及项目根目录中的产物。' + (result.error || ''));
      return result;
    } catch (error) {
      buildLogStatus.text = '$(error) 编译未完成 · 日志'; buildLogStatus.tooltip = error.message + '\n点击打开 / 隐藏编译日志。';
      buildOutput.appendLine('未完成：' + error.message);
      throw error;
    } finally { buildBusy = false; compileButton(); await vscode.commands.executeCommand('setContext', 'paperReview.compiling', false); }
  });
  register('paperReview.refresh', () => refreshStatus(true));
  register('paperReview.state', async () => {
    if (!client) throw new Error('请先打开 Human Draft。');
    output.clear();
    output.appendLine(JSON.stringify(await client.request('GET', '/v1/state'), null, 2));
    output.show(true);
  });
  async function savedEditor() {
    if (transitioning) throw new Error('正在打开或关闭项目，请稍后重试。');
    if (!client || !uri) throw new Error('请先打开 Human Draft。');
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { viewColumn: vscode.ViewColumn.One, preview: false });
    if (provider.blocked) throw new Error('请先另存 Human Draft，再关闭并重新打开。');
    if (editor.document.isDirty && !await editor.document.save() || editor.document.isDirty) throw new Error('请先保存 Human Draft。');
    return editor;
  }
  async function syncResult(editor, version, result) {
    if (result.text === undefined) return;
    try {
      const doc = editor.document;
      if (doc.version !== version || doc.isDirty) throw new Error('操作时 Human Draft 已变化，请另存后重新打开。');
      const selections = editor.selections, visible = editor.visibleRanges[0];
      provider.pendingPull = result;
      const ok = await editor.edit(edit => edit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), result.text));
      if (!ok || !await doc.save() || doc.getText().replace(/\r\n/g, '\n') !== result.text) throw new Error('Human Draft 同步失败，请另存编辑器内容后重新打开。');
      provider.version = result.draftVersion; provider.pendingPull = undefined;
      editor.selections = selections.map(s => new vscode.Selection(doc.validatePosition(s.anchor), doc.validatePosition(s.active)));
      if (visible) editor.revealRange(doc.validateRange(visible), vscode.TextEditorRevealType.AtTop);
      provider.refresh();
    } catch (error) { provider.blocked = true; provider.pendingPull = undefined; throw error; }
  }
  function draftOffset(document, point) { return document.getText().slice(0, document.offsetAt(point)).replace(/\r\n/g, '\n').length; }
  function draftPosition(document, offset) {
    const lines = document.getText().replace(/\r\n/g, '\n').slice(0, offset).split('\n');
    return document.validatePosition(new vscode.Position(lines.length - 1, lines.at(-1).length));
  }
  register('paperReview.locate', async value => {
    const editor = await savedEditor();
    const target = value.anchor || value;
    const range = new vscode.Range(draftPosition(editor.document, target.start), draftPosition(editor.document, target.end));
    editor.selection = new vscode.Selection(range.start, range.end); editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });
  async function reviewAction(action, item) {
    if (operation) throw new Error('正在处理项目操作，请稍后重试。');
    const editor = await savedEditor();
    await ui.refresh();
    const selection = editor.selection, start = draftOffset(editor.document, selection.start), end = draftOffset(editor.document, selection.end);
    // Editor context menus pass a document URI, whereas review items carry .review.
    const targetReview = item?.review;
    const selected = targetReview ? [targetReview] : ui.reviews.filter(r => selection.isEmpty ? r.start <= start && r.end >= start : r.start < end && r.end > start);
    if (!targetReview && ['unreviewed', 'needsFix'].includes(action)) {
      operation = true; provider.busy = true;
      try {
        const version = editor.document.version;
        const result = await client.request('POST', '/v1/reviews', { action, range: { start, end }, expectedDraftVersion: provider.version });
        await syncResult(editor, version, result);
      } finally { provider.busy = false; operation = false; await refreshStatus(); }
      return;
    }
    if (!selected.length) throw new Error('请先选择待审核或需修改的范围。');
    if (action === 'reject' && selected.length > 1) throw new Error('请一次拒绝一处完整修改。');
    operation = true; provider.busy = true;
    try {
      for (const review of selected) {
        const partial = !targetReview && !selection.isEmpty && review.kind === 'token' && (start > review.start || end < review.end);
        if (partial && action === 'reject') throw new Error('无法单独撤回所选片段，请拒绝整处高亮修改或手动编辑。');
        let rejectWholeEvent = false;
        if (action === 'reject' && review.origin === 'manual') throw new Error('手动标记没有可撤回的 AI 修改，请直接编辑或通过审核。');
        if (action === 'reject' && review.origin === 'initial') throw new Error('初始正文没有可撤回的版本，请直接编辑、标红或通过审核。');
        if (action === 'reject' && (review.original === null || review.rejectionMode === 'event')) {
          const chosen = await vscode.window.showQuickPick(['拒绝完整修改', '取消'], {
            title: '将撤回同一次修改的全部片段。'
          });
          if (chosen !== '拒绝完整修改') return;
          rejectWholeEvent = true;
        }
        const version = editor.document.version;
        const result = await client.request('POST', '/v1/reviews', { action, reviewId: review.id, version: review.version,
          contentHash: review.contentHash, expectedDraftVersion: provider.version, rejectWholeEvent,
          selection: partial && action !== 'reject' ? { start: Math.max(start, review.start) - review.start, end: Math.min(end, review.end) - review.start } : undefined });
        await syncResult(editor, version, result);
      }
    } finally { provider.busy = false; operation = false; await refreshStatus(); }
  }
  for (const [command, action] of [['approve', 'approve'], ['unreviewed', 'unreviewed'], ['needsFix', 'needsFix'], ['reject', 'reject']]) register(`paperReview.${command}`, item => reviewAction(action, item));
  async function saveIssueEditors() {
    for (const doc of vscode.workspace.textDocuments.filter(doc => !doc.isClosed && doc.uri.scheme === 'paper-issue' && doc.uri.authority === uri?.authority)) {
      if (doc.isDirty && !await doc.save() || doc.isDirty) throw new Error('请先保存 Issue 编辑页。');
    }
  }
  async function selectedIssue(item) {
    if (!client) throw new Error('请先打开项目。');
    if (item?.issue) return item.issue;
    const active = vscode.window.activeTextEditor?.document.uri;
    const issues = await client.request('GET', '/v1/issues');
    if (active?.scheme === 'paper-issue' && active.authority === uri.authority) return issues.filter(i => i.id === issueFs.id(active)).map(i => ({ ...i, version: issueFs.expected(active) }))[0];
    return (await vscode.window.showQuickPick(issues.map(issue => ({ label: issue.title, issue })), { title: '选择 Issue' }))?.issue;
  }
  async function openIssueEditor(issue) {
    if (!issue) return;
    issue = (await client.request('GET', '/v1/issues')).find(current => current.id === issue.id);
    if (!issue) throw new Error('Issue 已删除。');
    let existing = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.scheme === 'paper-issue' &&
      doc.uri.authority === uri.authority && issueFs.id(doc.uri) === issue.id);
    if (existing && !existing.isDirty && existing.getText().replace(/\r\n/g, '\n') !== issueText(issue)) {
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === existing.uri.toString());
      if (tabs.length && !await vscode.window.tabGroups.close(tabs, true)) return;
      existing = undefined;
    }
    await issueFs.accept(issue, uri.authority);
    const document = existing || await vscode.workspace.openTextDocument(issueFs.resource(uri, issue));
    await vscode.window.showTextDocument(await vscode.languages.setTextDocumentLanguage(document, 'markdown'),
      { viewColumn: vscode.ViewColumn.One, preview: false });
    vscode.window.setStatusBarMessage('Issue：首行填写标题，下方填写描述。Ctrl+S 保存到 Human Draft，Push 后提交。', 7000);
  }
  async function issueInput(item, mode = 'create') {
    if (mode === 'rebind') await saveIssueEditors();
    let issue = mode === 'rebind' ? await selectedIssue(item) : undefined;
    if (issue) issue = (await client.request('GET', '/v1/issues')).find(current => current.id === issue.id);
    if (mode === 'rebind' && !issue) return;
    const editor = await savedEditor(), version = editor.document.version;
    const offset = draftOffset(editor.document, editor.selection.active);
    const binding = (await vscode.window.showQuickPick([
      { label: '当前行', value: 'line', description: '绑定光标所在的源码行（默认）' },
      { label: '当前段落', value: 'paragraph', description: '绑定一个普通段落；标题或环境中使用当前行' },
      ...(mode === 'create' ? [{ label: '独立 Issue', value: 'general', description: '不绑定正文' }] : [])
    ], { title: 'Issue 绑定范围' }))?.value;
    if (!binding) return;
    const title = issue?.title || await vscode.window.showInputBox({ title: 'Issue 标题', ignoreFocusOut: true });
    if (!title?.trim()) return;
    if (editor.document.version !== version || editor.document.isDirty) throw new Error('正文已变化，请重新选择 Issue 位置。');
    const result = await client.request('POST', '/v1/issues', { id: issue?.id, expectedVersion: issue?.version, title,
      description: issue?.description || '', type: binding === 'general' ? 'general' : 'anchored', anchorMode: binding === 'general' ? undefined : binding,
      status: issue?.status || 'open', offset: binding === 'general' ? undefined : offset, expectedDraftVersion: provider.version });
    await issueFs.accept(result.issue, uri.authority);
    await refreshStatus(true);
    if (mode === 'create') await openIssueEditor(result.issue);
  }
  register('paperReview.createIssue', () => issueInput());
  register('paperReview.editIssue', async item => openIssueEditor(await selectedIssue(item)));
  register('paperReview.rebindIssue', item => issueInput(item, 'rebind'));
  register('paperReview.toggleIssue', async item => {
    const issue = await selectedIssue(item); if (!issue) return;
    await saveIssueEditors(); await savedEditor();
    const current = (await client.request('GET', '/v1/issues')).find(i => i.id === issue.id);
    if (!current) throw new Error('Issue 已删除。');
    const result = await client.request('POST', '/v1/issues', { ...current, expectedVersion: current.version,
      status: current.status === 'open' ? 'resolved' : 'open', expectedDraftVersion: provider.version });
    await issueFs.accept(result.issue, uri.authority);
    await refreshStatus(true);
  });
  register('paperReview.deleteIssue', async item => {
    const issue = await selectedIssue(item); if (!issue) return;
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.scheme === 'paper-issue' &&
      tab.input.uri.authority === uri.authority && issueFs.id(tab.input.uri) === issue.id);
    // Native Save / Don't Save / Cancel protects any unsaved note before deletion.
    if (tabs.length && !await vscode.window.tabGroups.close(tabs, true)) return;
    const expectedVersion = Math.max(issue.version, ...tabs.map(tab => issueFs.expected(tab.input.uri)));
    const state = await client.request('GET', '/v1/state');
    await client.request('POST', '/v1/issues', { action: 'delete', id: issue.id, expectedVersion, expectedDraftVersion: state.draftVersion });
    await refreshStatus(true);
    vscode.window.setStatusBarMessage('Issue 已从 Human Draft 删除，Push 后提交。', 5000);
  });
  async function locateIssue(item) {
    const issue = await selectedIssue(item); if (!issue) return;
    await savedEditor(); // Save first, then read the remapped anchor rather than a stale tree item.
    const current = (await client.request('GET', '/v1/issues')).find(value => value.id === issue.id);
    if (!current) throw new Error('Issue 已删除。');
    if (!current.anchor) throw new Error('此 Issue 未绑定正文，可右键编辑或重新绑定。');
    await vscode.commands.executeCommand('paperReview.locate', current);
  }
  register('paperReview.showIssue', async item => {
    const issue = await selectedIssue(item); if (!issue) return;
    if (issue.anchor) await locateIssue({ issue });
    else await openIssueEditor(issue);
  });
  register('paperReview.locateIssue', locateIssue);
  async function chooseConflict(item) {
    if (!client) throw new Error('请先打开 Human Draft。');
    if (item?.issue?.conflictId) return item.issue.conflictId;
    const conflicts = (await client.request('GET', '/v1/state')).conflicts;
    const state = await client.request('GET', '/v1/state');
    if (state.activeConflict) return state.activeConflict.id;
    if (conflicts.length === 1) return conflicts[0].id;
    if (!conflicts.length) return;
    return (await vscode.window.showQuickPick(conflicts.map(c => ({ label: c.id, description: `${c.kind} · r${c.revision}`, id: c.id }))))?.id;
  }
  async function openConflictEditor(id) {
    const prefix = path.join(client.root, '.paper-manager', 'conflicts', id) + path.sep;
    for (const doc of vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file' && doc.uri.fsPath.startsWith(prefix) && path.basename(doc.uri.fsPath) === 'result.tex')) {
      if (doc.isDirty && !await doc.save() || doc.isDirty) throw new Error('请先保存合并结果，再重新打开。');
    }
    const prepared = await client.request('POST', `/v1/conflicts/${id}/prepare`, {});
    const args = ['--merge', prepared.paths.current, prepared.paths.incoming, prepared.paths.base, prepared.paths.result]
      .map(value => ({ value, quoting: vscode.ShellQuoting.Strong }));
    const task = new vscode.Task({ type: 'paper-review-merge' }, vscode.TaskScope.Workspace, '处理论文冲突', 'paper-review',
      new vscode.ShellExecution('code', args, { cwd: client.root }));
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Never, panel: vscode.TaskPanelKind.Dedicated };
    await vscode.tasks.executeTask(task);
    preparedConflictId = id;
    submitConflictStatus.show();
    await vscode.commands.executeCommand('setContext', 'paperReview.conflictPrepared', true);
    output.appendLine(`合并结果：${prepared.paths.result}。保存后点击“提交合并结果”。`);
  }
  register('paperReview.resolveConflict', async item => {
    const id = await chooseConflict(item); if (id) await openConflictEditor(id);
  });
  register('paperReview.submitConflict', async item => {
    if (!client) throw new Error('请先打开 Human Draft。');
    if (operation || provider.busy) throw new Error('正在处理项目操作，请稍后重试。');
    const stateBefore = await client.request('GET', '/v1/state');
    const active = vscode.window.activeTextEditor?.document.uri;
    const fromFile = active?.scheme === 'file' && stateBefore.conflicts.find(c => active.fsPath === path.join(client.root, c.preparedDirectory || c.directory, 'result.tex'))?.id;
    const id = item?.issue?.conflictId || fromFile || preparedConflictId || await chooseConflict(item); if (!id) return;
    await saveIssueEditors();
    const editor = await savedEditor(), version = editor.document.version;
    operation = true; provider.busy = true;
    try {
      // Merge Editor is backed by real files: save all dirty resolution resources.
      for (const doc of vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file' && d.uri.fsPath.startsWith(path.join(client.root, '.paper-manager', 'conflicts', id) + path.sep))) {
        if (doc.isDirty && !await doc.save() || doc.isDirty) throw new Error('请先保存合并结果。');
      }
      const state = await client.request('GET', '/v1/state');
      const result = await client.request('POST', `/v1/conflicts/${id}/resolve`, { expectedMasterRevision: state.masterRevision, expectedDraftVersion: provider.version, syncHuman: true });
      await syncResult(editor, version, result);
      const prefix = path.join(client.root, '.paper-manager', 'conflicts', id) + path.sep;
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
        const input = tab.input;
        return [input?.uri, input?.original, input?.modified, input?.base, input?.input1, input?.input2, input?.result]
          .some(resource => resource?.scheme === 'file' && resource.fsPath.startsWith(prefix));
      });
      if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
      preparedConflictId = undefined;
    } finally {
      provider.busy = false; operation = false; await refreshStatus(true);
      for (const issue of ui?.issues || []) await issueFs.accept(issue, uri.authority);
    }
  });
  register('paperReview.snapshot', async () => {
    if (!client) throw new Error('请先打开 Human Draft。');
    const mode = await vscode.window.showQuickPick(['仅保存 Master', '选择项目文件']);
    if (!mode) return;
    let files = [masterFile];
    if (mode === '选择项目文件') {
      const chosen = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, defaultUri: vscode.Uri.file(client.root), openLabel: '选择提交文件' });
      if (!chosen?.length) return;
      files = chosen.map(file => path.relative(client.root, file.fsPath));
    }
    const message = await vscode.window.showInputBox({ title: 'Git 提交说明' }); if (!message?.trim()) return;
    const state = await client.request('GET', '/v1/state');
    const result = await client.request('POST', '/v1/snapshot', { files, message, expectedMasterRevision: state.masterRevision });
    vscode.window.showInformationMessage(`已保存 Git 阶段版本：${result.commit.slice(0, 8)}`);
  });
  function metadataClient(resource) {
    if (!client || resource.authority !== uri.authority) throw new Error('请先打开此历史记录所属项目。');
    return client;
  }
  function metadataUri(scheme, resourcePath) {
    return vscode.Uri.from({ scheme, authority: uri.authority, path: resourcePath });
  }
  const eventProvider = { provideTextDocumentContent: async resource => {
    const [id, side] = resource.path.slice(1).split('/');
    const event = (await metadataClient(resource).request('GET', '/v1/events')).find(e => e.id === id);
    return event?.[side] || '';
  } };
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('paper-event', eventProvider));
  register('paperReview.events', async () => {
    if (!client) throw new Error('请先打开 Human Draft。');
    const events = await client.request('GET', '/v1/events');
    const chosen = await vscode.window.showQuickPick(events.slice().reverse().map(event => ({ label: `r${event.revision} · ${event.type}`, description: (event.after || event.before).replace(/\s+/g, ' ').slice(0, 80), event })));
    if (chosen) await vscode.commands.executeCommand('vscode.diff', metadataUri('paper-event', `/${chosen.event.id}/before`), metadataUri('paper-event', `/${chosen.event.id}/after`), 'AI 修改历史');
  });
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('paper-revision', {
    provideTextDocumentContent: async resource => (await metadataClient(resource).request('GET', `/v1/revisions/${Number(resource.path.slice(1))}`)).text
  }));
  async function chooseRevision() {
    if (!client) throw new Error('请先打开 Human Draft。');
    const revisions = await client.request('GET', '/v1/revisions');
    return (await vscode.window.showQuickPick(revisions.slice().reverse().map(revision => ({
      label: `r${revision.revision}`, description: revision.actor, revision: revision.revision
    }))))?.revision;
  }
  register('paperReview.history', async () => {
    const revision = await chooseRevision(); if (!revision) return;
    const state = await client.request('GET', '/v1/state');
    await vscode.commands.executeCommand('vscode.diff', metadataUri('paper-revision', `/${revision}`),
      metadataUri('paper-revision', `/${state.masterRevision}`), `Master r${revision} → r${state.masterRevision}`);
  });
  register('paperReview.storage', () => storageUi.open());
  register('paperReview.restore', async () => {
    const revision = await chooseRevision(); if (!revision) return;
    const state = await client.request('GET', '/v1/state');
    await client.request('POST', `/v1/revisions/${revision}/restore`, { expectedMasterRevision: state.masterRevision });
    await refreshStatus(true);
  });
  provider.onSaved = refreshStatus;
  if (vscode.workspace.onDidChangeConfiguration) context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('paperReview.storage')) void storageUi.sync().catch(showError);
    if (event.affectsConfiguration('paperReview.overleaf.enabled')) void overleaf.refresh();
    updateTargetButtons();
    void settingsUi.changed(event).then(() => { updateTargetButtons(); if (!buildBusy) compileButton(); }).catch(showError);
    if (event.affectsConfiguration('paperReview.fixChatGPTWebLatex') && config().get('fixChatGPTWebLatex') === false) {
      void (async () => {
        for (const browser of webViews.values()) {
          if (!browser.bridge) continue;
          const visible = browser.tab && browser.entries().some(entry => entry.tab === browser.tab);
          await browser.setBridge(undefined);
          if (visible) await browser.open(rightColumn());
        }
        chatBridge?.dispose(); chatBridge = undefined;
      })().catch(showError);
    }
    if (!buildBusy) compileButton();
  }));
  context.subscriptions.push(provider, issueFs, output, status, conflictStatus, submitConflictStatus, buildOutput, buildStatus, buildLogStatus, pdfStatus, codexStatus, instructionStatus, chatStatus,
    vscode.workspace.registerFileSystemProvider('paper', provider, { isCaseSensitive: true }),
    vscode.workspace.registerFileSystemProvider('paper-issue', issueFs, { isCaseSensitive: true }),
    vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.scheme === 'paper') { ui?.changed(); void refreshStatus(); } }),
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      ui?.decorate();
      const restored = editors.find(editor => editor.document.uri.scheme === 'paper');
      if (restored && !client && !transitioning) void provider.ready(restored.document.uri).then(() => refreshStatus()).catch(showError);
    }),
    new vscode.Disposable(() => ui?.dispose()),
    vscode.workspace.onDidCloseTextDocument(doc => { if (doc.uri.scheme === 'paper') { provider.blocked = false; provider.pendingPull = undefined; } }));
  void settingsUi.initialize().catch(showError);
  const timer = setInterval(refreshStatus, 2500);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
  updater.start();
  void (async () => {
    await resumePendingProject();
    if (!client) await autoOpenManagedProject();
  })().catch(showError);
}
async function deactivate() { await activeCompiler?.cancel(); activeCompiler = undefined; await activeManager?.stop(); activeManager = undefined; }
module.exports = { activate, deactivate };
