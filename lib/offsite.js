'use strict';
// Off-site backup copies through rclone (S3, SFTP, Google Drive, Backblaze, Wasabi, ... anything rclone supports).
// Configure the remote once with `rclone config` on the machine, then enter "remote:path" in the panel.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// "myremote:folder/sub" - letters, digits, dot, dash, underscore, slash and spaces only; no shell is ever involved.
const REMOTE_RE = /^[\w.-]+:[\w ./-]{0,200}$/;

function createOffsite({ dir, bin, exec }) {
  const file = path.join(dir, '.panel-offsite.json');
  const run = exec || ((cmd, args, opts) => new Promise((resolve, reject) =>
    execFile(cmd, args, opts, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).toString().trim().slice(0, 300))) : resolve(stdout))));
  const rclone = bin || process.env.RCLONE_BIN || 'rclone';
  let cfg = { enabled: false, remote: '' };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}

  return {
    get: () => ({ ...cfg }),
    set(input) {
      const remote = String((input || {}).remote || '').trim();
      if (remote && !REMOTE_RE.test(remote)) return { error: 'remote' };
      cfg = { enabled: !!(input || {}).enabled && !!remote, remote };
      try { fs.writeFileSync(file, JSON.stringify(cfg, null, 1)); } catch {}
      return { ok: true };
    },
    enabled: () => cfg.enabled && !!cfg.remote,
    // Copies one local file into the configured remote folder.
    upload: localFile => run(rclone, ['copy', localFile, cfg.remote], { timeout: 30 * 60000 }),
    // Lists the remote to prove that rclone exists and the remote is reachable.
    test: () => run(rclone, ['lsd', cfg.remote.split(':')[0] + ':'], { timeout: 30000 }),
  };
}

module.exports = { createOffsite, REMOTE_RE };
