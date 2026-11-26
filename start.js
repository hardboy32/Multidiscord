'use strict';

require('dotenv').config({ quiet: true });

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DATA_ROOT = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/app/data';
const LAVALINK_URL = 'http://127.0.0.1:2333/version';
const CIPHER_HEALTH_URL = 'http://127.0.0.1:8001/metrics';
const LAVALINK_JAR = path.join(__dirname, 'Lavalink.jar');
const CIPHER_BIN = path.join(__dirname, 'yt-cipher');
const STARTUP_TIMEOUT_MS = 180000;

if (!process.env.LAVALINK_PASSWORD) process.env.LAVALINK_PASSWORD = crypto.randomBytes(32).toString('hex');
if (!process.env.YT_CIPHER_PASSWORD) process.env.YT_CIPHER_PASSWORD = crypto.randomBytes(32).toString('hex');

const password = process.env.LAVALINK_PASSWORD;
const cipherPassword = process.env.YT_CIPHER_PASSWORD;
const requestedHeap = String(process.env.LAVALINK_JAVA_XMX || '512m').trim();
const javaHeap = /^\d{2,4}[mMgG]$/.test(requestedHeap) ? requestedHeap : '512m';

let cipherProcess = null;
let javaProcess = null;
const botProcesses = new Map();
const botExited = new Set();
let cipherExited = false;
let javaExited = false;
let shuttingDown = false;
let killTimer = null;

function loadBotDefinitions() {
  const raw = String(process.env.DISCORD_BOTS || '').trim();
  if (!raw) {
    const token = String(process.env.DISCORD_TOKEN || '').trim();
    if (!token) throw new Error('Add DISCORD_TOKEN, or configure multiple bots in DISCORD_BOTS.');
    return [{ id: 'main', token, clientId: process.env.DISCORD_CLIENT_ID, guildId: process.env.DISCORD_GUILD_ID, ownerId: process.env.BOT_OWNER_ID, legacy: true }];
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('DISCORD_BOTS must contain a valid JSON array. See docs/MULTI_BOT_SETUP.md.'); }
  if (!Array.isArray(parsed) || parsed.length < 1) throw new Error('DISCORD_BOTS must be a JSON array with at least one bot.');
  const used = new Set();
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Bot #' + (index + 1) + ' must be an object.');
    const id = String(item.id || '').trim();
    const token = String(item.token || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error('Bot #' + (index + 1) + ' needs an id using only letters, numbers, _ or - (max 32 characters).');
    if (used.has(id)) throw new Error('Duplicate bot id in DISCORD_BOTS: ' + id);
    used.add(id);
    if (!token) throw new Error('Bot "' + id + '" is missing its token.');
    return { id, token, clientId: String(item.clientId || '').trim() || undefined, guildId: String(item.guildId || '').trim() || undefined, ownerId: String(item.ownerId || '').trim() || undefined, legacy: false };
  });
}

const bots = loadBotDefinitions();
if (bots.length > 1) console.log('[Supervisor] Multi-bot mode enabled for ' + bots.length + ' Discord bots. Each bot gets its own Lavalink session and isolated runtime data.');
else console.log('[Supervisor] Single-bot mode enabled.');

function finishIfStopped() {
  if (!shuttingDown) return;
  const allBotsStopped = [...botProcesses.keys()].every(id => botExited.has(id));
  if ((!cipherProcess || cipherExited) && (!javaProcess || javaExited) && allBotsStopped) {
    if (killTimer) clearTimeout(killTimer);
    process.exit(process.exitCode == null ? 0 : process.exitCode);
  }
}

function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exitCode = Number.isInteger(code) ? code : 1;
  if (reason) console.error('[Supervisor] ' + reason);
  for (const child of [...botProcesses.values(), javaProcess, cipherProcess]) {
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
  }
  killTimer = setTimeout(() => {
    for (const child of [...botProcesses.values(), javaProcess, cipherProcess]) {
      if (child && child.exitCode === null) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    }
    process.exit(process.exitCode == null ? 1 : process.exitCode);
  }, 12000);
  killTimer.unref?.();
  finishIfStopped();
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitForService(url, label, headers = {}) {
  const startedAt = Date.now();
  let lastLogAt = 0;
  while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
    if (shuttingDown) throw new Error('Startup cancelled.');
    if ((label === 'YouTube Cipher' && cipherExited) || (label === 'Lavalink' && javaExited)) throw new Error(label + ' process exited before becoming ready.');
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        const detail = label === 'Lavalink' ? (await response.text()).trim() : 'local cipher API responding';
        console.log('[Supervisor] ' + label + ' is ready' + (detail ? ': ' + detail : '.'));
        return;
      }
    } catch (_) {}
    if (Date.now() - lastLogAt > 15000) {
      console.log('[Supervisor] Waiting for ' + label + ' to become ready...');
      lastLogAt = Date.now();
    }
    await wait(1000);
  }
  throw new Error(label + ' did not become ready within ' + Math.round(STARTUP_TIMEOUT_MS / 1000) + ' seconds.');
}

function watchSharedProcess(child, label) {
  child.once('error', error => {
    if (label === 'YouTube Cipher') cipherExited = true;
    else javaExited = true;
    shutdown(1, 'Could not start ' + label + ': ' + (error.message || error));
  });
  child.once('exit', (code, signal) => {
    if (label === 'YouTube Cipher') cipherExited = true;
    else javaExited = true;
    if (!shuttingDown) shutdown(code === 0 ? 1 : (code == null ? 1 : code), label + ' exited unexpectedly (code ' + code + ', signal ' + signal + ').');
    else finishIfStopped();
  });
}

function startBot(bot, index) {
  const primary = index === 0;
  const env = { ...process.env, DISCORD_TOKEN: bot.token };
  if (bot.clientId) env.DISCORD_CLIENT_ID = bot.clientId;
  if (bot.guildId) env.DISCORD_GUILD_ID = bot.guildId;
  if (bot.ownerId) env.BOT_OWNER_ID = bot.ownerId;
  env.BOT_INSTANCE_ID = bot.id;
  env.BOT_PRIMARY = primary ? 'true' : 'false';
  env.DISABLE_DASHBOARD = primary ? 'false' : 'true';
  if (!bot.legacy) {
    const botData = path.join(DATA_ROOT, 'bots', bot.id);
    fs.mkdirSync(botData, { recursive: true });
    env.WARNINGS_FILE = path.join(botData, 'warnings.json');
    env.COMMUNITY_DATA_FILE = path.join(botData, 'community-data.json');
    env.MUSIC_PANEL_STATE_FILE = path.join(botData, 'music-panels.json');
    env.MUSIC_REQUEST_CLEANUP_FILE = path.join(botData, 'music-request-cleanup.json');
  }
  console.log('[Supervisor] Starting Discord bot "' + bot.id + '"' + (primary ? ' (dashboard owner)' : '') + '.');
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { cwd: __dirname, env, stdio: 'inherit' });
  botProcesses.set(bot.id, child);
  child.once('error', error => {
    botExited.add(bot.id);
    shutdown(1, 'Could not start Discord bot "' + bot.id + '": ' + (error.message || error));
  });
  child.once('exit', (code, signal) => {
    botExited.add(bot.id);
    if (!shuttingDown) shutdown(code === 0 ? 0 : (code == null ? 1 : code), 'Discord bot "' + bot.id + '" exited (code ' + code + ', signal ' + signal + '); stopping the shared services.');
    else finishIfStopped();
  });
}

async function main() {
  if (!fs.existsSync(LAVALINK_JAR)) throw new Error('Lavalink.jar is missing. Rebuild the Railway service from the repository Dockerfile.');
  if (!fs.existsSync(CIPHER_BIN)) throw new Error('The bundled YouTube Cipher binary is missing. Rebuild the Railway service from the repository Dockerfile.');
  fs.mkdirSync(path.join(DATA_ROOT, '.java-home'), { recursive: true });

  console.log('[Supervisor] Starting the self-hosted YouTube Cipher in this Railway container.');
  cipherProcess = spawn(CIPHER_BIN, [], {
    cwd: __dirname,
    env: { ...process.env, PORT: '8001', HOST: '127.0.0.1', API_TOKEN: cipherPassword, OVERRIDE_PLAYER_VARIANT: 'IAS' },
    stdio: 'inherit',
  });
  watchSharedProcess(cipherProcess, 'YouTube Cipher');
  await waitForService(CIPHER_HEALTH_URL, 'YouTube Cipher');
  if (shuttingDown) return;

  const javaArgs = ['-Xms128m', '-Xmx' + javaHeap, '-XX:+UseG1GC', '-Duser.home=' + path.join(DATA_ROOT, '.java-home'), '-jar', LAVALINK_JAR];
  console.log('[Supervisor] Starting one shared Lavalink server for ' + bots.length + ' bot session(s).');
  javaProcess = spawn('java', javaArgs, { cwd: __dirname, env: process.env, stdio: 'inherit' });
  watchSharedProcess(javaProcess, 'Lavalink');
  await waitForService(LAVALINK_URL, 'Lavalink', { Authorization: password });
  if (shuttingDown) return;
  bots.forEach(startBot);
}

process.on('SIGTERM', () => shutdown(0, 'Received SIGTERM; stopping all processes.'));
process.on('SIGINT', () => shutdown(0, 'Received SIGINT; stopping all processes.'));
main().catch(error => shutdown(1, error && error.message ? error.message : String(error)));
