'use strict';
// Plugin search/install (Modrinth) and Paper server jar download (PaperMC). Only fixed hosts are ever contacted,
// every download is checked against the hash the API publishes, and nothing is written outside the folder it is given.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const UA = 'mcpanel (+https://github.com/tlomts-dev/mcpanel)';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_CDN = 'cdn.modrinth.com';
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';
const PAPER_HOSTS = ['fill-data.papermc.io', 'fill.papermc.io'];
const MAX_PLUGIN = 100 * 1024 * 1024;
const MAX_JAR = 200 * 1024 * 1024;
const FILE_RE = /^[\w.+-]{1,100}\.jar$/;
const VERSION_RE = /^\d+(\.\d+){1,3}$/;

function createDownloads({ fetchImpl } = {}) {
  const f = fetchImpl || fetch;

  async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await f(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  // Streams a URL to destDir/filename, verifying size and hash. Returns the final path.
  async function downloadTo(url, hosts, destDir, filename, maxBytes, algo, expected) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !hosts.includes(u.hostname)) throw new Error('blocked host');
    if (!FILE_RE.test(filename)) throw new Error('bad file name');
    const final = path.join(destDir, filename), part = final + '.part';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10 * 60000);
    const hash = crypto.createHash(algo);
    let size = 0;
    const out = fs.createWriteStream(part);
    try {
      const r = await f(url, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'error' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      for await (const chunk of r.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('file too large');
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
      }
      await new Promise((res, rej) => { out.end(); out.on('finish', res); out.on('error', rej); });
      if (expected && hash.digest('hex') !== expected.toLowerCase()) throw new Error('checksum mismatch');
      await fsp.rename(part, final);
      return { file: filename, size };
    } catch (e) {
      out.destroy();
      await fsp.unlink(part).catch(() => {});
      throw e;
    } finally { clearTimeout(timer); }
  }

  return {
    async searchPlugins(query, mcVersion) {
      const facets = [['project_type:plugin']];
      if (VERSION_RE.test(mcVersion || '')) facets.push([`versions:${mcVersion}`]);
      const d = await getJson(`${MODRINTH_API}/search?limit=24&query=${encodeURIComponent(String(query || '').slice(0, 60))}${query ? '' : '&index=downloads'}&facets=${encodeURIComponent(JSON.stringify(facets))}`);
      return (d.hits || []).map(h => ({ id: h.project_id, slug: h.slug, title: h.title, description: h.description, downloads: h.downloads, icon: h.icon_url || null }));
    },

    async installPlugin(projectId, mcVersion, pluginsDir) {
      if (!/^[\w-]{2,64}$/.test(String(projectId || ''))) throw new Error('bad project');
      let q = `loaders=${encodeURIComponent('["paper","spigot","bukkit","purpur","folia"]')}`;
      if (VERSION_RE.test(mcVersion || '')) q += `&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
      const versions = await getJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${q}`);
      if (!Array.isArray(versions) || !versions.length) throw new Error('no compatible version');
      const v = versions.find(x => x.version_type === 'release') || versions[0];
      const file = (v.files || []).find(x => x.primary) || (v.files || [])[0];
      if (!file) throw new Error('no file');
      await fsp.mkdir(pluginsDir, { recursive: true });
      const r = await downloadTo(file.url, [MODRINTH_CDN], pluginsDir, file.filename, MAX_PLUGIN, 'sha512', file.hashes && file.hashes.sha512);
      return { ...r, version: v.version_number };
    },

    async paperVersions() {
      const d = await getJson(PAPER_API);
      const out = [];
      for (const list of Object.values(d.versions || {})) for (const v of list) if (VERSION_RE.test(v)) out.push(v);
      return out;
    },

    async downloadPaper(version, destDir) {
      if (!VERSION_RE.test(String(version || ''))) throw new Error('bad version');
      const b = await getJson(`${PAPER_API}/versions/${version}/builds/latest`);
      const dl = b.downloads && b.downloads['server:default'];
      if (!dl) throw new Error('no download');
      const name = `paper-${version}.jar`;
      const r = await downloadTo(dl.url, PAPER_HOSTS, destDir, name, MAX_JAR, 'sha256', dl.checksums && dl.checksums.sha256);
      return { ...r, build: b.id, channel: b.channel };
    },
  };
}

module.exports = { createDownloads, FILE_RE, VERSION_RE };
