'use strict';
const defaults = require('./manifestSettings').properties;
const known = [
  { extensionId: 'openai.chatgpt', name: 'Codex', command: 'chatgpt.newCodexPanel' },
  { extensionId: 'anthropic.claude-code', name: 'Claude Code', command: 'anthropic.claude-code.openInNewTab' }
];
function title(value) { return typeof value === 'string' ? value : value?.value || ''; }
function detectAgents(extensions) {
  const targets = [];
  for (const extension of extensions || []) {
    if (extension.id === 'local-paper-tools.paper-review-tool') continue;
    const manifest = extension.packageJSON || {}, commands = manifest.contributes?.commands || [];
    const preset = known.find(item => item.extensionId === extension.id);
    if (!preset && !/codex|claude|copilot|cline|roo[\s-]?code|continue|windsurf|ai.*(?:chat|agent)|(?:chat|agent).*ai/i.test(extension.id + ' ' + manifest.displayName + ' ' + manifest.description)) continue;
    let candidate = commands.find(c => c.command === preset?.command);
    if (!candidate && preset?.name === 'Claude Code') candidate = commands.find(c => /(?:openInNewTab|editor\.open)$/i.test(c.command));
    if (!candidate) candidate = commands.filter(c => /(?:open|show|focus|start)/i.test(c.command + ' ' + title(c.title)))
      .filter(c => score(c) > 0).sort((a,b) => score(b) - score(a))[0];
    // Known Codex entry is retained for older manifests omitting command metadata.
    if (!candidate && !preset) continue;
    targets.push({ name: preset?.name || manifest.displayName || extension.id, extensionId: extension.id,
      command: candidate?.command || preset.command, detected: true });
  }
  return targets.sort((a,b) => (a.extensionId === 'openai.chatgpt' ? -1 : b.extensionId === 'openai.chatgpt' ? 1 : a.name.localeCompare(b.name)));
}
function score(c) {
  const text = c.command + ' ' + title(c.title);
  return (/editor|newTab|InTab|panel|newCodexPanel/i.test(text) ? 20 : 0) +
    (/open|show/i.test(text) ? 5 : 0) - (/settings|log|terminal|diff|history|file|url/i.test(text) ? 30 : 0);
}
function validAgent(target) {
  if (!target || typeof target.name !== 'string' || !target.name.trim() || typeof target.command !== 'string' || !target.command.trim() ||
      /[\s\0]/.test(target.command) || target.extensionId !== undefined && typeof target.extensionId !== 'string' ||
      target.args !== undefined && !Array.isArray(target.args)) throw Error('Agent 入口需要 name、command，以及可选的 extensionId / args。');
  if (/^paperReview\./.test(target.command)) throw Error('Agent 目标不能指向 Paper 自身命令。');
  return target;
}
function webTarget(target) {
  if (!target || typeof target.name !== 'string' || !target.name.trim() || typeof target.url !== 'string') throw Error('Web 入口需要 name 和 url。');
  const url = new URL(target.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Web 入口仅支持不含凭据的 HTTP(S) 地址。');
  return { ...target, url: url.href };
}
function isChatGPT(url) {
  return /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/i.test(url);
}
function agentChoice(config) { return config.get('defaultAgent') ?? 'codex'; }
function resolveAgent(config, extensions = []) {
  const choice = agentChoice(config);
  if (choice === 'other') return validAgent(config.get('customAgent') ?? defaults['paperReview.customAgent'].default);
  const preset = known.find(item => item.extensionId === (choice === 'claude-code' ? 'anthropic.claude-code' : 'openai.chatgpt'));
  const target = detectAgents(extensions).find(item => item.extensionId === preset.extensionId) || preset;
  return { name: target.name, extensionId: target.extensionId, command: target.command };
}
function resolveWeb(config) {
  const choice = config.get('defaultWeb') ?? 'gpt';
  if (choice === 'other') return webTarget(config.get('customWeb') ?? defaults['paperReview.customWeb'].default);
  return choice === 'claude' ? { name: 'Claude Web', url: 'https://claude.ai/' } : { name: 'ChatGPT Web', url: 'https://chatgpt.com/' };
}
class TargetMenus {
  constructor(vscode, workspaceState, { openAgent, openWeb }) {
    this.vscode = vscode; this.openAgent = openAgent; this.openWeb = openWeb;
  }
  config() { return this.vscode.workspace.getConfiguration('paperReview'); }
  async save(key, value) {
    const scope = this.vscode.workspace.workspaceFolders?.length ? this.vscode.ConfigurationTarget.Workspace : this.vscode.ConfigurationTarget.Global;
    await this.config().update(key, value, scope);
  }
  async agent(column) { return this.openAgent(resolveAgent(this.config(), this.vscode.extensions.all), column); }
  async web(column) { return this.openWeb(resolveWeb(this.config()), column); }
  async configureAgent() {
    const targets = detectAgents(this.vscode.extensions.all);
    const picked = await this.vscode.window.showQuickPick(targets.map(target => ({ label: target.name, description: target.command, target })), { title: '配置默认 Agent' });
    if (!picked) return;
    const target = picked.target;
    const choice = target.extensionId === 'openai.chatgpt' ? 'codex' : target.extensionId === 'anthropic.claude-code' ? 'claude-code' : 'other';
    if (choice === 'other') await this.save('customAgent', { name: target.name, command: target.command, extensionId: target.extensionId });
    await this.save('defaultAgent', choice);
  }
}
module.exports = { TargetMenus, detectAgents, validAgent, webTarget, isChatGPT, resolveAgent, resolveWeb, agentChoice };
