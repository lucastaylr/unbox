'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { childEnv, which, capture } = require('./env');
const { reaCommand } = require('./rea');

// Unbox drives the CLIs the user already has, signed in with their own
// Claude or ChatGPT plan. It never asks for, stores or forwards API keys, and
// childEnv() strips API-key variables so neither CLI falls back to API billing.
const AGENTS = {
  claude: { id: 'claude', name: 'Claude Code', command: 'claude', plan: 'Claude Pro or Max' },
  codex: { id: 'codex', name: 'Codex', command: 'codex', plan: 'ChatGPT Plus, Pro or Team' },
};

async function agentStatus(id) {
  const agent = AGENTS[id];
  const binary = which(agent.command);
  const base = { id, name: agent.name, plan: agent.plan, installed: Boolean(binary), ready: false };
  if (!binary) {
    return {
      ...base,
      hint: id === 'claude'
        ? 'Install Claude Code from claude.com/claude-code, then run: claude auth login'
        : 'Install Codex with: npm install -g @openai/codex, then run: codex login',
    };
  }
  return id === 'claude' ? claudeStatus(base) : codexStatus(base);
}

async function claudeStatus(base) {
  const result = await capture('claude', ['auth', 'status']);
  let auth = null;
  try {
    auth = JSON.parse(result.stdout);
  } catch {
    // older releases print text; treated as unknown below
  }
  if (!auth?.loggedIn) {
    return { ...base, hint: 'Sign in with your Claude plan. In Terminal, run: claude auth login' };
  }
  if (/api/i.test(auth.authMethod || '')) {
    return { ...base, hint: 'Claude Code is using an API key. Run claude auth login and choose your Claude subscription.' };
  }
  return { ...base, ready: true, account: auth.authMethod };
}

async function codexStatus(base) {
  const result = await capture('codex', ['login', 'status']);
  const text = `${result.stdout}\n${result.stderr}`;
  if (/chatgpt/i.test(text)) {
    return { ...base, ready: true, account: 'ChatGPT', hint: 'If a run reports 401, run codex logout and codex login.' };
  }
  if (/api key/i.test(text)) {
    return { ...base, hint: 'Codex is using an API key. Run codex logout, then codex login and choose Sign in with ChatGPT.' };
  }
  return { ...base, hint: 'Sign in with your ChatGPT plan. In Terminal, run: codex login' };
}

function mcpServer() {
  const rea = reaCommand();
  return { command: rea.command, args: [...rea.args, 'mcp'] };
}

function claudeArgs(targetPaths) {
  const config = { mcpServers: { rea: mcpServer() } };
  const targetDirs = [...new Set(targetPaths.map((targetPath) =>
    fs.statSync(targetPath).isDirectory() ? targetPath : path.dirname(targetPath)))];
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(config),
    '--permission-mode', 'acceptEdits',
    ...targetDirs.flatMap((dir) => ['--add-dir', dir]),
    // No shell or web access: the agent reads through REA and writes only
    // into its workspace.
    '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch',
    '--allowedTools', 'mcp__rea__*', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  ];
}

function codexArgs(workspace) {
  const server = mcpServer();
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '-C', workspace,
    '-s', 'workspace-write',
    '-c', 'forced_login_method="chatgpt"',
    '-c', `mcp_servers.rea.command=${JSON.stringify(server.command)}`,
    '-c', `mcp_servers.rea.args=${JSON.stringify(server.args)}`,
    '-c', 'mcp_servers.rea.startup_timeout_sec=120',
    '-c', 'mcp_servers.rea.tool_timeout_sec=600',
    '-',
  ];
}

// Starts an agent run and reports normalized events:
//   { kind: 'status' | 'text' | 'tool' | 'tool_result' | 'error' | 'done', ... }
function runAgent({ id, prompt, workspace, targetPaths, onEvent }) {
  const args = id === 'claude' ? claudeArgs(targetPaths) : codexArgs(workspace);
  const env = childEnv(id === 'claude' ? { MCP_TOOL_TIMEOUT: '600000', MCP_TIMEOUT: '120000' } : {});
  const child = spawn(AGENTS[id].command, args, {
    cwd: workspace,
    env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const parse = id === 'claude' ? claudeEvents : codexEvents;
  let pending = '';
  let finished = false;
  let stderrTail = '';
  const emit = (event) => {
    if (event.kind === 'done') finished = true;
    onEvent(event);
  };

  child.stdout.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      for (const normalized of parse(event)) emit(normalized);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });
  child.on('error', (error) => emit({ kind: 'done', ok: false, text: error.message }));
  child.on('close', (code, signal) => {
    if (finished) return;
    if (signal) return emit({ kind: 'done', ok: false, text: 'Stopped.' });
    emit({ kind: 'done', ok: code === 0, text: code === 0 ? '' : lastLine(stderrTail) || `Exited with code ${code}.` });
  });
  child.stdin.end(prompt);

  return {
    stop() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    },
  };
}

function* claudeEvents(event) {
  if (event.type === 'system' && event.subtype === 'init') {
    const rea = (event.mcp_servers || []).find((server) => server.name === 'rea');
    yield { kind: 'status', text: `Claude Code started${event.model ? ` · ${event.model}` : ''}` };
    if (rea && rea.status !== 'connected') yield { kind: 'error', text: `REA tools are ${rea.status}.` };
    return;
  }
  if (event.type === 'assistant') {
    for (const part of event.message?.content || []) {
      if (part.type === 'text' && part.text.trim()) yield { kind: 'text', text: part.text };
      if (part.type === 'tool_use') yield { kind: 'tool', name: toolName(part.name), detail: describeInput(part.input) };
    }
    return;
  }
  if (event.type === 'user') {
    for (const part of event.message?.content || []) {
      if (part.type === 'tool_result' && part.is_error) {
        yield { kind: 'tool_result', ok: false, text: flatten(part.content).slice(0, 400) };
      }
    }
    return;
  }
  if (event.type === 'result') {
    const message = event.is_error ? String(event.result || event.subtype) : '';
    yield {
      kind: 'done',
      ok: !event.is_error,
      text: /authenticat|oauth|log ?in/i.test(message)
        ? 'Your Claude sign-in has expired. In Terminal, run claude auth login.'
        : message,
      turns: event.num_turns,
      durationMs: event.duration_ms,
    };
  }
}

function* codexEvents(event) {
  const item = event.item;
  if (event.type === 'thread.started') {
    yield { kind: 'status', text: 'Codex started' };
  } else if (event.type === 'error') {
    yield { kind: 'status', text: event.message };
  } else if (event.type === 'turn.failed') {
    const message = event.error?.message || 'Codex run failed.';
    yield {
      kind: 'done',
      ok: false,
      text: /\b401\b|unauthorized/i.test(message)
        ? 'Your Codex sign-in has expired. In Terminal, run codex logout and then codex login.'
        : message,
    };
  } else if (event.type === 'turn.completed') {
    yield { kind: 'done', ok: true, text: '' };
  } else if (event.type === 'item.started' && item) {
    if (item.type === 'mcp_tool_call') yield { kind: 'tool', name: item.tool || item.name, detail: describeInput(item.arguments) };
    if (item.type === 'command_execution') yield { kind: 'tool', name: 'shell', detail: item.command };
  } else if (event.type === 'item.completed' && item) {
    if (item.type === 'agent_message' && item.text) yield { kind: 'text', text: item.text };
    if (item.type === 'file_change') yield { kind: 'tool', name: 'write', detail: (item.changes || []).map((c) => c.path).join(', ') };
    if (item.type === 'mcp_tool_call' && item.status === 'failed') {
      yield { kind: 'tool_result', ok: false, text: flatten(item.error?.message || item.result).slice(0, 400) };
    }
    if (item.type === 'error') yield { kind: 'status', text: item.message };
  }
}

function toolName(name) {
  return String(name || '').replace(/^mcp__rea__/, '');
}

function describeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const preferred = input.input_path || input.path || input.file_path || input.procedure || input.address || input.query;
  if (preferred) return String(preferred);
  const text = JSON.stringify(input);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text || '').join(' ');
  return content ? JSON.stringify(content) : '';
}

function lastLine(text) {
  return text.trim().split('\n').filter(Boolean).pop() || '';
}

module.exports = { AGENTS, agentStatus, runAgent };
