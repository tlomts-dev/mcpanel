'use strict';
// Users, roles and audit log for MC Panel (no dependencies besides bcryptjs).
// User-facing strings are injected via `t` (see locales/ and lib/i18n.js).
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const totp = require('./totp');

const USER_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MAX_USERS = 100;
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;

// ── Permissions ───────────────────────────────────────────────────────────────
// Every capability of the panel is one permission "<group>.<action>". A user holds an explicit list;
// the roles (viewer, mod, admin) are only shortcuts that fill that list. The owner (the .env account) holds everything.
const PERM_GROUPS = {
  server:   ['view', 'start', 'stop', 'restart', 'world'],
  console:  ['view', 'chat', 'command'],
  players:  ['view', 'kick', 'ban', 'op', 'whitelist', 'manage', 'data'],
  files:    ['view', 'edit', 'delete'],
  backups:  ['view', 'create', 'download', 'restore', 'delete', 'offsite'],
  schedule: ['view', 'manage'],
  plugins:  ['view', 'manage', 'jar'],
  settings: ['view', 'edit', 'alerts'],
  admin:    ['users', 'audit'],
};
const PERMS = [];
for (const [g, acts] of Object.entries(PERM_GROUPS)) for (const a of acts) PERMS.push(g + '.' + a);
const PERM_SET = new Set(PERMS);
const PRESETS = {
  viewer: ['server.view', 'console.view', 'players.view'],
  mod: ['server.view', 'server.world', 'console.view', 'console.chat', 'players.view', 'players.kick', 'players.ban', 'players.manage'],
  admin: PERMS.filter(p => p !== 'admin.users' && p !== 'admin.audit'),
};
const ROLE_NAMES = Object.keys(PRESETS);
// An action is useless without being able to see its page, so holding it implies the "view" of its group.
const IMPLIES = {};
for (const [g, acts] of Object.entries(PERM_GROUPS)) {
  if (!acts.includes('view')) continue;
  for (const a of acts) if (a !== 'view' && !(g === 'console') && !(g === 'plugins' && a === 'jar')) IMPLIES[g + '.' + a] = g + '.view';
}
const cleanPerms = list => {
  const set = new Set((Array.isArray(list) ? list : []).filter(p => PERM_SET.has(p)));
  for (const p of [...set]) if (IMPLIES[p]) set.add(IMPLIES[p]);
  return [...set].sort((a, b) => PERMS.indexOf(a) - PERMS.indexOf(b));
};
function presetFor(perms) {
  const k = cleanPerms(perms).join(',');
  return ROLE_NAMES.find(r => cleanPerms(PRESETS[r]).join(',') === k) || 'custom';
}

// Console commands that belong to a permission. Anything else needs console.command (unrestricted console).
const COMMAND_PERMS = {
  say: 'console.chat', tell: 'console.chat', msg: 'console.chat', w: 'console.chat', title: 'console.chat', list: 'console.chat', me: 'console.chat',
  kick: 'players.kick',
  ban: 'players.ban', 'ban-ip': 'players.ban', pardon: 'players.ban', 'pardon-ip': 'players.ban',
  op: 'players.op', deop: 'players.op',
  whitelist: 'players.whitelist',
  tp: 'players.manage', teleport: 'players.manage', gamemode: 'players.manage', effect: 'players.manage', give: 'players.manage',
  clear: 'players.manage', kill: 'players.manage', xp: 'players.manage', experience: 'players.manage', spawnpoint: 'players.manage',
  time: 'server.world', weather: 'server.world', 'save-all': 'server.world', 'save-on': 'server.world', 'save-off': 'server.world',
  difficulty: 'server.world', gamerule: 'server.world', worldborder: 'server.world', setworldspawn: 'server.world',
};
const commandPerm = cmd => COMMAND_PERMS[String(cmd).trim().split(/\s+/)[0].replace(/^\//, '').toLowerCase()] || null;
const COMMAND_PERM_LIST = [...new Set(Object.values(COMMAND_PERMS)), 'console.command'];

// Permission needed per route (first match wins). null = any signed-in user. '#owner' = owner only.
// '#command' = checked per command inside the handler. Unknown /api routes are owner-only.
const RULES = [
  [/^[A-Z]+ \/me(\/|$)/, null],
  [/^GET \/perms$/, null],
  [/^GET \/(status|info|monitor\/history)$/, 'server.view'],
  [/^POST \/start$/, 'server.start'],
  [/^POST \/stop$/, 'server.stop'],
  [/^POST \/restart$/, 'server.restart'],
  [/^POST \/command$/, '#command'],
  [/^POST \/player\/(tempban|ban|unban)$/, 'players.ban'],
  [/^POST \/player\/(op|deop)$/, 'players.op'],
  [/^POST \/player\/kick$/, 'players.kick'],
  [/^POST \/players\/delete-data$/, 'players.data'],
  [/^GET \/(ops|bans|whitelist|players\/(all|detail))$/, 'players.view'],
  [/^POST \/player\/[a-z-]+$/, 'players.manage'],
  [/^GET \/files(\/read|\/download)?$/, 'files.view'],
  [/^POST \/files\/(write|upload|rename)$/, 'files.edit'],
  [/^POST \/files\/delete$/, 'files.delete'],
  [/^GET \/backups$/, 'backups.view'],
  [/^POST \/backups\/create$/, 'backups.create'],
  [/^GET \/backups\/download$/, 'backups.download'],
  [/^POST \/backups\/restore$/, 'backups.restore'],
  [/^POST \/backups\/delete$/, 'backups.delete'],
  [/^GET \/backups\/destinations$/, null],   // masked list (no secrets): the create-backup and schedule forms need the names
  [/^[A-Z]+ \/backups\/(offsite|destinations)(\/|$)/, 'backups.offsite'],
  [/^GET \/schedule$/, 'schedule.view'],
  [/^POST \/schedule(\/|$)/, 'schedule.manage'],
  [/^GET \/plugins(\/search)?$/, 'plugins.view'],
  [/^POST \/plugins\/(toggle|delete|install)$/, 'plugins.manage'],
  [/^[A-Z]+ \/jars(\/|$)/, 'plugins.jar'],
  [/^GET \/settings\/(properties|startup)$/, 'settings.view'],
  [/^POST \/settings\/(properties|startup)$/, 'settings.edit'],
  [/^[A-Z]+ \/alerts(\/|$)/, 'settings.alerts'],
  [/^[A-Z]+ \/users(\/|$)/, 'admin.users'],
  [/^GET \/audit$/, 'admin.audit'],
];

function permFor(method, p) {
  const key = method + ' ' + p;
  for (const [re, perm] of RULES) if (re.test(key)) return perm;
  return '#owner';
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
    return ok ? { username: name, role: isOwner ? 'owner' : roleOf(name) } : null;
  }
  const permsOf = name => name === ownerUser ? PERMS.slice() : (users[name] ? cleanPerms(users[name].perms || PRESETS[users[name].role] || []) : []);
  const roleOf = name => name === ownerUser ? 'owner' : (users[name] ? presetFor(permsOf(name)) : null);
  const has = (name, perm) => name === ownerUser || (users[name] ? permsOf(name).includes(perm) : false);

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
    if (role !== undefined && !PRESETS[role] && role !== 'custom') return t.badRole;
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

  // Permissions to store: explicit list, or the preset named by `role`.
  function resolvePerms(role, perms) {
    if (Array.isArray(perms)) return cleanPerms(perms);
    return role && PRESETS[role] ? cleanPerms(PRESETS[role]) : null;
  }

  return {
    PERMS, PRESETS,
    twoFa, verify, roleOf, permsOf, has, audit, readAudit, describeBody,
    list: () => [{ username: ownerUser, role: 'owner', perms: PERMS.slice(), owner: true },
      ...Object.keys(users).sort().map(u => ({ username: u, role: roleOf(u), perms: permsOf(u) }))],
    add(username, password, role, perms) {
      const err = validate(username, password, role, true);
      if (err) return { error: err };
      if (users[username]) return { error: t.userExists };
      if (Object.keys(users).length >= MAX_USERS) return { error: t.tooMany };
      const list = resolvePerms(role || 'viewer', perms);
      if (!list) return { error: t.badRole };
      users[username] = { hash: bcrypt.hashSync(password, 12), role: presetFor(list), perms: list };
      saveUsers(); return { ok: true };
    },
    update(username, { role, perms, password }) {
      if (!users[username]) return { error: t.userNotFound };
      if (role !== undefined || perms !== undefined) {
        const e = validate(username, undefined, role, false); if (e) return { error: e };
        const list = resolvePerms(role, perms);
        if (!list) return { error: t.badRole };
        users[username].perms = list; users[username].role = presetFor(list);
      }
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
    commandAllowed(username, cmd) {
      if (has(username, 'console.command')) return true;
      const p = commandPerm(cmd);
      return !!p && has(username, p);
    },
    canUseConsoleInput: username => COMMAND_PERM_LIST.some(p => has(username, p)),
  };
}

module.exports = { createAuth, permFor, PERMS, PERM_GROUPS, PRESETS, COMMAND_PERMS, IMPLIES, presetFor, commandPerm, COMMAND_PERM_LIST };
