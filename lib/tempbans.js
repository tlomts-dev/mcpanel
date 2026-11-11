'use strict';
// Timed bans: the panel bans now and sends "pardon" when the time is up (also after a panel restart).
const fs = require('fs');
const path = require('path');

function createTempBans({ dir, pardon, isRunning, now }) {
  const file = path.join(dir, '.panel-tempbans.json');
  const clock = now || Date.now;
  let bans = {};   // name -> expiry timestamp (ms)
  try { bans = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { bans = {}; }
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(bans)); } catch {} };

  const api = {
    add(name, minutes) { bans[name] = clock() + minutes * 60000; save(); },
    remove(name) { if (bans[name]) { delete bans[name]; save(); } },
    list: () => ({ ...bans }),
    // Pardons everyone whose time is up. Waits for the server to be running so the command is not lost.
    tick() {
      if (!isRunning()) return 0;
      let n = 0;
      for (const [name, until] of Object.entries(bans)) {
        if (until <= clock()) { pardon(name); delete bans[name]; n++; }
      }
      if (n) save();
      return n;
    },
  };
  const timer = setInterval(api.tick, 30000);
  timer.unref();
  return api;
}

module.exports = { createTempBans };
