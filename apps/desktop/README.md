# Unbox

Unbox is a desktop app for [REA](https://github.com/morluto/rea). Open an app,
binary, package or JavaScript project, and Unbox scans it with REA and lets an
agent explain it or reconstruct its core logic as readable source.

The agent runs on **your own Claude or ChatGPT plan** through the Claude Code
or Codex CLI you already use. Unbox never asks for, stores or forwards API
keys, and it removes API-key environment variables before starting either CLI,
so runs count against your plan, not an API account.

> Prototype. Expect rough edges.

## How it works

1. **Open.** Choose or drop a file, app bundle or folder.
2. **Scan.** Unbox runs REA's static inspection. Nothing is executed.
   Folders and `.asar` archives use `analyze-javascript-application`;
   everything else uses `inspect-artifact`.
3. **Ask an agent.** Pick Claude Code or Codex and a task:
   *Explain how it works*, *Reconstruct as source* or *Ask a question*. The agent
   uses REA's MCP tools and writes `REPORT.md` (and `reconstruction/` for
   source output) into a workspace folder.

Each target gets a workspace folder in the app's data directory, holding
`scan.json` (full REA Evidence), `PROMPT.md` and the agent's output.

## Install

### 1. Prerequisites

| Requirement | Why | How |
|---|---|---|
| macOS (Linux and Windows untested) | Prototype target | |
| Node.js 22.23.4+, 24.22.1+ or 26.12.1+ | Runs REA and Electron | [nodejs.org](https://nodejs.org/) or `brew install node` |
| Claude Code **or** Codex | The agent that does the analysis | See step 2 |
| Ghidra, Hopper or IDA (optional) | Decompiling native binaries | See [REA's provider setup](../../docs/installation.md#hopper) |

JavaScript/Electron apps and .NET assemblies need no native engine.

### 2. Sign in to an agent with your plan

Install at least one, then sign in with your subscription (not an API key).

**Claude Code** (Claude Pro or Max):

```bash
npm install -g @anthropic-ai/claude-code
```

```bash
claude auth login
```

**Codex** (ChatGPT Plus, Pro or Team):

```bash
npm install -g @openai/codex
```

```bash
codex login
```

Choose **Sign in with ChatGPT** when asked. If Codex later reports `401`,
run `codex logout` and then `codex login` again.

### 3. Run Unbox

From the repository root:

```bash
cd apps/desktop
```

```bash
npm install
```

```bash
npm start
```

The sidebar shows whether Node.js, REA, native engines and each agent are
ready. Use the refresh button after signing in.

On first use, REA is downloaded with `npx` (`rea-agents@6.8.0`). If you build
this fork (`npm install && npm run build` at the repository root), Unbox uses
the fork's own REA instead.

## Safety

- The agent may read the target and REA's results, and it writes only into the
  workspace folder.
- Claude Code runs with shell and web tools turned off. Codex runs in its
  `workspace-write` sandbox.
- Target content is treated as untrusted. The agent is told never to run the
  target or follow instructions found inside it.
- Use Unbox on software you own or are authorized to analyze. REA's
  [disclaimer](../../DISCLAIMER.md) applies: no bypassing licence checks, DRM
  or other protections.

## Plan usage

Unbox starts the official CLI that you installed and signed in to yourself; it
never sees your credentials. Your plan's usage limits and terms still apply,
so review Anthropic's and OpenAI's terms before distributing Unbox to others.

## Project layout

```
apps/desktop/
  src/main/      Electron main process
    main.js      window, IPC and workspace handling
    rea.js       runs REA and summarizes its Evidence
    agents.js    drives Claude Code and Codex headlessly
    prompts.js   task prompts and safety rules
    env.js       PATH and environment handling (strips API keys)
    preload.js   the narrow API exposed to the page
  src/renderer/  the interface (plain HTML, CSS and JavaScript)
```
