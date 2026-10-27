'use strict';
const defaults = require('./manifestSettings').properties;
function explicit(config, key) {
  const value = config.inspect?.(key);
  return value ? value.workspaceFolderValue ?? value.workspaceValue ?? value.globalValue : config.get(key);
}
function platformDefault(platform = process.platform) { return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'other'; }
function platformPreset(config, platform = process.platform) { return explicit(config, 'paperCompile') ?? platformDefault(platform); }
function profileId(config, platform = process.platform) {
  return explicit(config, 'compileProfile') ?? 'pdflatex-bibtex';
}
function validateProfile(profile) {
  if (!profile || typeof profile.id !== 'string' || !profile.id.trim() ||
      typeof profile.name !== 'string' || !profile.name.trim() || !Array.isArray(profile.steps)) throw Error('编译方案需要 id、name 和 steps。');
  for (const step of profile.steps) {
    if (typeof step.command !== 'string' || !step.command.trim() || /[\r\n\0]/.test(step.command) ||
        !Array.isArray(step.args) || step.args.some(arg => typeof arg !== 'string' || /[\r\n\0]/.test(arg)) ||
        (step.ifBibliography !== undefined && typeof step.ifBibliography !== 'boolean')) throw Error('编译步骤需要 command 和字符串数组 args。');
    for (const arg of step.args) {
      const unknown = arg.replace(/\$\{(?:file|stem|root)\}/g, '').match(/\$\{[^}]+\}/);
      if (unknown) throw Error('未知编译变量：' + unknown[0]);
    }
  }
  return structuredClone(profile);
}
function profiles(config, platform = process.platform) {
  const list = (platformPreset(config, platform) === 'other' ? config.get('customCompileProfiles') : undefined) ?? config.get('compileProfiles') ?? defaults['paperReview.compileProfiles'].default;
  if (!Array.isArray(list)) throw Error('编译方案列表必须是数组。');
  const ids = new Set();
  return list.map(profile => {
    validateProfile(profile);
    if (ids.has(profile.id)) throw Error('重复编译方案 id：' + profile.id);
    ids.add(profile.id); return profile;
  });
}
function selectedProfile(config, platform = process.platform) {
  const id = profileId(config, platform);
  if (!id) return undefined;
  const profile = id === 'other' ? config.get('customCompile') ?? defaults['paperReview.customCompile'].default : profiles(config, platform).find(item => item.id === id);
  if (!profile) throw Error('找不到编译方案 ' + id + '，请打开“编译设置”。');
  return validateProfile(profile);
}
function expandSteps(profile, job) {
  return validateProfile(profile).steps.map(step => ({ ...step,
    args: step.args.map(arg => arg.replace(/\$\{(file|stem|root)\}/g, (_, key) => ({ file: job.masterFile, stem: job.base, root: job.root })[key]))
  }));
}
module.exports = { profileId, profiles, selectedProfile, validateProfile, expandSteps, explicit, platformDefault, platformPreset };
