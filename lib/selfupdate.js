'use strict';
// Updating the panel itself from GitHub: the latest release (stable) or the latest commit on main.
// The source zip is downloaded from GitHub only, every entry is checked, the files it replaces are backed up first,
// dependencies are installed only when package.json changed, and everything is put back if a step fails.
// Your data never moves: users, settings and backups live in the server folder, and .env is never overwritten.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const UA = 'mcpanel-self-update';
const GITHUB_API = 'https://api.github.com';
const ZIP_HOSTS = ['codeload.github.com', 'api.github.com'];
const MAX_ZIP = 60 * 1024 * 1024;
// never written by an update: your own config, installed modules, git data, update backups, screenshots
const SKIP = [/^\.env$/, /^node_modules(\/|$)/, /^\.git(\/|$)/, /^\.panel-updates(\/|$)/, /^screenshots(\/|$)/];
const REPO_RE = /^[\w.-]{1,60}\/[\w.-]{1,100}$/;

const cmpVer = (a, b) => {
  const x = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0), y = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

function createSelfUpdate({ panelDir, repo, fetchImpl, exec, unzipper, log }) {
  const f = fetchImpl || fetch;
  const run = exec || ((cmd, args, opts) => new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim().slice(-400))) : resolve(String(stdout)))));
  const REPO = REPO_RE.test(repo || '') ? repo : 'tlomts-dev/mcpanel';
  const stateFile = path.join(panelDir, '.panel-updates', 'installed.json');
  const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const pkg = () => readJson(path.join(panelDir, 'package.json')) || {};
  let state = { busy: false, step: '', error: '', done: false, restart: false };
  let cache = { at: 0, data: null };

  async function gh(p) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await f(GITHUB_API + p, { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }, signal: ctl.signal });
      if (!r.ok) throw new Error('GitHub HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  function installed() {
    const s = readJson(stateFile) || {};
    return { version: pkg().version || '0.0.0', sha: /^[0-9a-f]{40}$/.test(s.sha || '') ? s.sha : null, channel: s.channel || null, at: s.at || null };
  }

  // Latest release and latest commit on main, cached for 30 minutes (GitHub allows 60 anonymous calls an hour).
  async function check(force) {
    if (!force && cache.data && Date.now() - cache.at < 30 * 60000) return cache.data;
    const cur = installed(), out = { repo: REPO, current: cur, release: null, main: null };
    try {
      const rel = await gh(`/repos/${REPO}/releases/latest`);
      if (rel && rel.tag_name) out.release = { tag: rel.tag_name, name: rel.name || rel.tag_name, date: rel.published_at, notes: String(rel.body || '').slice(0, 4000), url: rel.html_url,
        newer: cmpVer(rel.tag_name, cur.version) > 0 };
    } catch (e) { out.releaseError = e.message; }
    try {
      const c = await gh(`/repos/${REPO}/commits/main`);
      if (c && /^[0-9a-f]{40}$/.test(c.sha || '')) out.main = { sha: c.sha, date: c.commit && c.commit.committer && c.commit.committer.date,
        message: String((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 200), url: c.html_url, newer: cur.sha ? cur.sha !== c.sha : null };
    } catch (e) { out.mainError = e.message; }
    cache = { at: Date.now(), data: out };
    return out;
  }

  async function download(ref) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 5 * 60000);
    try {
      const r = await f(`${GITHUB_API}/repos/${REPO}/zipball/${encodeURIComponent(ref)}`, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' });
      if (!r.ok) throw new Error('download HTTP ' + r.status);
      if (r.url && !ZIP_HOSTS.includes(new URL(r.url).hostname)) throw new Error('blocked host');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_ZIP) throw new Error('file too large');
      return buf;
    } finally { clearTimeout(timer); }
  }

  // Checks every entry of the zip and returns [{ rel, buffer }]. GitHub zips have one top folder "<owner>-<repo>-<sha>/".
  async function readZip(buf) {
    const zip = await unzipper.Open.buffer(buf);
    const out = [];
    for (const e of zip.files) {
      if (e.type !== 'File') continue;
      const parts = String(e.path).replace(/\\/g, '/').split('/').filter(Boolean);
      parts.shift();
      if (!parts.length || parts.some(x => x === '..' || x === '.' || x.includes(':'))) throw new Error('unexpected entry in archive');
      const rel = parts.join('/');
      if (SKIP.some(re => re.test(rel))) continue;
      out.push({ rel, buffer: await e.buffer() });
    }
    if (!out.some(x => x.rel === 'server.js') || !out.some(x => x.rel === 'package.json')) throw new Error('this is not an MC Panel archive');
    return out;
  }

  async function npmInstall() {
    const npmBin = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const cmd = fs.existsSync(npmBin) ? npmBin : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
    await run(cmd, ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: panelDir, timeout: 10 * 60000, maxBuffer: 8 * 1024 * 1024, shell: process.platform === 'win32' });
  }

  async function apply(channel) {
    const info = await check(true);
    const target = channel === 'main' ? info.main && { ref: info.main.sha, sha: info.main.sha, label: 'main@' + info.main.sha.slice(0, 7) }
      : info.release && { ref: info.release.tag, sha: null, label: info.release.tag };
    if (!target) throw new Error(channel === 'main' ? (info.mainError || 'main not found') : (info.releaseError || 'no release found'));
    state.step = 'download'; log('download', target.label);
    const files = await readZip(await download(target.ref));
    const oldDeps = JSON.stringify((pkg() || {}).dependencies || {});
    const newPkg = JSON.parse(files.find(x => x.rel === 'package.json').buffer.toString('utf8'));

    state.step = 'backup';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(panelDir, '.panel-updates', `backup-${installed().version}-${stamp}`);
    await fsp.mkdir(backupDir, { recursive: true });
    const created = [], replaced = [];
    try {
      for (const x of files) {
        const dest = path.join(panelDir, ...x.rel.split('/'));
        if (!dest.startsWith(path.resolve(panelDir) + path.sep)) throw new Error('unexpected entry in archive');
        if (fs.existsSync(dest)) {
          const keep = path.join(backupDir, ...x.rel.split('/'));
          await fsp.mkdir(path.dirname(keep), { recursive: true });
          await fsp.copyFile(dest, keep); replaced.push(x.rel);
        } else created.push(x.rel);
      }
      state.step = 'files'; log('files', String(files.length));
      for (const x of files) {
        const dest = path.join(panelDir, ...x.rel.split('/'));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest + '.upd-tmp', x.buffer);
        await fsp.rename(dest + '.upd-tmp', dest);
      }
      if (JSON.stringify(newPkg.dependencies || {}) !== oldDeps) { state.step = 'npm'; log('npm', ''); await npmInstall(); }
    } catch (e) {
      // put everything back as it was
      for (const rel of replaced) await fsp.copyFile(path.join(backupDir, ...rel.split('/')), path.join(panelDir, ...rel.split('/'))).catch(() => {});
      for (const rel of created) await fsp.rm(path.join(panelDir, ...rel.split('/')), { force: true }).catch(() => {});
      throw e;
    }
    await fsp.writeFile(stateFile, JSON.stringify({ sha: target.sha, channel, tag: channel === 'main' ? null : target.ref, version: newPkg.version, at: Date.now(), backup: path.basename(backupDir) }));
    // keep the three newest backups
    try {
      const dirs = (await fsp.readdir(path.join(panelDir, '.panel-updates'))).filter(d => d.startsWith('backup-')).sort();
      for (const d of dirs.slice(0, Math.max(0, dirs.length - 3))) await fsp.rm(path.join(panelDir, '.panel-updates', d), { recursive: true, force: true });
    } catch {}
    cache = { at: 0, data: null };
    return { version: newPkg.version, label: target.label, backup: path.basename(backupDir) };
  }

  return {
    installed, check,
    status: () => ({ ...state }),
    // Starts the update in the background. onDone(result) is called when the new files are in place.
    start(channel, onDone) {
      if (state.busy) return { error: 'busy' };
      state = { busy: true, step: 'check', error: '', done: false, restart: false };
      apply(channel === 'main' ? 'main' : 'release')
        .then(r => { state = { busy: false, step: 'done', error: '', done: true, restart: true, result: r }; if (onDone) onDone(r); })
        .catch(e => { state = { busy: false, step: 'failed', error: e.message, done: false, restart: false }; log('failed', e.message); });
      return { ok: true };
    },
  };
}

module.exports = { createSelfUpdate, cmpVer };
