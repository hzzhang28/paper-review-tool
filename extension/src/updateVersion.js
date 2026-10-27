'use strict';
const path = require('node:path');

const BUILD_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:([rt])(\d+))?$/;
const VSIX_PATTERN = /^paper-review-tool-(\d+\.\d+\.\d+(?:[rt]\d+)?)\.vsix$/i;
const CHANNEL_RANK = { t: 0, '': 1, r: 2 };
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseBuild(value) {
  if (typeof value !== 'string') return undefined;
  const match = BUILD_PATTERN.exec(value.trim());
  if (!match) return undefined;
  return {
    version: [Number(match[1]), Number(match[2]), Number(match[3])],
    channel: match[4] || '',
    serial: match[5] === undefined ? 0 : Number(match[5])
  };
}

function compareBuild(left, right) {
  const a = typeof left === 'string' ? parseBuild(left) : left;
  const b = typeof right === 'string' ? parseBuild(right) : right;
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index++) {
    if (a.version[index] !== b.version[index]) return a.version[index] - b.version[index];
  }
  const channel = CHANNEL_RANK[a.channel] - CHANNEL_RANK[b.channel];
  return channel || a.serial - b.serial;
}

function isNewerBuild(latest, current) {
  return compareBuild(latest, current) > 0;
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value.trim());
  return match ? match[1].toLowerCase() : undefined;
}

function safeHttpsUrl(value, { allowLoopbackHttp = false } = {}) {
  let url;
  try { url = new URL(value); } catch { return undefined; }
  if (url.username || url.password) return undefined;
  if (url.protocol === 'https:') return url.href;
  if (allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.href;
  return undefined;
}

function parseAssetName(value) {
  if (typeof value !== 'string') return undefined;
  const name = path.basename(value);
  if (name !== value) return undefined;
  const match = VSIX_PATTERN.exec(name);
  if (!match) return undefined;
  return parseBuild(match[1]) ? { name, build: match[1] } : undefined;
}

function selectReleaseAsset(release) {
  if (!release || !Array.isArray(release.assets)) return undefined;
  let best;
  for (const asset of release.assets) {
    if (!asset || typeof asset !== 'object') continue;
    if (asset.state && asset.state !== 'uploaded') continue;
    if (!(Number(asset.size) > 0)) continue;
    const parsed = parseAssetName(asset.name);
    if (!parsed) continue;
    const url = safeHttpsUrl(asset.browser_download_url, { allowLoopbackHttp: true });
    if (!url) continue;
    const candidate = {
      build: parsed.build,
      name: parsed.name,
      url,
      size: Number(asset.size),
      digest: normalizeDigest(asset.digest),
      pageUrl: safeHttpsUrl(release.html_url, { allowLoopbackHttp: true }),
      notes: typeof release.body === 'string' ? release.body.slice(0, 2000) : '',
      publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
      tag: typeof release.tag_name === 'string' ? release.tag_name : undefined
    };
    if (!best || compareBuild(candidate.build, best.build) > 0) best = candidate;
  }
  return best;
}

module.exports = {
  parseBuild, compareBuild, isNewerBuild, normalizeDigest,
  safeHttpsUrl, parseAssetName, selectReleaseAsset
};
