'use strict';
function agentInstruction({ port }, template = require('./manifestSettings').properties['paperReview.agentInstruction'].default) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid local service connection.');
  if (typeof template !== 'string') throw Error('Agent Instruction 必须是文本。');
  return template.replaceAll('{{port}}', String(port));
}
module.exports = { agentInstruction };
