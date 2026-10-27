'use strict';
const { resolveAgent, resolveWeb } = require('./targetMenus');
const { selectedProfile, profiles, explicit, platformDefault, platformPreset } = require('./compileProfiles');
function safely(action, fallback) { try { return structuredClone(action()); } catch { return fallback; } }
class ConfigurationUi {
  constructor(vscode, targets, platform = process.platform) {
    this.vscode = vscode; this.targets = targets; this.platform = platform;
    this.previous = this.snapshot(); this.queue = Promise.resolve();
  }
  config() { return this.targets.config(); }
  snapshot() {
    const config = this.config();
    return {
      agentChoice: config.get('defaultAgent') ?? 'codex', webChoice: config.get('defaultWeb') ?? 'gpt',
      platform: platformPreset(config, this.platform), engine: explicit(config, 'compileProfile') ?? 'pdflatex-bibtex',
      agent: safely(() => resolveAgent(config, this.vscode.extensions.all)),
      web: safely(() => resolveWeb(config)),
      compileProfiles: safely(() => profiles(config, this.platform), require('./manifestSettings').properties['paperReview.compileProfiles'].default),
      compile: safely(() => selectedProfile(config, this.platform)) || require('./manifestSettings').properties['paperReview.customCompile'].default
    };
  }
  async initialize() {
    if (explicit(this.config(), 'paperCompile') === undefined) {
      await this.config().update('paperCompile', platformDefault(this.platform), this.vscode.ConfigurationTarget.Global);
      if (platformDefault(this.platform) === 'other') await this.openSetting('customCompileProfiles');
    }
  }
  openSetting(key) { return this.vscode.commands.executeCommand('workbench.action.openSettings', '@id:paperReview.' + key); }
  openCompile() { return this.vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-paper-tools.paper-review-tool compile'); }
  async seed(key, value) {
    if (explicit(this.config(), key) === undefined && value) await this.targets.save(key, structuredClone(value));
  }
  changed(event) {
    const before = this.previous, after = this.snapshot(); this.previous = after;
    const agent = event.affectsConfiguration('paperReview.defaultAgent') && after.agentChoice === 'other' && before.agentChoice !== 'other';
    const web = event.affectsConfiguration('paperReview.defaultWeb') && after.webChoice === 'other' && before.webChoice !== 'other';
    const platform = event.affectsConfiguration('paperReview.paperCompile') && after.platform === 'other' && before.platform !== 'other';
    const engine = event.affectsConfiguration('paperReview.compileProfile') && after.engine === 'other' && before.engine !== 'other';
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (agent && (this.config().get('defaultAgent') ?? 'codex') === 'other') {
        await this.seed('customAgent', before.agent); await this.openSetting('customAgent');
      }
      if (web && (this.config().get('defaultWeb') ?? 'gpt') === 'other') {
        await this.seed('customWeb', before.web); await this.openSetting('customWeb');
      }
      if (platform && platformPreset(this.config(), this.platform) === 'other') {
        await this.seed('customCompileProfiles', before.compileProfiles); await this.openSetting('customCompileProfiles');
      }
      if (engine && explicit(this.config(), 'compileProfile') === 'other') {
        await this.seed('customCompile', before.compile); await this.openSetting('customCompile');
      }
    });
    return this.queue;
  }
}
module.exports = { ConfigurationUi };
