'use strict';
// Off-site backup destinations through rclone (Backblaze B2, S3 and compatibles, SFTP, FTP, WebDAV, Google Drive,
// Dropbox, Azure Blob, or any remote you already configured with `rclone config`).
// Each destination is stored in .panel-offsite.json. Credentials are handed to rclone through environment
// variables of the child process (never on the command line, never through a shell) and are never sent back to the browser.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

// Fields per destination type. secret = never returned to the browser; obscure = rclone wants it obscured (`rclone obscure`).
// `env` is the rclone option name (upper case). path = "bucket/folder" or "folder" inside the remote.
const TYPES = {
  b2:        { rclone: 'b2', pathRequired: true,  fields: [['account', 'ACCOUNT'], ['key', 'KEY', 'secret']] },
  s3:        { rclone: 's3', pathRequired: true,  fields: [['provider', 'PROVIDER', 'enum'], ['access_key_id', 'ACCESS_KEY_ID'], ['secret_access_key', 'SECRET_ACCESS_KEY', 'secret'], ['region', 'REGION'], ['endpoint', 'ENDPOINT']] },
  sftp:      { rclone: 'sftp', fields: [['host', 'HOST'], ['port', 'PORT'], ['user', 'USER'], ['pass', 'PASS', 'secret obscure']] },
  ftp:       { rclone: 'ftp', fields: [['host', 'HOST'], ['port', 'PORT'], ['user', 'USER'], ['pass', 'PASS', 'secret obscure']] },
  webdav:    { rclone: 'webdav', fields: [['url', 'URL'], ['vendor', 'VENDOR', 'enum'], ['user', 'USER'], ['pass', 'PASS', 'secret obscure']] },
  drive:     { rclone: 'drive', fields: [['token', 'TOKEN', 'secret']], fixed: { SCOPE: 'drive' } },
  dropbox:   { rclone: 'dropbox', fields: [['token', 'TOKEN', 'secret']] },
  azureblob: { rclone: 'azureblob', pathRequired: true, fields: [['account', 'ACCOUNT'], ['key', 'KEY', 'secret']] },
  remote:    { rclone: null, fields: [] },   // an existing rclone remote: "name:folder" goes in `path`
};
const ENUMS = {
  provider: ['AWS', 'Cloudflare', 'Wasabi', 'DigitalOcean', 'Minio', 'Other'],
  vendor: ['nextcloud', 'owncloud', 'sharepoint', 'other'],
};
const REQUIRED = { b2: ['account', 'key'], s3: ['provider', 'access_key_id', 'secret_access_key'], sftp: ['host', 'user'], ftp: ['host', 'user'], webdav: ['url'], drive: ['token'], dropbox: ['token'], azureblob: ['account', 'key'] };

const PATH_RE = /^[\w ./@+()-]{0,200}$/;               // bucket/folder inside a remote
const REMOTE_RE = /^[\w.-]+:[\w ./-]{0,200}$/;        // "myremote:folder" for type "remote"
const FIELD_RE = /^[^\x00-\x1f]{0,3000}$/;            // credentials: anything printable (tokens are long JSON)
const MASK = '••••••••';
const MAX_DESTS = 10;

function createOffsite({ dir, bin, exec }) {
  const file = path.join(dir, '.panel-offsite.json');
  const rclone = bin || process.env.RCLONE_BIN || 'rclone';
  const run = exec || ((cmd, args, opts = {}) => new Promise((resolve, reject) => {
    if (opts.input !== undefined) {
      const c = spawn(cmd, args, { env: opts.env, timeout: opts.timeout });
      let out = '', err = '';
      c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
      c.on('error', e => reject(new Error(e.message)));
      c.on('close', code => code === 0 ? resolve(out) : reject(new Error((err || 'rclone failed').trim().slice(0, 300))));
      c.stdin.end(opts.input);
      return;
    }
    execFile(cmd, args, opts, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).toString().trim().slice(0, 300))) : resolve(stdout));
  }));

  let dests = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw.destinations)) dests = raw.destinations;
    else if (raw && raw.remote) dests = [{ id: 'legacy', name: raw.remote.split(':')[0], type: 'remote', path: raw.remote, enabled: true, auto: !!raw.enabled, keepRemote: 0, params: {} }]; // pre-1.3 format
  } catch {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify({ version: 2, destinations: dests }, null, 1), { mode: 0o600 }); } catch {} };

  const find = id => dests.find(d => d.id === id);
  const remoteName = d => 'pd' + d.id.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const remoteSpec = d => d.type === 'remote' ? d.path : remoteName(d) + ':' + (d.path || '');

  async function envFor(d) {
    const def = TYPES[d.type];
    if (!def.rclone) return process.env;
    const env = { ...process.env }, pre = 'RCLONE_CONFIG_' + remoteName(d).toUpperCase() + '_';
    env[pre + 'TYPE'] = def.rclone;
    for (const [k, v] of Object.entries(def.fixed || {})) env[pre + k] = v;
    for (const [key, envName, flags = ''] of def.fields) {
      let v = d.params[key];
      if (v === undefined || v === '') continue;
      if (flags.includes('obscure')) v = String(await run(rclone, ['obscure', '-'], { input: v, env: process.env, timeout: 15000 })).trim();
      env[pre + envName] = String(v);
    }
    return env;
  }

  function mask(d) {
    const def = TYPES[d.type], params = {}, hasSecret = {};
    for (const [key, , flags = ''] of def.fields) {
      if (flags.includes('secret')) hasSecret[key] = !!d.params[key];
      else if (d.params[key] !== undefined) params[key] = d.params[key];
    }
    return { id: d.id, name: d.name, type: d.type, path: d.path || '', enabled: d.enabled, auto: d.auto, keepRemote: d.keepRemote || 0, params, hasSecret };
  }

  return {
    TYPES: Object.keys(TYPES), ENUMS,
    list: () => dests.map(mask),
    // Destinations a backup should use. ids undefined = those marked "auto"; an array = exactly those that exist and are enabled.
    resolve: ids => dests.filter(d => d.enabled && (Array.isArray(ids) ? ids.includes(d.id) : d.auto)).map(d => d.id),
    save(input) {
      input = input || {};
      const type = String(input.type || '');
      if (!TYPES[type]) return { error: 'type' };
      const old = input.id ? find(String(input.id)) : null;
      if (input.id && !old) return { error: 'notfound' };
      if (!old && dests.length >= MAX_DESTS) return { error: 'limit' };
      if (old && old.type !== type) return { error: 'type' };
      const name = String(input.name || '').trim().slice(0, 40) || type;
      let p = String(input.path || '').trim().replace(/\/+$/, '');
      if (!['sftp', 'ftp', 'webdav', 'remote'].includes(type)) p = p.replace(/^\/+/, '');   // bucket-style paths are never absolute
      if (type === 'remote' ? !REMOTE_RE.test(p) : (!PATH_RE.test(p) || p.split('/').includes('..'))) return { error: 'path' };
      if (TYPES[type].pathRequired && !p) return { error: 'path' };
      const params = {};
      for (const [key, , flags = ''] of TYPES[type].fields) {
        let v = input.params && input.params[key] !== undefined ? String(input.params[key]).trim() : undefined;
        if (flags.includes('secret') && (v === undefined || v === '' || v === MASK)) v = old ? old.params[key] : undefined;   // blank = keep the stored secret
        if (v === undefined) continue;
        if (!FIELD_RE.test(v)) return { error: 'field:' + key };
        if (flags.includes('enum') && v && !(ENUMS[key] || []).includes(v)) return { error: 'field:' + key };
        params[key] = v;
      }
      for (const k of REQUIRED[type] || []) if (!params[k]) return { error: 'field:' + k };
      if (type === 's3' && ['Minio', 'Other'].includes(params.provider) && !params.endpoint) return { error: 'field:endpoint' };
      const keepRemote = Math.max(0, Math.min(1000, parseInt(input.keepRemote, 10) || 0));
      const d = {
        id: old ? old.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name, type, path: p, params, keepRemote,
        enabled: input.enabled !== false, auto: !!input.auto,
      };
      if (old) dests[dests.indexOf(old)] = d; else dests.push(d);
      save();
      return { ok: true, id: d.id };
    },
    remove(id) {
      const i = dests.findIndex(d => d.id === id);
      if (i < 0) return { error: 'notfound' };
      dests.splice(i, 1); save(); return { ok: true };
    },
    name: id => (find(id) || {}).name || id,
    // Copies one local file into the destination folder, then trims old backups there when keepRemote is set.
    async upload(id, localFile) {
      const d = find(id); if (!d) throw new Error('destination not found');
      const env = await envFor(d), spec = remoteSpec(d);
      await run(rclone, ['copy', localFile, spec], { env, timeout: 30 * 60000 });
      let removed = 0;
      if (d.keepRemote > 0) {
        const names = String(await run(rclone, ['lsf', spec, '--files-only'], { env, timeout: 60000 })).split('\n').map(x => x.trim()).filter(x => /^backup-.*\.zip$/.test(x)).sort();
        for (const n of names.slice(0, Math.max(0, names.length - d.keepRemote))) {
          await run(rclone, ['deletefile', spec + (spec.endsWith(':') ? '' : '/') + n], { env, timeout: 60000 }); removed++;
        }
      }
      return { removed };
    },
    // Proves that rclone exists and the destination answers with the given credentials.
    async test(id) {
      const d = find(id); if (!d) throw new Error('destination not found');
      await run(rclone, ['lsf', remoteSpec(d), '--max-depth', '1', '--files-only'], { env: await envFor(d), timeout: 45000 });
    },
  };
}

module.exports = { createOffsite, REMOTE_RE, TYPES, MASK };
