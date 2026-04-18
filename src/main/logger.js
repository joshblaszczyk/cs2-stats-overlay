// File-based logger. Mirrors console.log / .warn / .error to a dated log file
// in app.getPath('logs'). Also captures uncaughtException + unhandledRejection
// in the main process. Keeps the last 10 rotations.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_ROTATIONS = 10;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB per file before rotation

let stream = null;
let currentPath = null;
let bytesWritten = 0;
let installed = false;

function logsDir() {
  try {
    const dir = app.getPath('logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

function rotate() {
  try {
    if (stream) { try { stream.end(); } catch {} stream = null; }
    const dir = logsDir();
    if (!dir) return;
    const files = fs.readdirSync(dir)
      .filter(f => /^app-\d{4}-\d{2}-\d{2}(-\d+)?\.log$/.test(f))
      .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(MAX_ROTATIONS - 1)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch {}
}

function openStream() {
  const dir = logsDir();
  if (!dir) return null;
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let p = path.join(dir, `app-${date}.log`);
  // Suffix if the date file already exists and is at rotation size
  try {
    const st = fs.existsSync(p) ? fs.statSync(p) : null;
    if (st && st.size >= MAX_BYTES) {
      let i = 1;
      while (fs.existsSync(path.join(dir, `app-${date}-${i}.log`))) i++;
      p = path.join(dir, `app-${date}-${i}.log`);
    }
  } catch {}
  try {
    currentPath = p;
    bytesWritten = fs.existsSync(p) ? fs.statSync(p).size : 0;
    return fs.createWriteStream(p, { flags: 'a' });
  } catch {
    return null;
  }
}

function writeLine(level, args) {
  if (!stream) return;
  const ts = new Date().toISOString();
  let msg;
  try {
    msg = args.map(a => typeof a === 'string' ? a : safeStringify(a)).join(' ');
  } catch {
    msg = '[log serialization failed]';
  }
  const line = `[${ts}] [${level}] ${msg}\n`;
  try {
    stream.write(line);
    bytesWritten += Buffer.byteLength(line);
    if (bytesWritten >= MAX_BYTES) {
      rotate();
      stream = openStream();
    }
  } catch {}
}

function safeStringify(v) {
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ''}`;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function install() {
  if (installed) return;
  installed = true;
  rotate();
  stream = openStream();

  // Wrap console to also write to file. Keep original behavior (stdout).
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
  };
  console.log = (...a) => { orig.log(...a); writeLine('INFO', a); };
  console.info = (...a) => { orig.info(...a); writeLine('INFO', a); };
  console.warn = (...a) => { orig.warn(...a); writeLine('WARN', a); };
  console.error = (...a) => { orig.error(...a); writeLine('ERROR', a); };

  process.on('uncaughtException', (err) => {
    try { writeLine('FATAL', ['uncaughtException', err]); } catch {}
  });
  process.on('unhandledRejection', (reason) => {
    try { writeLine('FATAL', ['unhandledRejection', reason]); } catch {}
  });

  try {
    const { crashReporter } = require('electron');
    crashReporter.start({
      productName: 'CS2StatsOverlay',
      companyName: 'cs2stats',
      submitURL: '', // no remote upload — keep crashes local
      uploadToServer: false,
      compress: false,
    });
  } catch {}

  console.log(`[Logger] Logs at ${currentPath}`);
}

function logFromRenderer(entry) {
  if (!entry) return;
  const level = (entry.level || 'INFO').toUpperCase();
  const args = Array.isArray(entry.args) ? entry.args : [entry.message || ''];
  writeLine(`R-${level}`, args);
}

module.exports = { install, logFromRenderer, logsDir, currentPath: () => currentPath };
