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

1. **Connect.** The setup window opens on first launch, and whenever something
   required is missing. It covers the agents (Claude Code, Codex) and the tools
   (Node.js, REA, Ghidra). **Sign in** and **Install** open Terminal with the
   right command, or the download page when Homebrew is missing; Unbox checks
   again when you come back. Close it any time and reopen it from **Setup** in
   the sidebar.
2. **Start a project.** Name it, then add files or folders with **+** or by
   dropping them on the window.
3. **Ask.** Type a request in the composer. The model button switches agent
   and model. Claude Code lists specific versions (Fable 5.1, Opus 5.5, Sonnet
   5.5, Haiku 5.5 and earlier). Codex lists the models your ChatGPT plan offers
   first, then other GPT models it knows. Either accepts a custom model ID.
   Before the agent starts, REA scans anything new without running it.
   Folders and `.asar` archives use `analyze-javascript-application`;
   everything else uses `inspect-artifact`. The agent then digs deeper with
   REA's MCP tools and answers in the thread.

Each project is a folder in the app's data directory (**Open folder** shows it)
holding `project.json`, each scan's full REA Evidence, the last prompt sent
and anything the agent writes, such as `REPORT.md` or `reconstruction/`.

## Install

### 1. Prerequisites

| Requirement | Why | How |
|---|---|---|
| macOS (Linux and Windows untested) | Prototype target | |
| Node.js 22.23.4+, 24.22.1+ or 26.12.1+ | Runs REA and Electron | [nodejs.org](https://nodejs.org/) or `brew install node` |
| Claude Code **or** Codex | The agent that does the analysis | See step 2 |
| Ghidra 12.1.x (optional) | Decompiling native binaries | **Download** or **Choose folder** in setup |

JavaScript/Electron apps and .NET assemblies need no native engine.

**Ghidra.** Unbox finds Ghidra automatically in Homebrew, your home folder,
Applications, Downloads or `~/tools`. To use a specific copy, open setup and
choose **Choose folder** (or **Change folder**) on the Ghidra tile, then pick
the folder that contains `ghidraRun`; picking the folder you unzipped into
also works. **Reset** goes back to automatic detection. Unbox passes the folder
to REA as `GHIDRA_INSTALL_DIR`, and the tile shows REA's reason if it cannot
use it.

The published `rea-agents@6.8.0` accepts **Ghidra 12.1.x only** (verified with
12.1.4), so **Download** opens the 12.1.4 release. This fork's REA source also
accepts newer 12.x releases such as 12.2; build the fork to use them.

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

You can also sign in from Unbox itself: the setup window's **Sign in** buttons
run these commands in Terminal for you.

On first use, REA is downloaded with `npx` (`rea-agents@6.8.0`). If you build
this fork (`npm install && npm run build` at the repository root), Unbox uses
the fork's own REA instead.

## Safety

- The agent may read the target and REA's results, and it writes only into the
  workspace folder.
- Claude Code runs with shell and web tools turned off. Codex runs in its
  `workspace-write` sandbox, with only REA's MCP tools pre-approved
  (`codex exec` cannot ask for approval, so unapproved tools would be refused).
- Target content is treated as untrusted. The agent is told never to run the
  target or follow instructions found inside it.
- Use Unbox on software you own or are authorized to analyze. REA's
  [disclaimer](../../DISCLAIMER.md) applies: no bypassing licence checks, DRM
  or other protections.

## Plan usage

Unbox starts the official CLI that you installed and signed in to yourself; it
never sees your credentials. Your plan's usage limits and terms still apply,
so review Anthropic's and OpenAI's terms before distributing Unbox to others.

## Brand marks and fonts

The Claude, Anthropic, OpenAI and Node.js logos come from
[Simple Icons](https://simpleicons.org/) (CC0) and identify the products
Unbox connects to; they remain trademarks of their owners. The OpenAI mark is
taken from Simple Icons 15.0.0, because later releases no longer include it.
Check each company's brand guidelines before distributing Unbox.
Instrument Sans is bundled under the SIL Open Font License
(`src/renderer/fonts/InstrumentSans-OFL.txt`).

## Project layout

```
apps/desktop/
  src/main/      Electron main process
    main.js      window, IPC and run orchestration
    projects.js  project storage
    rea.js       runs REA and summarizes its Evidence
    agents.js    drives Claude Code and Codex headlessly
    prompts.js   task prompts and safety rules
    env.js       PATH and environment handling (strips API keys)
    preload.js   the narrow API exposed to the page
  src/renderer/  the interface (plain HTML, CSS and JavaScript)
    brands.js    logo paths for the setup window and model picker
```
