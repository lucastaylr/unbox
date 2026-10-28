'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { childEnv, analysisEnv, which, capture } = require('./env');
const { reaCommand } = require('./rea');

// Unbox drives the CLIs the user already has, signed in with their own
// Claude or ChatGPT plan. It never asks for, stores or forwards API keys, and
// childEnv() strips API-key variables so neither CLI falls back to API billing.
const AGENTS = {
  claude: { id: 'claude', name: 'Claude Code', company: 'Anthropic', command: 'claude', plan: 'Claude Pro or Max' },
  codex: { id: 'codex', name: 'Codex', company: 'OpenAI', command: 'codex', plan: 'ChatGPT Plus, Pro or Team' },
};

// Specific Claude models, newest first within each family. Most come from the
// model table built into Claude Code; the 5.5 releases are passed through as
// full IDs, which Claude Code forwards unchanged.
const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', group: 'Fable' },
  { id: 'claude-fable-5', label: 'Fable 5', group: 'Fable' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', group: 'Opus' },
  { id: 'claude-opus-5', label: 'Opus 5', group: 'Opus' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', group: 'Opus' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'Sonnet' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', group: 'Sonnet' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'Sonnet' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', group: 'Haiku' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', group: 'Haiku' },
];

// GPT models the installed Codex knows about. Codex's own cache says which of
// them the signed-in plan offers; the rest are listed separately because the
// plan may not include them.
const GPT_MODELS = [
  'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-pro', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex',
];

const MODEL_ID = /^[\w.:-]{1,80}$/;

// gpt-6.1-sol -> GPT-6.1 Sol, gpt-5.3-codex -> GPT-5.3 Codex
function gptLabel(slug) {
  const [, version, rest] = /^gpt-([\d.]+)-?(.*)$/.exec(slug) || [];
  if (!version) return slug;
  const name = rest.split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
  return `GPT-${version}${name ? ` ${name}` : ''}`;
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// Codex caches the models offered to the signed-in account; the ones marked
// "list" are the ones its own picker shows.
function codexModels() {
  let configured = null;
  try {
    configured = /^model\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8'))?.[1] || null;
  } catch {
    // no config file: Codex uses its built-in default
  }
  let listed = [];
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8'));
    listed = (cache.models || [])
      .filter((model) => model.visibility === 'list' && MODEL_ID.test(model.slug))
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((model) => ({ id: model.slug, description: model.description }));
  } catch {
    // no cache yet: every known model is listed as "other"
  }
  return { configured, listed };
}

function modelsFor(id) {
  if (id === 'claude') {
    return [{ id: '', label: 'Default', description: "Claude Code's default", group: '' }, ...CLAUDE_MODELS];
  }
  const { configured, listed } = codexModels();
  const onPlan = [...listed];
  // The configured default is not listed as "on your plan" unless Codex says
  // so: a ChatGPT plan can reject it (gpt-5.5 was).
  const planIds = new Set(onPlan.map((model) => model.id));
  return [
    { id: '', label: 'Default', description: configured ? `Your Codex default, ${gptLabel(configured)}` : "Codex's default", group: '' },
    ...onPlan.map((model) => ({ ...model, label: gptLabel(model.id), group: 'On your plan' })),
    ...GPT_MODELS.filter((slug) => !planIds.has(slug)).map((slug) => ({ id: slug, label: gptLabel(slug), group: 'Other models' })),
  ];
}

// Any well-formed model ID is accepted so people can try models that are not
// listed yet; the CLI reports an error if the plan does not include it.
function validModel(_id, model) {
  return model === '' || MODEL_ID.test(model);
}

async function agentStatus(id) {
  const agent = AGENTS[id];
  const binary = which(agent.command);
  const base = {
    id,
    name: agent.name,
    company: agent.company,
    plan: agent.plan,
    installed: Boolean(binary),
    ready: false,
    models: modelsFor(id),
  };
  if (!binary) return { ...base, action: 'install', hint: `Install ${agent.name}, then sign in.` };
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
    return { ...base, action: 'signin', hint: 'Sign in with your Claude plan.' };
  }
  if (/api/i.test(auth.authMethod || '')) {
    return { ...base, action: 'signin', hint: 'Using an API key. Sign in with your Claude plan instead.' };
  }
  return { ...base, ready: true, action: 'signin', account: auth.authMethod };
}

async function codexStatus(base) {
  const result = await capture('codex', ['login', 'status']);
  const text = `${result.stdout}\n${result.stderr}`;
  if (/chatgpt/i.test(text)) return { ...base, ready: true, action: 'signin', account: 'ChatGPT' };
  if (/api key/i.test(text)) {
    return { ...base, action: 'signin', hint: 'Using an API key. Sign in with ChatGPT instead.' };
  }
  return { ...base, action: 'signin', hint: 'Sign in with your ChatGPT plan.' };
}

function mcpServer() {
  const rea = reaCommand();
  return { command: rea.command, args: [...rea.args, 'mcp'], env: analysisEnv() };
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

function codexArgs(workspace, lastMessageFile) {
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
    '-c', `mcp_servers.rea.env={${Object.entries(server.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`,
    '-c', 'mcp_servers.rea.startup_timeout_sec=120',
    '-c', 'mcp_servers.rea.tool_timeout_sec=600',
    // `codex exec` never prompts, so unapproved MCP calls are refused.
    // Pre-approve REA's tools only; the shell stays sandboxed.
    '-c', 'mcp_servers.rea.default_tools_approval_mode="approve"',
    // The final message, written by Codex itself, is the answer.
    '-o', lastMessageFile,
    '-',
  ];
}

// Starts an agent run and reports normalized events:
//   { kind: 'status' | 'text' | 'tool' | 'tool_result' | 'error' | 'done', ... }
function runAgent({ id, model, prompt, workspace, targetPaths, onEvent }) {
  const lastMessageFile = path.join(os.tmpdir(), `unbox-${process.pid}-${Date.now()}-last-message.md`);
  const args = id === 'claude' ? claudeArgs(targetPaths) : codexArgs(workspace, lastMessageFile);
  // Right after `-p` / `exec`. An empty model leaves the CLI on its default.
  if (model) args.splice(1, 0, id === 'claude' ? '--model' : '-m', model);
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
  let pendingDone = null;
  const emit = (event) => {
    if (finished) return;
    // Codex may report the turn complete before writing its last message,
    // so its "done" waits for the process to exit.
    if (event.kind === 'done' && id === 'codex' && child.exitCode === null && !event.final) {
      pendingDone = event;
      return;
    }
    if (event.kind === 'done') finished = true;
    onEvent(event);
  };
  const finalAnswer = () => {
    try {
      return fs.readFileSync(lastMessageFile, 'utf8').trim();
    } catch {
      return '';
    } finally {
      fs.rmSync(lastMessageFile, { force: true });
    }
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
    const answer = id === 'codex' ? finalAnswer() : '';
    if (finished) return;
    if (pendingDone) return emit({ ...pendingDone, final: true, answer: pendingDone.ok ? answer : '' });
    if (signal) return emit({ kind: 'done', ok: false, final: true, text: 'Stopped.' });
    emit({ kind: 'done', ok: code === 0, final: true, answer: code === 0 ? answer : '', text: code === 0 ? '' : lastLine(stderrTail) || `Exited with code ${code}.` });
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
      if (part.type === 'tool_use') yield { kind: 'tool', name: toolName(part.name), detail: describeInput(part.input), source: claudeSource(part.name) };
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
      // Claude Code puts its final message in the result event.
      answer: event.is_error ? '' : String(event.result || '').trim(),
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
    if (item.type === 'mcp_tool_call') yield { kind: 'tool', name: item.tool || item.name, detail: describeInput(item.arguments), source: !item.server || item.server === 'rea' ? 'rea' : 'other' };
    if (item.type === 'command_execution') yield { kind: 'tool', name: 'shell', detail: shellCommand(item.command), source: 'shell' };
  } else if (event.type === 'item.completed' && item) {
    if (item.type === 'agent_message' && item.text) yield { kind: 'text', text: item.text };
    if (item.type === 'file_change') yield { kind: 'tool', name: 'write', detail: (item.changes || []).map((c) => path.basename(c.path)).join(', '), source: 'files' };
    if (item.type === 'mcp_tool_call' && item.status === 'failed') {
      yield { kind: 'tool_result', ok: false, text: flatten(item.error?.message || item.result).slice(0, 400) };
    }
    if (item.type === 'error') yield { kind: 'status', text: item.message };
  }
}

function claudeSource(name) {
  if (String(name).startsWith('mcp__rea__')) return 'rea';
  if (name === 'Bash') return 'shell';
  return 'files';
}

// Codex wraps commands as /bin/zsh -lc "..."; show only the inner command.
function shellCommand(command) {
  const text = String(command || '');
  const inner = /^\S*\/(?:ba|z)?sh\s+-l?c\s+([\s\S]*)$/.exec(text)?.[1] ?? text;
  return inner.replace(/^(['"])([\s\S]*)\1$/, '$2').slice(0, 200);
}

function toolName(name) {
  return String(name || '').replace(/^mcp__rea__/, '');
}

// A short, readable label for a tool call: a file name, symbol or query when
// the call has one, otherwise nothing (the tool name says enough).
function describeInput(input) {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return input.slice(0, 120);
    }
  }
  if (!input || typeof input !== 'object') return '';
  for (const key of ['input_path', 'path', 'file_path', 'target', 'binary_path']) {
    if (typeof input[key] === 'string') return path.basename(input[key]);
  }
  for (const key of ['procedure', 'name', 'symbol', 'address', 'query', 'feature', 'pattern']) {
    if (typeof input[key] === 'string' || typeof input[key] === 'number') return String(input[key]).slice(0, 120);
  }
  return '';
}

function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text || '').join(' ');
  return content ? JSON.stringify(content) : '';
}

function lastLine(text) {
  return text.trim().split('\n').filter(Boolean).pop() || '';
}

module.exports = { AGENTS, agentStatus, runAgent, validModel };
