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
  if (raw) throw new Error('DISCORD_BOTS JSON is no longer used. Add BOT_1_TOKEN, BOT_1_CLIENT_ID, BOT_2_TOKEN, BOT_2_CLIENT_ID as separate Railway variables.');
  const token = String(process.env.DISCORD_TOKEN || '').trim();
  const configuredFirstToken = String(process.env.BOT_1_TOKEN || '').trim();
  if (!token && !configuredFirstToken) throw new Error('Add BOT_1_TOKEN for the first bot, or keep using DISCORD_TOKEN for a single bot.');
  const first = {
    id: 'bot1',
    token: token || configuredFirstToken,
    clientId: String(process.env.DISCORD_CLIENT_ID || '').trim() || undefined,
    guildId: process.env.DISCORD_GUILD_ID,
    ownerId: process.env.BOT_OWNER_ID,
    legacy: !process.env.BOT_1_TOKEN,
  };
  const definitions = [];
  const firstToken = configuredFirstToken || first.token;
  const firstClientId = String(process.env.BOT_1_CLIENT_ID || first.clientId || '').trim();
  if (!firstToken) throw new Error('BOT_1_TOKEN is missing.');
  if (firstClientId && !/^\d{17,20}$/.test(firstClientId)) throw new Error('BOT_1_CLIENT_ID must be a valid Discord application ID.');
  definitions.push({ id: 'bot1', token: firstToken, clientId: firstClientId || undefined, guildId: process.env.BOT_1_GUILD_ID || first.guildId, ownerId: process.env.BOT_1_OWNER_ID || first.ownerId, legacy: first.legacy && !configuredFirstToken });

  const secondToken = String(process.env.BOT_2_TOKEN || '').trim();
  if (secondToken) {
    const secondClientId = String(process.env.BOT_2_CLIENT_ID || '').trim();
    if (!/^\d{17,20}$/.test(secondClientId)) throw new Error('BOT_2_CLIENT_ID is required and must be a valid Discord application ID.');
    definitions.push({ id: 'bot2', token: secondToken, clientId: secondClientId, guildId: process.env.BOT_2_GUILD_ID || undefined, ownerId: process.env.BOT_2_OWNER_ID || undefined, legacy: false });
  }
  const thirdToken = String(process.env.BOT_3_TOKEN || '').trim();
  if (thirdToken) {
    const thirdClientId = String(process.env.BOT_3_CLIENT_ID || '').trim();
    if (!/^\d{17,20}$/.test(thirdClientId)) throw new Error('BOT_3_CLIENT_ID is required and must be a valid Discord application ID.');
    definitions.push({ id: 'bot3', token: thirdToken, clientId: thirdClientId, guildId: process.env.BOT_3_GUILD_ID || undefined, ownerId: process.env.BOT_3_OWNER_ID || undefined, legacy: false });
  }
  if (definitions.length > 3) throw new Error('This build supports up to 3 bot accounts.');
  return definitions;
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
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const [id, child] of botProcesses) if (child && child.exitCode !== null) botExited.add(id);
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

const restartTimers = new Map();

function startBot(bot, index, attempt = 0) {
  if (shuttingDown) return;
  const primary = index === 0;
  const env = { ...process.env, DISCORD_TOKEN: bot.token, DISCORD_CLIENT_ID: bot.clientId || '' };
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
  const startedAt = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { cwd: __dirname, env, stdio: 'inherit' });
  botProcesses.set(bot.id, child);
  let restartScheduled = false;
  const scheduleRestart = (reason) => {
    if (restartScheduled) return;
    restartScheduled = true;
    if (shuttingDown) {
      botExited.add(bot.id);
      finishIfStopped();
      return;
    }
    const nextAttempt = Date.now() - startedAt > 60000 ? 0 : attempt + 1;
    const delay = Math.min(60000, 2000 * (2 ** Math.min(nextAttempt, 5)));
    console.error('[Supervisor] Bot "' + bot.id + '" stopped (' + reason + '). Restarting in ' + Math.round(delay / 1000) + 's; other bots will keep running.');
    const timer = setTimeout(() => {
      restartTimers.delete(bot.id);
      startBot(bot, index, nextAttempt);
    }, delay);
    restartTimers.set(bot.id, timer);
    timer.unref?.();
  };
  child.once('error', error => scheduleRestart('process error: ' + (error.message || error)));
  child.once('exit', (code, signal) => {
    if (shuttingDown) {
      botExited.add(bot.id);
      finishIfStopped();
    } else {
      scheduleRestart('exit code ' + code + ', signal ' + signal);
    }
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
