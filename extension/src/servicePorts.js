'use strict';
const net = require('node:net');

// Port choices belong to the selected folder, never to user-wide settings.
function projectPortOptions(vscode, root) {
  const resource = vscode.Uri.file(root);
  const config = vscode.workspace.getConfiguration('paperReview', resource);
  const local = key => {
    const value = config.inspect(key);
    return value?.workspaceFolderValue ?? value?.workspaceValue;
  };
  const mode = local('service.portMode') ?? 'random';
  if (mode === 'random') return { port: 0 };
  if (!['project', 'manual'].includes(mode)) throw Error('无效的项目端口模式。');
  const port = local('service.port') ?? 0;
  if (!Number.isInteger(port) || port < (mode === 'manual' ? 1 : 0) || port > 65535) {
    throw Error('请在项目的文件夹设置中填写 1–65535 的服务端口。');
  }
  return { port, onPort: mode === 'project' && port === 0 ? async actual => {
    // Do not overwrite a choice made while the service was starting.
    if (local('service.portMode') !== 'project' || (local('service.port') ?? 0) !== 0) return;
    await config.update('service.port', actual, vscode.ConfigurationTarget.WorkspaceFolder);
  } : undefined };
}

function portError(error, port) {
  if (error.code === 'EADDRINUSE') return Error(`项目服务端口 ${port} 已被占用。请释放端口或修改项目的端口设置后重试。`);
  if (error.code === 'EACCES') return Error(`项目服务端口 ${port} 不可用（无监听权限）。请修改项目的端口设置后重试。`);
  return error;
}

// Check before a new Worker can initialize the project. The real listen still
// handles a competing bind between this check and service startup.
async function checkPort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('无效的项目服务端口。');
  if (port === 0) return;
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(portError(error, port)));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
  });
}
module.exports = { projectPortOptions, checkPort, portError };
