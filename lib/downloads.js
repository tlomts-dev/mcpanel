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
const HANGAR_API = 'https://hangar.papermc.io/api/v1';
const HANGAR_CDN = 'hangarcdn.papermc.io';
const HANGAR_SLUG_RE = /^[\w.-]{1,64}$/;
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

  const api = {
    async searchPlugins(query, mcVersion) {
      const facets = [['project_type:plugin']];
      if (VERSION_RE.test(mcVersion || '')) facets.push([`versions:${mcVersion}`]);
      const d = await getJson(`${MODRINTH_API}/search?limit=24&query=${encodeURIComponent(String(query || '').slice(0, 60))}${query ? '' : '&index=downloads'}&facets=${encodeURIComponent(JSON.stringify(facets))}`);
      return (d.hits || []).map(h => ({ id: h.project_id, slug: h.slug, title: h.title, description: h.description, downloads: h.downloads, icon: h.icon_url || null }));
    },

    // The version of a Modrinth project that install/update would pick: compatible with this Minecraft version and a
    // Paper-family loader, a release if there is one. { version, date, file: { url, filename, sha512, sha1 } }
    async latestModrinth(projectId, mcVersion) {
      if (!/^[\w-]{2,64}$/.test(String(projectId || ''))) throw new Error('bad project');
      let q = `loaders=${encodeURIComponent('["paper","spigot","bukkit","purpur","folia"]')}`;
      if (VERSION_RE.test(mcVersion || '')) q += `&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
      const versions = await getJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${q}`);
      if (!Array.isArray(versions) || !versions.length) throw new Error('no compatible version');
      const v = versions.find(x => x.version_type === 'release') || versions[0];
      const file = (v.files || []).find(x => x.primary) || (v.files || [])[0];
      if (!file) throw new Error('no file');
      return { version: v.version_number, date: Date.parse(v.date_published) || 0,
        file: { url: file.url, filename: file.filename, sha512: file.hashes && file.hashes.sha512, sha1: file.hashes && file.hashes.sha1 } };
    },

    // Same for Hangar: platform Paper, compatible, Release channel first. { version, date, file: { url, filename, sha256 } }
    async latestHangar(slug, mcVersion) {
      if (!HANGAR_SLUG_RE.test(String(slug || ''))) throw new Error('bad project');
      let q = `limit=10&platform=PAPER`;
      if (VERSION_RE.test(mcVersion || '')) q += `&platformVersion=${encodeURIComponent(mcVersion)}`;
      const pick = list => (list || []).find(v => v.downloads && v.downloads.PAPER && v.downloads.PAPER.downloadUrl && v.downloads.PAPER.fileInfo);
      let v = pick((await getJson(`${HANGAR_API}/projects/${encodeURIComponent(slug)}/versions?${q}&channel=Release`)).result);
      if (!v) v = pick((await getJson(`${HANGAR_API}/projects/${encodeURIComponent(slug)}/versions?${q}`)).result);
      if (!v) throw new Error('no compatible version');
      const dl = v.downloads.PAPER;
      return { version: v.name, date: Date.parse(v.createdAt) || 0, file: { url: dl.downloadUrl, filename: dl.fileInfo.name, sha256: dl.fileInfo.sha256Hash } };
    },

    // Downloads what latestModrinth/latestHangar returned (fixed hosts, hash checked).
    async fetchPluginFile(source, latest, pluginsDir) {
      await fsp.mkdir(pluginsDir, { recursive: true });
      const fl = latest.file;
      const r = source === 'hangar'
        ? await downloadTo(fl.url, [HANGAR_CDN], pluginsDir, fl.filename, MAX_PLUGIN, 'sha256', fl.sha256)
        : await downloadTo(fl.url, [MODRINTH_CDN], pluginsDir, fl.filename, MAX_PLUGIN, 'sha512', fl.sha512);
      return { ...r, version: latest.version, date: latest.date };
    },

    async installPlugin(projectId, mcVersion, pluginsDir) {
      return api.fetchPluginFile('modrinth', await api.latestModrinth(projectId, mcVersion), pluginsDir);
    },

    // Hangar (PaperMC's own plugin site). Same result shape as searchPlugins; `id` is the project slug.
    async searchHangar(query, mcVersion) {
      let q = `limit=24&platform=PAPER&sort=-downloads`;
      if (query) q += `&q=${encodeURIComponent(String(query).slice(0, 60))}`;
      if (VERSION_RE.test(mcVersion || '')) q += `&version=${encodeURIComponent(mcVersion)}`;
      const d = await getJson(`${HANGAR_API}/projects?${q}`);
      return (d.result || []).filter(h => h && h.namespace && HANGAR_SLUG_RE.test(h.namespace.slug || ''))
        .map(h => ({ id: h.namespace.slug, slug: h.namespace.slug, title: h.name, description: h.description || '', downloads: (h.stats && h.stats.downloads) || 0, icon: h.avatarUrl || null }));
    },

    async installHangar(slug, mcVersion, pluginsDir) {
      return api.fetchPluginFile('hangar', await api.latestHangar(slug, mcVersion), pluginsDir);
    },

    // Which Modrinth project and version each installed jar is, by file hash (exact, whatever the file is called).
    // Returns { sha1: { id, version, date } } for the hashes Modrinth knows.
    async identifyModrinth(sha1s) {
      const hashes = (sha1s || []).filter(h => /^[a-f0-9]{40}$/.test(h)).slice(0, 300);
      if (!hashes.length) return {};
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await f(`${MODRINTH_API}/version_files`, { method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ hashes, algorithm: 'sha1' }), signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = await r.json(), out = {};
        for (const [h, v] of Object.entries(d || {})) {
          if (v && /^[\w]{1,20}$/.test(v.project_id || '')) out[h] = { id: v.project_id, version: String(v.version_number || ''), date: Date.parse(v.date_published) || 0 };
        }
        return out;
      } finally { clearTimeout(timer); }
    },

    // All stable Paper versions, newest first.
    async paperVersions() {
      const d = await getJson(PAPER_API);
      const out = [];
      for (const list of Object.values(d.versions || {})) for (const v of list) if (VERSION_RE.test(v)) out.push(v);
      const key = v => v.split('.').map(Number);
      return out.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 4; i++) { const d2 = (y[i] || 0) - (x[i] || 0); if (d2) return d2; } return 0; });
    },

    // Builds of one version, newest first (up to 40).
    async paperBuilds(version) {
      if (!VERSION_RE.test(String(version || ''))) throw new Error('bad version');
      const list = await getJson(`${PAPER_API}/versions/${version}/builds`);
      if (!Array.isArray(list)) throw new Error('no download');
      return list.filter(b => b && Number.isInteger(b.id)).map(b => ({ id: b.id, channel: b.channel || 'STABLE', time: b.time || null }))
        .sort((a, b) => b.id - a.id).slice(0, 40);
    },

    // Which Paper build a jar is, by its sha256 (PaperMC publishes the hash of every build). null if unknown.
    async paperBuildBySha(version, sha256) {
      if (!VERSION_RE.test(String(version || '')) || !/^[a-f0-9]{64}$/.test(String(sha256 || ''))) return null;
      const list = await getJson(`${PAPER_API}/versions/${version}/builds`);
      const hit = (Array.isArray(list) ? list : []).find(b => b && b.downloads && b.downloads['server:default'] &&
        b.downloads['server:default'].checksums && b.downloads['server:default'].checksums.sha256 === sha256);
      return hit && Number.isInteger(hit.id) ? hit.id : null;
    },

    // Latest build id of a version (any channel Paper marks as its "latest").
    async paperLatest(version) {
      if (!VERSION_RE.test(String(version || ''))) throw new Error('bad version');
      const b = await getJson(`${PAPER_API}/versions/${version}/builds/latest`);
      return { id: b.id, channel: b.channel };
    },

    // Downloads one build (the latest when `build` is omitted) as paper-<version>-<build>.jar.
    async downloadPaper(version, destDir, build) {
      if (!VERSION_RE.test(String(version || ''))) throw new Error('bad version');
      if (build !== undefined && build !== null && build !== '' && !/^\d{1,6}$/.test(String(build))) throw new Error('bad version');
      const b = await getJson(`${PAPER_API}/versions/${version}/builds/${build ? String(build) : 'latest'}`);
      const dl = b.downloads && b.downloads['server:default'];
      if (!dl) throw new Error('no download');
      const name = `paper-${version}-${b.id}.jar`;
      const r = await downloadTo(dl.url, PAPER_HOSTS, destDir, name, MAX_JAR, 'sha256', dl.checksums && dl.checksums.sha256);
      return { ...r, build: b.id, channel: b.channel };
    },
  };
  return api;
}

module.exports = { createDownloads, FILE_RE, VERSION_RE };
