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
const { createAuth, permFor, PERMS, PRESETS } = require('../lib/auth');
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

test('auth: users, presets, custom permissions, routes and commands', () => {
  const dir = tmp();
  const t = new Proxy({}, { get: (_, k) => String(k) });
  const a = createAuth({ dir, ownerUser: 'owner', ownerHash: bcrypt.hashSync('ownerpass', 4), t });
  assert.strictEqual(a.verify('owner', 'ownerpass').role, 'owner');
  assert.strictEqual(a.verify('owner', 'bad'), null);
  assert.strictEqual(a.verify('ghost', 'x'), null);
  assert.ok(a.add('mod1', 'password123', 'mod').ok);
  assert.ok(a.add('mod1', 'password123', 'mod').error);      // duplicate
  assert.ok(a.add('x', 'password123', 'mod').error);         // name too short
  assert.ok(a.add('abc', 'short', 'mod').error);             // weak password
  assert.ok(a.add('abc', 'password123', 'owner').error);     // cannot create owners
  assert.ok(a.add('owner', 'password123', 'mod').error);     // reserved
  assert.strictEqual(a.roleOf('mod1'), 'mod');
  assert.ok(a.has('mod1', 'players.ban') && !a.has('mod1', 'players.op') && !a.has('mod1', 'server.stop'));
  // custom list: unknown permissions are dropped, the label becomes "custom"
  assert.ok(a.update('mod1', { perms: ['server.view', 'players.op', 'nope.x'] }).ok);
  assert.strictEqual(a.roleOf('mod1'), 'custom');
  assert.deepStrictEqual(a.permsOf('mod1'), ['server.view', 'players.view', 'players.op']);   // an action implies the view of its group
  // picking exactly a preset's list gives the preset name back
  assert.ok(a.update('mod1', { perms: PRESETS.viewer }).ok);
  assert.strictEqual(a.roleOf('mod1'), 'viewer');
  assert.ok(a.add('cust', 'password123', undefined, ['files.view', 'backups.view']).ok);
  assert.strictEqual(a.roleOf('cust'), 'custom');
  assert.ok(a.has('owner', 'admin.users') && a.permsOf('owner').length === PERMS.length);
  assert.ok(!a.has('mod1', 'admin.users') && !a.has('nobody', 'server.view'));
  assert.ok(a.remove('mod1').ok);
  assert.strictEqual(a.roleOf('mod1'), null);
  // routes
  assert.strictEqual(permFor('GET', '/status'), 'server.view');
  assert.strictEqual(permFor('POST', '/start'), 'server.start');
  assert.strictEqual(permFor('POST', '/player/op'), 'players.op');   // OP is not a moderator action any more
  assert.strictEqual(permFor('POST', '/player/kick'), 'players.kick');
  assert.strictEqual(permFor('POST', '/files/delete'), 'files.delete');
  assert.strictEqual(permFor('GET', '/users'), 'admin.users');
  assert.strictEqual(permFor('GET', '/me'), null);
  assert.strictEqual(permFor('GET', '/something-new'), '#owner');   // unknown routes: owner only
  // commands
  assert.ok(a.add('mod2', 'password123', 'mod').ok);
  assert.ok(a.commandAllowed('mod2', 'say hi') && a.commandAllowed('mod2', '/ban x'));
  assert.ok(!a.commandAllowed('mod2', 'stop') && !a.commandAllowed('mod2', 'op x') && !a.commandAllowed('mod2', 'execute as @a run op x'));
  assert.ok(a.update('mod2', { perms: ['console.command'] }).ok);
  assert.ok(a.commandAllowed('mod2', 'stop'));
  assert.ok(a.commandAllowed('owner', 'stop'));
  assert.ok(a.canUseConsoleInput('mod2') && !a.canUseConsoleInput('cust'));
});

test('auth: every route in server.js maps to a permission', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const open = new Set(['/api/login', '/api/logout', '/api/lang']);
  const routes = [...src.matchAll(/app\.(get|post)\(\s*['`](\/api\/[^'`$]*)['`]/g)].map(m => [m[1].toUpperCase(), m[2].slice(4)]);
  assert.ok(routes.length > 60);
  for (const [method, p] of routes) {
    if (open.has('/api' + p)) continue;
    assert.notStrictEqual(permFor(method, p), '#owner', `${method} ${p} has no permission rule`);
  }
  for (const act of ['op', 'deop', 'ban', 'kick', 'unban', 'heal', 'feed', 'kill']) assert.notStrictEqual(permFor('POST', '/player/' + act), '#owner', act);
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

test('offsite: destinations, validation, secrets and rclone calls (no shell)', async () => {
  const { createOffsite } = require('../lib/offsite');
  const calls = [], dir = tmp();
  const exec = async (cmd, args, opts = {}) => { calls.push({ cmd, args, env: opts.env, input: opts.input }); return args[0] === 'lsf' ? 'backup-2026-01-01.zip\nbackup-2026-01-02.zip\nbackup-2026-01-03.zip\nnotes.txt\n' : ''; };
  const o = createOffsite({ dir, exec });
  assert.ok(o.save({ type: 'bogus', path: 'x' }).error);
  assert.ok(o.save({ type: 'b2', name: 'B', path: 'bucket/mc', params: { account: 'KEYID' } }).error);          // key missing
  assert.ok(o.save({ type: 'b2', name: 'B', path: 'bad;rm -rf /', params: { account: 'a', key: 'k' } }).error);  // bad path
  assert.ok(o.save({ type: 's3', name: 'S', path: 'b', params: { provider: 'Other', access_key_id: 'a', secret_access_key: 's' } }).error); // endpoint needed
  assert.ok(o.save({ type: 'remote', path: '$(touch x):path' }).error);
  const r = o.save({ type: 'b2', name: 'Backblaze', path: 'mybucket/minecraft', keepRemote: 2, auto: true, params: { account: 'KEYID', key: 'SECRETKEY' } });
  assert.ok(r.ok);
  const listed = o.list()[0];
  assert.ok(listed.hasSecret.key && !JSON.stringify(listed).includes('SECRETKEY'));   // secrets never leave the server
  assert.deepStrictEqual(o.resolve(undefined), [r.id]);                                 // auto destinations
  assert.deepStrictEqual(o.resolve([]), []);                                            // explicit empty = local only
  assert.ok(o.save({ id: r.id, type: 'b2', name: 'Backblaze', path: 'mybucket/minecraft', keepRemote: 2, auto: true, params: { account: 'KEYID2', key: '' } }).ok);   // blank secret keeps the old one
  const up = await o.upload(r.id, '/srv/backups/backup-2026-01-04.zip');
  const copy = calls.find(c => c.args[0] === 'copy');
  assert.deepStrictEqual(copy.args.slice(0, 2), ['copy', '/srv/backups/backup-2026-01-04.zip']);
  assert.ok(/^pd[a-z0-9]+:mybucket\/minecraft$/.test(copy.args[2]));
  const envKeys = Object.keys(copy.env).filter(k => k.startsWith('RCLONE_CONFIG_'));
  assert.ok(envKeys.some(k => k.endsWith('_TYPE') && copy.env[k] === 'b2'));
  assert.ok(envKeys.some(k => k.endsWith('_ACCOUNT') && copy.env[k] === 'KEYID2') && envKeys.some(k => k.endsWith('_KEY') && copy.env[k] === 'SECRETKEY'));
  assert.ok(!copy.args.join(' ').includes('SECRETKEY'));                                // not on the command line
  assert.strictEqual(up.removed, 1);                                                    // 3 backups listed, keep 2: the oldest goes (notes.txt is ignored)
  const dels = calls.filter(c => c.args[0] === 'deletefile').map(c => c.args[1]);
  assert.ok(dels.length === 1 && dels[0].endsWith('/backup-2026-01-01.zip'));
  // password types are obscured through rclone itself (stdin, not argv)
  const s2 = o.save({ type: 'sftp', name: 'NAS', path: '/backups', params: { host: 'nas.local', user: 'u', pass: 'p@ss' } });
  assert.ok(s2.ok);
  await o.test(s2.id);
  const ob = calls.find(c => c.args[0] === 'obscure');
  assert.ok(ob && ob.input === 'p@ss' && !ob.args.join(' ').includes('p@ss'));
  assert.ok(o.remove(s2.id).ok && o.list().length === 1);
  // survives a restart; the old single-remote file format is migrated
  assert.strictEqual(createOffsite({ dir, exec }).list().length, 1);
  const dir2 = tmp(); fs.writeFileSync(path.join(dir2, '.panel-offsite.json'), JSON.stringify({ enabled: true, remote: 's3:bucket/mc' }));
  const old = createOffsite({ dir: dir2, exec }).list();
  assert.ok(old.length === 1 && old[0].type === 'remote' && old[0].auto);
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
  assert.deepStrictEqual(await d.paperVersions(), ['26.3', '1.21.8']);   // pre-releases are filtered out
  assert.strictEqual((await d.downloadPaper('1.21.8', dir)).file, 'paper-1.21.8-7.jar');
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

test('scheduler: friendly schedules compile to cron, one-time tasks run once', async () => {
  const { createScheduler, compileSchedule, nextCron, parseCron } = require('../lib/scheduler');
  assert.deepStrictEqual(compileSchedule({ kind: 'weekly', time: '04:30', days: [5, 1, 1, 3] }), { cron: '30 4 * * 1,3,5' });
  assert.deepStrictEqual(compileSchedule({ kind: 'daily', time: '23:05' }), { cron: '5 23 * * *' });
  assert.deepStrictEqual(compileSchedule({ kind: 'monthly', time: '00:10', dom: 15 }), { cron: '10 0 15 * *' });
  assert.deepStrictEqual(compileSchedule({ kind: 'interval', every: 6, unit: 'hour' }), { cron: '0 */6 * * *' });
  assert.deepStrictEqual(compileSchedule({ kind: 'interval', every: 15, unit: 'min' }), { cron: '*/15 * * * *' });
  for (const bad of [{ kind: 'weekly', time: '04:30', days: [] }, { kind: 'weekly', time: '25:00', days: [1] }, { kind: 'interval', every: 0, unit: 'min' },
    { kind: 'interval', every: 30, unit: 'hour' }, { kind: 'monthly', time: '04:00', dom: 32 }, { kind: 'once', at: 1000 }, { kind: 'cron', cron: 'nope' }, { kind: 'zzz' }, null])
    assert.ok(compileSchedule(bad).error, JSON.stringify(bad));
  const next = nextCron(parseCron('30 4 * * 1'), new Date(2026, 0, 5, 5, 0).getTime());   // Monday 05:00 -> next Monday
  assert.strictEqual(new Date(next).getDay(), 1);
  assert.strictEqual(new Date(next).getDate(), 12);

  const ran = [];
  const tt = new Proxy({}, { get: (_, k) => (k === 'ranGeneric' ? n => n : String(k)) });
  const sch = createScheduler({ file: path.join(tmp(), 's.json'), actions: { isRunning: () => true, command: c => ran.push(c), backup: async () => ({}), restart: async () => true },
    sanitizeCommand: x => String(x || '').trim() || null, log: () => {}, t: tt });
  const r1 = sch.add({ type: 'broadcast', name: 'once', arg: 'hi', sched: { kind: 'once', at: Date.now() + 3600000 }, autoDelete: false });
  assert.ok(r1.task && r1.task.at && !r1.task.cron, JSON.stringify(r1));
  assert.ok(sch.list()[0].nextRun === r1.task.at);
  assert.ok(sch.add({ type: 'broadcast', arg: 'x', sched: { kind: 'once', at: Date.now() - 3600000 } }).error);   // in the past
  const r2 = sch.add({ type: 'command', arg: 'save-all', sched: { kind: 'weekly', time: '04:00', days: [0, 6] } });
  assert.strictEqual(r2.task.cron, '0 4 * * 0,6');
  assert.deepStrictEqual(r2.task.sched, { kind: 'weekly', time: '04:00', days: [0, 6] });
  assert.ok(sch.add({ type: 'command', arg: 'save-all', cron: '*/5 * * * *' }).task);   // old clients that only send cron still work
  assert.strictEqual(await sch.runNow(r2.task.id), 'ok');
  assert.deepStrictEqual(ran, ['save-all']);
});

test('downloads: Hangar search and install (release first, fixed host, checksum)', async () => {
  const { createDownloads } = require('../lib/downloads');
  const crypto = require('crypto');
  const jar = Buffer.from('PK-hangar-jar');
  const sha256 = crypto.createHash('sha256').update(jar).digest('hex');
  let downloadUrl = 'https://hangarcdn.papermc.io/plugins/o/P/versions/1/PAPER/P.jar', hash = sha256, relEmpty = false;
  const urls = [];
  const fake = async url => {
    urls.push(url);
    if (url.includes('/projects?')) return Response.json({ result: [{ name: 'P', namespace: { owner: 'o', slug: 'P' }, description: 'd', stats: { downloads: 9 } }, { name: 'bad', namespace: { slug: 'a/b' } }] });
    if (url.includes('/versions?')) {
      if (url.includes('channel=Release') && relEmpty) return Response.json({ result: [] });
      return Response.json({ result: [{ name: '1.0', downloads: { PAPER: { fileInfo: { name: 'P-1.0.jar', sha256Hash: hash }, downloadUrl } } }] });
    }
    return new Response(jar);
  };
  const d = createDownloads({ fetchImpl: fake }), dir = tmp();
  const hits = await d.searchHangar('p', '1.21.8');
  assert.deepStrictEqual(hits.map(h => h.slug), ['P']);          // names that are not a plain slug are dropped
  assert.ok(urls[0].includes('version=1.21.8'));
  assert.strictEqual((await d.installHangar('P', '1.21.8', dir)).file, 'P-1.0.jar');
  assert.ok(urls.some(u => u.includes('channel=Release')) && fs.existsSync(path.join(dir, 'P-1.0.jar')));
  relEmpty = true;                                                // no release: falls back to any channel
  assert.strictEqual((await d.installHangar('P', '1.21.8', dir)).version, '1.0');
  hash = 'deadbeef';
  await assert.rejects(d.installHangar('P', '1.21.8', dir), /checksum/);
  hash = sha256; downloadUrl = 'https://evil.example/P.jar';
  await assert.rejects(d.installHangar('P', '1.21.8', dir), /blocked host/);
  await assert.rejects(d.installHangar('../x', '1.21.8', dir), /bad project/);
});
