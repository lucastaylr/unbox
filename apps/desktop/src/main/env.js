'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Apps launched from Finder or the Dock get a minimal PATH, so add the usual
// install locations for Node, Homebrew, Claude Code and Codex.
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  path.join(os.homedir(), '.volta', 'bin'),
];

// Variables that would make an agent CLI bill an API account instead of the
// signed-in Claude or ChatGPT plan. Unbox never forwards them.
const API_BILLING_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
];

function searchPath() {
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const merged = [...current];
  for (const dir of EXTRA_PATH_DIRS) {
    if (!merged.includes(dir)) merged.push(dir);
  }
  return merged.join(path.delimiter);
}

const BREW_PREFIXES = ['/opt/homebrew', '/usr/local'];

// The Ghidra folder chosen in setup; it wins over everything else.
let chosenGhidraDir = null;

function setChosenGhidraDir(dir) {
  chosenGhidraDir = dir || null;
}

function isGhidraDir(dir) {
  return Boolean(dir)
    && fs.existsSync(path.join(dir, 'support', 'analyzeHeadless'))
    && fs.existsSync(path.join(dir, 'Ghidra', 'application.properties'));
}

// Accepts the Ghidra folder itself, or a folder holding exactly one Ghidra
// release (people often pick the folder they unzipped into).
function resolveGhidraDir(selected) {
  if (isGhidraDir(selected)) return selected;
  try {
    const nested = fs.readdirSync(selected, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(selected, entry.name))
      .filter(isGhidraDir);
    return nested.length === 1 ? nested[0] : null;
  } catch {
    return null;
  }
}

// Places people commonly keep Ghidra: Homebrew, or an unzipped release in
// the home, Applications, Downloads or tools folder.
function detectGhidraDir() {
  const home = os.homedir();
  const brew = BREW_PREFIXES.map((prefix) => path.join(prefix, 'opt', 'ghidra', 'libexec'));
  const roots = [home, path.join(home, 'Applications'), '/Applications', path.join(home, 'Downloads'), path.join(home, 'tools'), '/opt'];
  for (const dir of brew) if (isGhidraDir(dir)) return dir;
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const matches = entries
      .filter((entry) => entry.isDirectory() && /^ghidra/i.test(entry.name))
      .map((entry) => path.join(root, entry.name))
      .filter(isGhidraDir)
      .sort()
      .reverse(); // ghidra_12.1.4_PUBLIC before ghidra_12.1.3_PUBLIC
    if (matches.length) return matches[0];
  }
  return null;
}

// Which Ghidra Unbox gives REA, and why.
function ghidraLocation() {
  if (chosenGhidraDir) return { dir: chosenGhidraDir, source: 'chosen' };
  if (process.env.GHIDRA_INSTALL_DIR) return { dir: process.env.GHIDRA_INSTALL_DIR, source: 'environment' };
  const detected = detectGhidraDir();
  return detected ? { dir: detected, source: 'detected' } : { dir: null, source: null };
}

// Points REA at Ghidra and, for a Homebrew Ghidra, its JDK. The formula's
// `ghidraRun` is a wrapper script outside the Ghidra tree, so REA's own PATH
// discovery cannot use it. A JAVA_HOME the user set always wins.
function analysisEnv() {
  const env = {};
  const { dir } = ghidraLocation();
  if (dir) env.GHIDRA_INSTALL_DIR = dir;
  const brewGhidra = dir && BREW_PREFIXES.some((prefix) => dir.startsWith(path.join(prefix, 'opt', 'ghidra')));
  if (brewGhidra && !process.env.JAVA_HOME) {
    for (const prefix of BREW_PREFIXES) {
      const home = path.join(prefix, 'opt', 'openjdk@25', 'libexec', 'openjdk.jdk', 'Contents', 'Home');
      if (fs.existsSync(path.join(home, 'bin', 'java'))) {
        env.JAVA_HOME = home;
        break;
      }
    }
  }
  return env;
}

function childEnv(extra = {}) {
  const env = { ...process.env, PATH: searchPath(), ...analysisEnv(), ...extra };
  for (const name of API_BILLING_VARIABLES) delete env[name];
  // Electron sets this for its own Node; children must use the user's Node.
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function which(command) {
  for (const dir of searchPath().split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

// Runs a short command and collects its output. Used for status probes only.
function capture(command, args, { cwd, timeoutMs = 20000, input } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => finish({ code: null, stdout, stderr: String(error.message), timedOut: false }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false }));
    child.stdin.end(input ?? '');
  });
}

module.exports = { childEnv, analysisEnv, which, capture, searchPath, ghidraLocation, resolveGhidraDir, setChosenGhidraDir };
