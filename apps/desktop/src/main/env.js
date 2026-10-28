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

function childEnv(extra = {}) {
  const env = { ...process.env, PATH: searchPath(), ...extra };
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

module.exports = { childEnv, which, capture, searchPath };
