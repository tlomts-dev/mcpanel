'use strict';
// Users, roles and audit log for MC Panel (no dependencies besides bcryptjs).
// Shared by the Arabic and English editions; user-facing strings are injected via `t`.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const totp = require('./totp');

const ROLES = { viewer: 1, mod: 2, admin: 3, owner: 4 };
const USER_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MAX_USERS = 100;
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

// Commands a "mod" may send from the console. Everything else needs admin.
const MOD_COMMANDS = new Set(['say', 'tell', 'msg', 'w', 'tp', 'teleport', 'kick', 'ban', 'ban-ip',
  'pardon', 'pardon-ip', 'list', 'kill', 'gamemode', 'effect', 'give', 'clear', 'time', 'weather', 'title']);

// Minimum role per route. First match wins; unknown /api routes default to admin.
const RULES = [
  [/^\/me(\/|$)/, 1],
  [/^(GET) \/(status|info|ops|bans|whitelist)$/, 1],
  [/^(GET) \/players\/(all|detail)$/, 1],
  [/^(GET) \/backups$/, 1],
  [/^(GET) \/monitor\/history$/, 1],
  [/^(GET) \/monitor\/history$/, 1],
  [/^(POST) \/command$/, 2],
  [/^(POST) \/player\/[a-z-]+$/, 2],
  [/^[A-Z]+ \/(users|audit)(\/|$)/, 4],
];

function levelFor(method, p) {
  const key = method + ' ' + p;
  for (const [re, lvl] of RULES) if (re.test(key) || re.test(p)) return lvl;
  return 3;
}

// Body fields worth recording in the audit log. Secrets and file contents are never logged.
const AUDIT_SKIP = new Set(['password', 'newPassword', 'current', 'content', 'data', 'pass']);

function createAuth({ dir, ownerUser, ownerHash, t }) {
  const usersFile = path.join(dir, '.panel-users.json');
  const auditFile = path.join(dir, '.panel-audit.log');
  let users = {};
  try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')) || {}; } catch { users = {}; }
  if (typeof users !== 'object' || Array.isArray(users)) users = {};
  delete users[ownerUser];

  const saveUsers = () => fs.writeFileSync(usersFile, JSON.stringify(users, null, 1), { mode: 0o600 });
  const DUMMY = bcrypt.hashSync('dummy-password', 12);

  function verify(username, password) {
    const name = String(username || '');
    const isOwner = name === ownerUser;
    const hash = isOwner ? ownerHash : (users[name] && users[name].hash);
    const ok = bcrypt.compareSync(String(password || ''), hash || DUMMY) && !!hash;
    return ok ? { username: name, role: isOwner ? 'owner' : users[name].role } : null;
  }
  const roleOf = name => name === ownerUser ? 'owner' : (users[name] ? users[name].role : null);

  // ── Two-factor (TOTP) ──────────────────────────────────────────────────────
  const tfaFile = path.join(dir, '.panel-2fa.json');
  let tfa = {};
  try { tfa = JSON.parse(fs.readFileSync(tfaFile, 'utf8')) || {}; } catch { tfa = {}; }
  const saveTfa = () => fs.writeFileSync(tfaFile, JSON.stringify(tfa), { mode: 0o600 });
  const pendingTfa = new Map();   // username -> secret awaiting confirmation
  const lastStep = new Map();     // username -> last accepted time step (blocks replay)
  function checkCode(username, code) {
    const secret = tfa[username];
    if (!secret) return true;
    const step = totp.verify(secret, code);
    if (!step || step <= (lastStep.get(username) || 0)) return false;
    lastStep.set(username, step);
    return true;
  }
  const twoFa = {
    enabled: u => !!tfa[u],
    check: checkCode,
    begin(u) { const secret = totp.generateSecret(); pendingTfa.set(u, secret); return { secret, uri: totp.otpauthUri(secret, u) }; },
    confirm(u, code) {
      const secret = pendingTfa.get(u);
      const step = secret && totp.verify(secret, code);
      if (!step) return { error: t.badCode };
      tfa[u] = secret; saveTfa(); pendingTfa.delete(u); lastStep.set(u, step);
      return { ok: true };
    },
    disable(u, password, code) {
      if (!tfa[u]) return { ok: true };
      if (!verify(u, password)) return { error: t.wrongPassword };
      if (!checkCode(u, code)) return { error: t.badCode };
      delete tfa[u]; saveTfa(); return { ok: true };
    },
    reset(u) { if (tfa[u]) { delete tfa[u]; saveTfa(); } },
  };

  function validate(username, password, role, needPassword) {
    if (!USER_RE.test(String(username || ''))) return t.badUser;
    if (username === ownerUser) return t.reservedUser;
    if (role !== undefined && (!ROLES[role] || role === 'owner')) return t.badRole;
    if (needPassword && (typeof password !== 'string' || password.length < 8 || password.length > 128)) return t.badPassword;
    return null;
  }

  let writes = 0;
  function audit(user, ip, action, detail) {
    const line = JSON.stringify({ t: Date.now(), u: user || '-', ip: ip || '-', a: action, d: detail || '' }) + '\n';
    fs.appendFile(auditFile, line, () => {});
    if (++writes % 200 === 0) {
      fs.stat(auditFile, (e, s) => { if (!e && s.size > AUDIT_MAX_BYTES) fs.rename(auditFile, auditFile + '.1', () => {}); });
    }
  }
  function readAudit(limit = 200) {
    let fd;
    try {
      fd = fs.openSync(auditFile, 'r');
      const size = fs.fstatSync(fd).size, len = Math.min(size, 512 * 1024), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      if (size > len) lines.shift(); // first line may be cut in half
      const out = [];
      for (const l of lines.slice(-limit)) { try { out.push(JSON.parse(l)); } catch {} }
      return out.reverse();
    } catch { return []; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }

  function describeBody(body) {
    if (!body || typeof body !== 'object') return '';
    return Object.keys(body).filter(k => !AUDIT_SKIP.has(k)).slice(0, 6)
      .map(k => `${k}=${String(typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]).slice(0, 100)}`).join(' ');
  }

  return {
    ROLES,
    twoFa, verify, roleOf, audit, readAudit, describeBody,
    list: () => [{ username: ownerUser, role: 'owner', owner: true },
      ...Object.keys(users).sort().map(u => ({ username: u, role: users[u].role }))],
    add(username, password, role) {
      const err = validate(username, password, role || 'viewer', true);
      if (err) return { error: err };
      if (users[username]) return { error: t.userExists };
      if (Object.keys(users).length >= MAX_USERS) return { error: t.tooMany };
      users[username] = { hash: bcrypt.hashSync(password, 12), role: role || 'viewer' };
      saveUsers(); return { ok: true };
    },
    update(username, { role, password }) {
      if (!users[username]) return { error: t.userNotFound };
      if (role !== undefined) { const e = validate(username, undefined, role, false); if (e) return { error: e }; users[username].role = role; }
      if (password !== undefined) { const e = validate(username, password, undefined, true); if (e) return { error: e }; users[username].hash = bcrypt.hashSync(password, 12); }
      saveUsers(); return { ok: true };
    },
    remove(username) {
      if (!users[username]) return { error: t.userNotFound };
      delete users[username]; saveUsers(); twoFa.reset(username); return { ok: true };
    },
    changeOwnPassword(username, current, next) {
      if (!users[username]) return { error: t.ownerPwEnv };
      if (!bcrypt.compareSync(String(current || ''), users[username].hash)) return { error: t.wrongPassword };
      const e = validate(username, next, undefined, true); if (e) return { error: e };
      users[username].hash = bcrypt.hashSync(next, 12); saveUsers(); return { ok: true };
    },
    commandAllowed(role, cmd) {
      if (ROLES[role] >= 3) return true;
      return MOD_COMMANDS.has(String(cmd).trim().split(/\s+/)[0].replace(/^\//, '').toLowerCase());
    },
  };
}

module.exports = { createAuth, levelFor, ROLES };
