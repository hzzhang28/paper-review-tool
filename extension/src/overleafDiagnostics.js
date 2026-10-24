'use strict';

function redact(value, { token, root, cache, extensionPath, url } = {}) {
  let text = String(value ?? '');
  const secrets = token ? [token, encodeURIComponent(token), Buffer.from('git:' + token).toString('base64')] : [];
  for (const secret of secrets.sort((a, b) => b.length - a.length)) if (secret) text = text.split(secret).join('[REDACTED]');
  for (const [input, replacement] of [[root, '[project]'], [cache, '[cache]'], [extensionPath, '[extension]'], [url, 'https://git.overleaf.com/[project]']]) {
    if (!input) continue;
    for (const variant of [input, input.replace(/\\/g, '/'), input.replace(/\\/g, '\\\\')]) text = text.split(variant).join(replacement);
  }
  return text.replace(/(authorization["']?\s*[:=]\s*["']?)(?:Basic|Bearer)\s+[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/_=.\-]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|access_token|password|auth)=)[^\s&#]*/gi, '$1[REDACTED]')
    .replace(/(["']?(?:token|password|secret)["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi, '$1[REDACTED]')
    .replace(/\.paper-manager/gi, '[project data]')
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s]+/gi, '$1[user]')
    .replace(/(\/(?:Users|home)\/)[^/\s]+/g, '$1[user]')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, 12000);
}
function errorDetails(error, context) {
  const lines = [], seen = new Set();
  const visit = (current, label, depth) => {
    if (!current || seen.has(current) || depth > 4) return;
    seen.add(current);
    if (typeof current !== 'object') { lines.push(label + ': ' + String(current)); return; }
    lines.push(label + ': ' + (current.name || 'Error') + ': ' + (current.message || 'Unknown failure'));
    for (const key of ['code', 'caller', 'errno', 'syscall', 'statusCode', 'status']) {
      if (['string', 'number'].includes(typeof current[key])) lines.push('  ' + key + ': ' + current[key]);
    }
    // Deliberately omit error.data, HTTP headers, response bodies and document contents.
    if (Number.isInteger(current.data?.statusCode)) lines.push('  HTTP status: ' + current.data.statusCode);
    if (typeof current.stack === 'string') lines.push(current.stack.split('\n').slice(1, 7).join('\n'));
    visit(current.cause, 'Cause', depth + 1);
    if (Array.isArray(current.errors)) current.errors.slice(0, 3).forEach(child => visit(child, 'Nested cause', depth + 1));
  };
  visit(error, 'Error', 0);
  return redact(lines.join('\n'), context);
}
function publicMessage(error) {
  const code = error?.code || error?.name;
  return ['UserCanceledError', 'HttpError'].includes(code) ? 'Overleaf 认证或访问失败，请检查 Token 和项目 Git 权限。' :
    ['PushRejectedError', 'GitPushError'].includes(code) ? 'Overleaf 未接受推送，远端可能已有更新，请重试。' :
    /^(?:所选|请先选择|推送范围|文件必须|多个本地|远端文件路径|目标目录|目标文件|项目正在|项目快照|文件与目录|无效的推送规则)/.test(error?.message || '') ? error.message :
    'Overleaf 推送失败，请打开日志查看具体原因。';
}
module.exports = { redact, errorDetails, publicMessage };
