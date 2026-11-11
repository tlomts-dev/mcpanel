'use strict';
// Run with: npm test   (Node 18+, no extra dependencies)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');

const { parseCron, cronMatches, createScheduler } = require('../lib/scheduler');
const { createAuth, levelFor, ROLES } = require('../lib/auth');
const { createMonitor, DISCORD_RE } = require('../lib/monitor');
const totp = require('../lib/totp');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcpanel-test-'));

test('cron: matching and validation', () => {
  const m = (e, d) => cronMatches(parseCron(e), new Date(d));
  assert.ok(m('*/30 * * * *', '2026-11-11T10:30:00'));
  assert.ok(!m('*/30 * * * *', '2026-11-11T10:15:00'));
  assert.ok(m('0 4 * * 3', '2026-11-11T04:00:00'));       // Wednesday
  assert.ok(!m('0 4 * * 1', '2026-11-11T04:00:00'));
  assert.ok(m('0 9-17/4 * * *', '2026-11-11T13:00:00'));
  assert.ok(m('0 0 1 * 0', '2026-11-15T00:00:00'));       // day-of-month OR day-of-week
  assert.strictEqual(parseCron('61 * * * *'), null);
  assert.strictEqual(parseCron('* * *'), null);
});

test('scheduler: validation, persistence, run', async () => {
  const dir = tmp(), file = path.join(dir, 's.json'), logs = [], cmds = [];
  const t = { badType: 'type', badCron: 'cron', badArg: 'arg', tooMany: 'many', notFound: 'nf', alreadyRunning: 'busy', skippedBusy: 'sb', skippedStopped: 'ss',
    ranBackup: () => '', ranRestart: () => '', ranGeneric: n => n, failed: () => 'x' };
  const mk = () => createScheduler({ file, sanitizeCommand: c => (/^[\w \-]+$/.test(c) ? c : null), log: l => logs.push(l), t,
    actions: { isRunning: () => true, command: c => cmds.push(c), backup: async () => ({ name: 'b', removed: 0 }), restart: async () => true } });
  const s = mk();
  assert.ok(s.add({ type: 'broadcast', cron: '* * * * *', arg: 'hello world' }).task);
  assert.ok(s.add({ type: 'backup', cron: 'nope' }).error);
  assert.ok(s.add({ type: 'command', cron: '* * * * *', arg: 'say a;rm' }).error);
  const id = s.list()[0].id;
  assert.strictEqual(await s.runNow(id), 'ok');
  assert.deepStrictEqual(cmds, ['say hello world']);
  await new Promise(r => setTimeout(r, 400));             // debounced save
  assert.strictEqual(mk().list().length, 1);               // survives a restart
});

test('auth: users, roles, route levels, command allow-list', () => {
  const dir = tmp();
  const t = new Proxy({}, { get: (_, k) => String(k) });
  const a = createAuth({ dir, ownerUser: 'owner', ownerHash: bcrypt.hashSync('ownerpass', 4), t });
  assert.strictEqual(a.verify('owner', 'ownerpass').role, 'owner');
  assert.strictEqual(a.verify('owner', 'bad'), null);
  assert.strictEqual(a.verify('ghost', 'x'), null);
  assert.ok(a.add('mod1', 'password123', 'mod').ok);
  assert.ok(a.add('mod1', 'password123', 'mod').error);      // duplicate
  assert.ok(a.add('x', 'password123', 'mod').error);         // too short
  assert.ok(a.add('abc', 'short', 'mod').error);             // weak password
  assert.ok(a.add('abc', 'password123', 'owner').error);     // cannot create owners
  assert.ok(a.add('owner', 'password123', 'mod').error);     // reserved
  assert.strictEqual(a.roleOf('mod1'), 'mod');
  assert.ok(a.update('mod1', { role: 'viewer' }).ok);
  assert.strictEqual(a.roleOf('mod1'), 'viewer');
  assert.ok(a.remove('mod1').ok);
  assert.strictEqual(a.roleOf('mod1'), null);
  assert.strictEqual(levelFor('GET', '/status'), 1);
  assert.strictEqual(levelFor('POST', '/command'), 2);
  assert.strictEqual(levelFor('POST', '/start'), 3);
  assert.strictEqual(levelFor('GET', '/users'), 4);
  assert.strictEqual(levelFor('GET', '/something-new'), 3);  // unknown routes default to admin
  assert.ok(a.commandAllowed('mod', 'say hi'));
  assert.ok(!a.commandAllowed('mod', 'stop'));
  assert.ok(!a.commandAllowed('mod', 'execute as @a run op x'));
  assert.ok(a.commandAllowed('admin', 'stop'));
  assert.ok(ROLES.owner > ROLES.admin);
});

test('totp: RFC 6238 vectors and window', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.strictEqual(totp.code(secret, 59000), '287082');
  assert.strictEqual(totp.code(secret, 1111111109000), '081804');
  assert.ok(totp.verify(secret, '287082', 59000));
  assert.ok(totp.verify(secret, '287082', 59000 + 30000));   // one step of drift is accepted
  assert.ok(!totp.verify(secret, '287082', 59000 + 120000));
  assert.ok(!totp.verify(secret, 'abcdef', 59000));
});

test('monitor: history, threshold alerts, cooldown, masking', async () => {
  const dir = tmp(), hits = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { hits.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  // the config file is trusted, so tests may point the webhook at a local server
  fs.writeFileSync(path.join(dir, '.panel-alerts.json'), JSON.stringify({ discord: `http://127.0.0.1:${srv.address().port}/hook`, lowTps: { on: true, below: 15, forMin: 2 }, cooldownMin: 30 }));
  const m = createMonitor({ dir, serverName: 'T', log: () => {} });
  m.sample({ running: true, tps: 10, ram: 500, ramMax: 1000, cpu: 5, players: 1, disk: 20 });
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(hits.length, 0);                        // one bad minute is not enough
  m.sample({ running: true, tps: 10, ram: 500, ramMax: 1000, cpu: 5, players: 1, disk: 20 });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(hits.length, 1);
  assert.match(hits[0].content, /TPS/);
  m.sample({ running: true, tps: 10, ram: 500, ramMax: 1000, cpu: 5, players: 1, disk: 20 });
  await new Promise(r => setTimeout(r, 200));
  assert.strictEqual(hits.length, 1);                        // cooldown suppresses repeats
  assert.strictEqual(m.history().tps.length, 3);
  assert.ok(m.getConfig().discord.includes('…'));            // never returned in full
  assert.ok(m.setConfig({ discord: 'https://evil.example/hook' }).error);   // only Discord hosts
  assert.ok(DISCORD_RE.test('https://discord.com/api/webhooks/123456/abc-DEF_1'));
  assert.ok(!DISCORD_RE.test('http://discord.com/api/webhooks/123456/abc'));
  assert.ok(m.setConfig({ telegramToken: 'bad' }).error);
  srv.close();
});

test('offsite: remote validation and rclone arguments (no shell)', async () => {
  const { createOffsite } = require('../lib/offsite');
  const calls = [];
  const o = createOffsite({ dir: tmp(), exec: async (cmd, args) => { calls.push([cmd, ...args]); return ''; } });
  assert.ok(o.set({ enabled: true, remote: 'bad remote; rm -rf /' }).error);
  assert.ok(o.set({ enabled: true, remote: '$(touch x):path' }).error);
  assert.ok(o.set({ enabled: true, remote: 's3:my-bucket/minecraft backups' }).ok);
  assert.ok(o.enabled());
  await o.upload('/srv/backups/backup-1.zip');
  await o.test();
  assert.deepStrictEqual(calls[0], ['rclone', 'copy', '/srv/backups/backup-1.zip', 's3:my-bucket/minecraft backups']);
  assert.deepStrictEqual(calls[1], ['rclone', 'lsd', 's3:']);
  assert.ok(o.set({ enabled: true, remote: '' }).ok && !o.enabled());   // no remote means disabled
});

test('downloads: hosts, hashes, file names', async () => {
  const { createDownloads } = require('../lib/downloads');
  const crypto = require('crypto');
  const jar = Buffer.from('PK-fake-jar-bytes');
  const sha512 = crypto.createHash('sha512').update(jar).digest('hex');
  const sha256 = crypto.createHash('sha256').update(jar).digest('hex');
  let versionsResp = [{ version_type: 'release', version_number: '1.0', files: [{ primary: true, filename: 'Cool.jar', url: 'https://cdn.modrinth.com/data/x/Cool.jar', hashes: { sha512 } }] }];
  const fake = async url => {
    if (url.includes('/search')) return Response.json({ hits: [{ project_id: 'abc', slug: 'cool', title: 'Cool', description: 'd', downloads: 5 }] });
    if (url.includes('/version?')) return Response.json(versionsResp);
    if (url.includes('/builds/latest')) return Response.json({ id: 7, channel: 'STABLE', downloads: { 'server:default': { url: 'https://fill-data.papermc.io/v1/objects/x/paper.jar', checksums: { sha256 } } } });
    if (url.endsWith('/projects/paper')) return Response.json({ versions: { '1.21': ['1.21.8', '1.21.8-rc1'], '26.3': ['26.3'] } });
    return new Response(jar);
  };
  const d = createDownloads({ fetchImpl: fake });
  const dir = tmp();
  assert.strictEqual((await d.searchPlugins('cool', '1.21.8'))[0].slug, 'cool');
  const r = await d.installPlugin('abc', '1.21.8', dir);
  assert.strictEqual(r.file, 'Cool.jar');
  assert.ok(fs.existsSync(path.join(dir, 'Cool.jar')) && !fs.existsSync(path.join(dir, 'Cool.jar.part')));
  assert.deepStrictEqual(await d.paperVersions(), ['1.21.8', '26.3']);   // pre-releases are filtered out
  assert.strictEqual((await d.downloadPaper('1.21.8', dir)).file, 'paper-1.21.8.jar');
  // a wrong hash must leave nothing behind
  versionsResp = [{ version_type: 'release', version_number: '1', files: [{ primary: true, filename: 'Bad.jar', url: 'https://cdn.modrinth.com/data/x/Bad.jar', hashes: { sha512: 'deadbeef' } }] }];
  await assert.rejects(d.installPlugin('abc', '1.21.8', dir), /checksum/);
  assert.ok(!fs.existsSync(path.join(dir, 'Bad.jar')) && !fs.existsSync(path.join(dir, 'Bad.jar.part')));
  // other hosts and path-like names are refused
  versionsResp = [{ version_type: 'release', version_number: '1', files: [{ primary: true, filename: 'Evil.jar', url: 'https://evil.example/Evil.jar', hashes: {} }] }];
  await assert.rejects(d.installPlugin('abc', '1.21.8', dir), /blocked host/);
  versionsResp = [{ version_type: 'release', version_number: '1', files: [{ primary: true, filename: '../Evil.jar', url: 'https://cdn.modrinth.com/x', hashes: {} }] }];
  await assert.rejects(d.installPlugin('abc', '1.21.8', dir), /bad file name/);
  await assert.rejects(d.installPlugin('../etc', '1.21.8', dir), /bad project/);
  await assert.rejects(d.downloadPaper('1.21; rm', dir), /bad version/);
});

test('tempbans: pardon after expiry, only while the server runs', () => {
  const { createTempBans } = require('../lib/tempbans');
  let t = 1000, running = false; const pardoned = [];
  const b = createTempBans({ dir: tmp(), now: () => t, isRunning: () => running, pardon: n => pardoned.push(n) });
  b.add('Steve', 10);
  t += 11 * 60000;
  assert.strictEqual(b.tick(), 0);                 // server stopped: wait
  running = true;
  assert.strictEqual(b.tick(), 1);
  assert.deepStrictEqual(pardoned, ['Steve']);
  assert.deepStrictEqual(b.list(), {});
  b.add('Alex', 5); b.remove('Alex');              // a later permanent ban/pardon cancels the timer
  t += 99 * 60000;
  assert.strictEqual(b.tick(), 0);
});
