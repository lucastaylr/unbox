'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { childEnv, which, capture, ghidraLocation } = require('./env');

// Published REA release used when this fork has not been built locally.
const REA_PACKAGE = 'rea-agents@6.8.0';
const REQUIRED_NODE = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

// Prefer the fork's own build so local REA changes show up in the app, then
// an installed `rea` (fast to start), then the pinned npm release via npx.
function reaCommand() {
  const forkCli = path.join(repoRoot, 'scripts', 'rea.mjs');
  if (fs.existsSync(path.join(repoRoot, 'dist', 'cli.js')) && fs.existsSync(forkCli)) {
    return { command: 'node', args: [forkCli], source: 'fork' };
  }
  if (which('rea')) return { command: 'rea', args: [], source: 'installed' };
  return { command: 'npx', args: ['-y', REA_PACKAGE], source: 'npx' };
}

function nodeVersionSupported(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version || '');
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major > 26) return true;
  const floor = REQUIRED_NODE[major];
  if (!floor) return false;
  return minor > floor[0] || (minor === floor[0] && patch >= floor[1]);
}

async function reaStatus(workspaceRoot) {
  const nodePath = which('node');
  const nodeVersion = nodePath ? (await capture('node', ['-v'])).stdout.trim() : null;
  const invocation = reaCommand();
  const status = {
    node: { path: nodePath, version: nodeVersion, supported: nodeVersionSupported(nodeVersion) },
    brew: Boolean(which('brew')),
    source: invocation.source,
    version: null,
    ghidra: ghidraLocation(),
    engines: [],
    ready: false,
    hint: null,
  };
  if (!nodePath) {
    status.hint = 'Install Node.js 24 LTS or newer from nodejs.org, then restart Unbox.';
    return status;
  }
  if (!status.node.supported) {
    status.hint = `REA needs Node.js 22.23.4+, 24.22.1+ or 26.12.1+. Found ${nodeVersion}.`;
    return status;
  }
  const doctor = await capture(invocation.command, [...invocation.args, 'doctor', '--json'], {
    cwd: workspaceRoot,
    timeoutMs: 120000,
  });
  const report = parseJson(doctor.stdout);
  if (!report) {
    status.hint = 'REA did not start. Check your network connection for the first download, then retry.';
    return status;
  }
  status.ready = true;
  status.engines = (report.providerInspections || []).map((provider) => {
    // REA's first failed check is the most useful reason to show.
    const failed = (provider.checks || []).find((check) => check.ok === false);
    return {
      id: provider.id,
      available: Boolean(provider.available),
      version: provider.providerVersion || null,
      configured: Boolean(provider.configured),
      problem: failed ? { code: failed.code, detail: failed.detail } : null,
    };
  });
  if (invocation.source !== 'npx') {
    const version = await capture(invocation.command, [...invocation.args, '--version'], { cwd: workspaceRoot });
    status.version = /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] || null;
  }
  return status;
}

// A directory (other than a macOS .app bundle) or an .asar archive is treated
// as a JavaScript/Electron application; everything else gets REA's
// format-neutral artifact inspection.
function routeFor(targetPath) {
  const stat = fs.statSync(targetPath);
  const lower = targetPath.toLowerCase();
  if (lower.endsWith('.asar')) return 'analyze-javascript-application';
  if (stat.isDirectory() && !lower.endsWith('.app')) return 'analyze-javascript-application';
  return 'inspect-artifact';
}

function runRea(args, { cwd, onProgress, signal }) {
  const invocation = reaCommand();
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let stderrTail = '';
    let pending = '';
    const child = spawn(invocation.command, [...invocation.args, ...args], {
      cwd,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
    });
    // REA reports progress as JSON lines on stderr.
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-8000);
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const event = parseJson(line);
        if (event?.rea_progress?.message) onProgress?.(event.rea_progress.message);
      }
    });
    child.on('error', (error) => resolve({ ok: false, error: { message: error.message } }));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return resolve({ ok: false, cancelled: true });
      if (size > MAX_OUTPUT_BYTES) {
        return resolve({ ok: false, error: { message: 'REA output was larger than Unbox can display.' } });
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const json = parseJson(raw) ?? lastJsonObject(stderrTail);
      if (!json) {
        return resolve({ ok: false, error: { message: `REA exited with code ${code}.`, detail: stderrTail.trim() } });
      }
      resolve({ ok: !json.error && code === 0, json, raw });
    });
  });
}

// Scans one target and saves REA's complete Evidence as evidenceFile inside
// the workspace, so the agent can read it later.
async function scan(targetPath, { workspace, evidenceFile = 'scan.json', onProgress, signal }) {
  const route = routeFor(targetPath);
  onProgress?.(route === 'inspect-artifact' ? 'Inspecting file' : 'Reading application sources');
  const result = await runRea([route, targetPath, '--json'], { cwd: workspace, onProgress, signal });
  if (result.cancelled) return { cancelled: true };
  if (result.raw) fs.writeFileSync(path.join(workspace, evidenceFile), result.raw);
  if (!result.json) return { route, error: result.error };
  return { route, file: evidenceFile, ...summarize(route, result.json) };
}

function summarize(route, json) {
  if (json.error || json.code) {
    return {
      error: {
        code: json.code,
        message: json.message || json.error,
        action: json.remediation?.action,
      },
    };
  }
  const result = json.normalized_result || {};
  if (route === 'analyze-javascript-application') return summarizeApplication(json, result);
  return summarizeArtifact(json, result);
}

function count(value, word) {
  return `${value} ${word}${value === 1 ? '' : 's'}`;
}

function joinWithAnd(parts) {
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || '';
}

const FORMAT_NAMES = {
  'mach-o': 'Mach-O binary',
  elf: 'Linux ELF binary',
  pe: 'Windows executable',
  apk: 'Android app',
  zip: 'ZIP archive',
  wasm: 'WebAssembly module',
};

function summarizeApplication(json, result) {
  const summary = result.summary || {};
  const stats = result.statistics || {};
  const graph = result.graph || {};
  const parts = [count(stats.relevant_files ?? 0, 'file')];
  if (summary.browser_windows) parts.push(count(summary.browser_windows, 'window'));
  if (summary.preload_entrypoints) parts.push(count(summary.preload_entrypoints, 'preload script'));
  if (summary.context_bridge_apis) parts.push(count(summary.context_bridge_apis, 'exposed API'));
  if (summary.native_addon_bindings) parts.push(count(summary.native_addon_bindings, 'native add-on'));
  return {
    headline: `JavaScript app with ${joinWithAnd(parts)}`,
    kind: 'JavaScript application',
    format: result.format || json.subject?.format,
    sha256: result.root_artifact_sha256 || json.subject?.digest?.sha256,
    evidenceId: json.evidence_id,
    facts: [
      { label: 'Files read', value: stats.relevant_files },
      { label: 'JavaScript parsed', value: stats.parsed_javascript_files },
      { label: 'Graph nodes', value: graph.nodes?.length },
      { label: 'Relationships', value: graph.edges?.length },
      { label: 'Windows', value: summary.browser_windows },
      { label: 'Preload scripts', value: summary.preload_entrypoints },
      { label: 'Exposed APIs', value: summary.context_bridge_apis },
      { label: 'Native add-ons', value: summary.native_addon_bindings },
    ].filter((fact) => fact.value !== undefined && fact.value !== null),
    nextSteps: [],
    limitations: result.limitations || graph.limitations || [],
  };
}

function summarizeArtifact(json, result) {
  const subject = result.subject || {};
  const observations = result.observations || [];
  const kinds = [...new Set(observations.map((observation) => observation.kind))];
  const format = subject.root_format || json.subject?.format;
  const needsEngine = (result.next_probes || []).some((probe) => probe.operation === 'open_binary');
  const name = FORMAT_NAMES[format] || (format ? `${format} file` : 'File');
  return {
    headline: needsEngine ? `${name}. Reading its code needs a decompiler.` : name,
    kind: 'Artifact',
    format: subject.root_format || json.subject?.format,
    sha256: subject.root_sha256 || json.subject?.digest?.sha256,
    evidenceId: json.evidence_id,
    facts: [
      { label: 'Format', value: subject.root_format },
      { label: 'Observations', value: observations.length },
      { label: 'Observation types', value: kinds.join(', ') || 'none' },
      { label: 'Open questions', value: (result.unexplored_branches || []).length },
    ].filter((fact) => fact.value !== undefined && fact.value !== null),
    nextSteps: (result.next_probes || []).map((probe) => ({
      operation: probe.operation,
      rationale: probe.rationale,
      needs: probe.authority,
    })),
    limitations: result.limitations || [],
  };
}

function parseJson(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lastJsonObject(text) {
  const start = text.lastIndexOf('\n{');
  return parseJson(start >= 0 ? text.slice(start + 1) : text);
}

module.exports = { REA_PACKAGE, reaCommand, reaStatus, scan, routeFor };
