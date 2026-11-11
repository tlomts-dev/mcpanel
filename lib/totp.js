'use strict';
// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with no dependencies. Works with Google Authenticator, Authy, 1Password...
const crypto = require('crypto');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/[\s=-]/g, '')) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function code(secret, nowMs = Date.now()) {
  let counter = Math.floor(nowMs / 30000);
  const msg = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { msg[i] = counter & 255; counter = Math.floor(counter / 256); }
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

// Accepts the previous, current and next step to tolerate clock drift.
// Returns the matching time step (so callers can reject replays) or false.
function verify(secret, given, nowMs = Date.now()) {
  const g = String(given || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(g)) return false;
  let match = false;
  for (const d of [-1, 0, 1]) {
    const t = nowMs + d * 30000;
    if (crypto.timingSafeEqual(Buffer.from(code(secret, t)), Buffer.from(g))) match = Math.floor(t / 30000);
  }
  return match;
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));
const otpauthUri = (secret, account, issuer = 'MC Panel') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

module.exports = { base32Encode, base32Decode, code, verify, generateSecret, otpauthUri };
