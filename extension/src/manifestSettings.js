'use strict';
// The manifest declares settings in several titled sections; code that needs a
// declared default reads the flattened map.
const manifest = require('../package.json');
const configuration = manifest.contributes.configuration;
const blocks = Array.isArray(configuration) ? configuration : [configuration];
const properties = Object.assign({}, ...blocks.map(block => block.properties || {}));
module.exports = { manifest, blocks, properties };
