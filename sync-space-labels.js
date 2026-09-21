#!/usr/bin/env node
//
// Space Topic -- name each herdr Space after the work happening inside it.
//
// herdr labels a Space after its directory, so five worktrees of one repo all
// read "api-server" in the sidebar and you have to open each to remember what
// it is doing. Agents already publish what they are working on: Claude Code,
// Codex and friends set the terminal title, and herdr exposes it per pane as
// `terminal_title_stripped`. This walks the session, picks the pane that leads
// each Space, and writes that pane's topic onto the Space.
//
// Nothing here is a daemon: herdr runs this script on the events declared in
// herdr-plugin.toml, it does its walk, and exits.
//
//   node sync-space-labels.js              sync every space
//   node sync-space-labels.js --dry-run    print the plan, write nothing
//   node sync-space-labels.js --restore    put the original labels back
//   node sync-space-labels.js --adopt      re-manage the space you are in
//
// Requires: node >= 18, herdr >= 0.9.0. No npm dependencies.

"use strict";

const { spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const SOURCE_ID = "plugin.space-topic"; // our reporter identity for workspace tokens
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || ".";
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || ".";
const STATE_PATH = join(STATE_DIR, "space-topic-state.json");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const RESTORE = argv.includes("--restore");
const ADOPT = argv.includes("--adopt");

// ---------------------------------------------------------------------------
// Config
//
// A deliberately small TOML subset: flat `key = value` pairs, where a value is
// a quoted string, a bare number, a bool, or an array of strings. That is the
// whole config surface, so pulling in a TOML parser would cost a build step
// and an npm tree for nothing.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  enabled: true,
  // "rename" overwrites the Space label. "token" leaves the label alone and
  // publishes the topic as a workspace token you place in a Space sidebar row
  // as `$topic`. "both" does the two.
  mode: "rename",
  token_name: "topic",
  // Which pane speaks for the Space: "first" (reading order) or "active"
  // (the pane herdr has focused inside that Space).
  source: "first",
  // What a Space reads when no agent topic is available:
  // "original" (the label herdr gave it), "branch", "cwd", or "keep".
  fallback: "original",
  // Tokens: {topic} {agent} {original} {branch} {cwd} {number} {status}
  format: "{topic}",
  max_label_length: 40,
  // Once you rename a Space by hand, it is yours -- we stop writing to it.
  respect_manual_names: true,
  // Only manage Spaces that actually host an agent.
  require_agent: true,
  // Workspace ids or exact labels this plugin must never touch.
  skip: [],
};

function parseToml(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (!key) continue;
    if (val.startsWith("[")) {
      out[key] = [...val.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    } else if (/^"(.*)"$|^'(.*)'$/.test(val)) {
      out[key] = val.slice(1, -1);
    } else if (val === "true" || val === "false") {
      out[key] = val === "true";
    } else if (/^-?\d+$/.test(val)) {
      out[key] = Number(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function loadConfig() {
  let user = {};
  try {
    user = parseToml(readFileSync(join(CONFIG_DIR, "config.toml"), "utf8"));
  } catch {
    // No config file is the normal case; every key has a default.
  }
  const cfg = { ...DEFAULTS, ...user };
  if (!["rename", "token", "both"].includes(cfg.mode)) cfg.mode = DEFAULTS.mode;
  if (!["first", "active"].includes(cfg.source)) cfg.source = DEFAULTS.source;
  if (!["original", "branch", "cwd", "keep"].includes(cfg.fallback)) cfg.fallback = DEFAULTS.fallback;
  if (!Array.isArray(cfg.skip)) cfg.skip = [];
  cfg.max_label_length = Math.max(8, Math.min(80, Number(cfg.max_label_length) || DEFAULTS.max_label_length));
  return cfg;
}

// ---------------------------------------------------------------------------
// herdr CLI
// ---------------------------------------------------------------------------

function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error(`cannot run ${HERDR}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`herdr ${args.join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout;
}

function herdrJson(args) {
  const out = herdr(args);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`herdr ${args.join(" ")} did not return JSON: ${out.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// Status glyphs an agent may paint at the head of its terminal title. herdr
// hands us `terminal_title_stripped` with the known ones already removed; this
// catches a raw title, or an agent herdr does not yet strip for.
const STATUS_GLYPHS =
  /^(?:[>›✓-✘⏰-⏸○-◗⚠✢-✿⠀-⣿][︎️]?\s*)+/u;

function normalize(value) {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(STATUS_GLYPHS, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cap(str, max) {
  return str.length > max ? `${str.slice(0, max - 1).trimEnd()}…` : str;
}

// Substitute {token}s. Unknown tokens are left literal so a typo is visible in
// the sidebar rather than silently eaten.
function applyFormat(fmt, tokens) {
  return String(fmt).replace(/\{(\w+)\}/g, (m, k) => (k in tokens ? String(tokens[k] ?? "") : m));
}

function branchOf(cwd) {
  if (!cwd) return "";
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return "";
  const b = (r.stdout || "").trim();
  return b === "HEAD" ? "" : b;
}

function baseName(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

// ---------------------------------------------------------------------------
// State
//
// Per workspace we keep `original` (the label the Space had the first time we
// saw it -- what `--restore` puts back) and `history`, the recent labels we
// wrote. A live label found in that history is ours to overwrite; anything
// else is a name a human typed.
//
// It is a history rather than one string because herdr fires several of our
// events at once, so concurrent copies of this script legitimately disagree
// about the newest label. Histories merge; a single string clobbers, and a
// clobbered entry makes the plugin mistake its own label for a manual rename
// and freeze that Space on a stale topic forever.
// ---------------------------------------------------------------------------

const STATE_VERSION = 1;
const HISTORY_LIMIT = 6;

function emptyState() {
  return { version: STATE_VERSION, spaces: {} };
}

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (!s || s.version !== STATE_VERSION || typeof s.spaces !== "object") return emptyState();
    const spaces = {};
    for (const [id, rec] of Object.entries(s.spaces)) {
      if (!rec || typeof rec !== "object") continue;
      spaces[id] = {
        original: typeof rec.original === "string" ? rec.original : "",
        history: Array.isArray(rec.history) ? rec.history.filter((x) => typeof x === "string") : [],
      };
    }
    return { version: STATE_VERSION, spaces };
  } catch {
    return emptyState();
  }
}

// Re-read from disk and merge, so a concurrent run's labels survive ours.
function saveState(next, liveIds) {
  const disk = loadState();
  const merged = emptyState();
  const ids = new Set([...Object.keys(disk.spaces), ...Object.keys(next.spaces)]);
  for (const id of ids) {
    if (liveIds && !liveIds.has(id)) continue; // prune closed spaces
    const a = next.spaces[id] || { original: "", history: [] };
    const b = disk.spaces[id] || { original: "", history: [] };
    const history = [];
    for (const label of [...a.history, ...b.history]) {
      if (label && !history.includes(label)) history.push(label);
      if (history.length >= HISTORY_LIMIT) break;
    }
    merged.spaces[id] = { original: b.original || a.original || "", history };
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2));
    renameSync(tmp, STATE_PATH); // atomic: a torn read can never be observed
  } catch (err) {
    process.stderr.write(`space-topic: cannot write state: ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Session walk
// ---------------------------------------------------------------------------

function readSession() {
  const workspaces = herdrJson(["workspace", "list"])?.result?.workspaces ?? [];
  const tabs = herdrJson(["tab", "list"])?.result?.tabs ?? [];
  const panes = herdrJson(["pane", "list"])?.result?.panes ?? [];
  return { workspaces, tabs, panes };
}

// The pane that speaks for a Space.
//
//   source = "first"   reading order: lowest tab number, then pane list order
//   source = "active"  the Space's active tab, its focused pane if it has one
//
// Within the candidates we prefer a pane that is both an agent and has a topic
// to show, then any agent, then anything -- so a Space whose lead pane is a
// plain shell still reports the agent working beside it.
function pickPane(ws, tabs, panes, cfg) {
  const order = new Map(tabs.map((t) => [t.tab_id, t.number ?? 0]));
  let candidates = panes.filter((p) => p.workspace_id === ws.workspace_id);
  if (!candidates.length) return null;

  if (cfg.source === "active" && ws.active_tab_id) {
    const inTab = candidates.filter((p) => p.tab_id === ws.active_tab_id);
    if (inTab.length) {
      const focused = inTab.find((p) => p.focused);
      candidates = focused ? [focused, ...inTab.filter((p) => p !== focused)] : inTab;
    }
  } else {
    candidates = candidates
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (order.get(a.p.tab_id) ?? 0) - (order.get(b.p.tab_id) ?? 0) || a.i - b.i)
      .map((x) => x.p);
  }

  const withTopic = candidates.find((p) => p.agent && normalize(p.terminal_title_stripped));
  if (withTopic) return withTopic;
  const withAgent = candidates.find((p) => p.agent);
  if (withAgent) return withAgent;
  return cfg.require_agent ? null : candidates[0];
}

function plan(cfg, session, state) {
  const { workspaces, tabs, panes } = session;
  const items = [];

  for (const ws of workspaces) {
    const id = ws.workspace_id;
    const live = normalize(ws.label);
    const rec = state.spaces[id] || { original: live, history: [] };
    state.spaces[id] = rec;
    if (!rec.original) rec.original = live;

    if (cfg.skip.includes(id) || cfg.skip.includes(ws.label)) {
      items.push({ ws, rec, skip: "configured skip" });
      continue;
    }

    const pane = pickPane(ws, tabs, panes, cfg);
    if (!pane) {
      items.push({ ws, rec, skip: "no agent pane" });
      continue;
    }

    const topic = normalize(pane.terminal_title_stripped);
    const cwd = pane.foreground_cwd || pane.cwd || "";
    // Only shell out to git when something actually asks for the branch.
    const wantsBranch = cfg.fallback === "branch" || String(cfg.format).includes("{branch}");
    const branch = wantsBranch ? branchOf(cwd) : "";

    let body = topic;
    if (!body) {
      if (cfg.fallback === "keep") {
        items.push({ ws, rec, skip: "no topic yet" });
        continue;
      }
      if (cfg.fallback === "branch") body = branch;
      else if (cfg.fallback === "cwd") body = baseName(cwd);
      if (!body) body = rec.original;
    }

    const label = cap(
      normalize(
        applyFormat(cfg.format, {
          topic: body,
          agent: pane.agent || "",
          original: rec.original,
          branch,
          cwd: baseName(cwd),
          number: ws.number ?? "",
          status: pane.agent_status || ws.agent_status || "",
        }),
      ),
      cfg.max_label_length,
    );

    if (!label) {
      items.push({ ws, rec, skip: "empty label" });
      continue;
    }

    // Ownership. A Space we have never written to is adoptable: its live label
    // is still the original one herdr derived from the directory.
    const ours = rec.history.includes(live) || live === rec.original;
    if (cfg.respect_manual_names && !ours) {
      items.push({ ws, rec, label, skip: "renamed by hand" });
      continue;
    }

    items.push({ ws, rec, pane, label, live, changed: label !== live });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function writeLabel(cfg, item) {
  const id = item.ws.workspace_id;
  if (cfg.mode === "rename" || cfg.mode === "both") {
    herdr(["workspace", "rename", id, item.label]);
  }
  if (cfg.mode === "token" || cfg.mode === "both") {
    // Date.now() as the sequence: monotonic across concurrent runs without a
    // shared counter, so herdr drops a slow run's stale report on its own.
    herdr([
      "workspace",
      "report-metadata",
      id,
      "--source",
      SOURCE_ID,
      "--token",
      `${cfg.token_name}=${item.label}`,
      "--seq",
      String(Date.now()),
    ]);
  }
  const hist = item.rec.history;
  if (!hist.includes(item.label)) hist.unshift(item.label);
  item.rec.history = hist.slice(0, HISTORY_LIMIT);
}

function doRestore(cfg, session, state) {
  let n = 0;
  for (const ws of session.workspaces) {
    const rec = state.spaces[ws.workspace_id];
    if (!rec) continue;
    const live = normalize(ws.label);
    if (rec.original && rec.original !== live && (rec.history.includes(live) || !cfg.respect_manual_names)) {
      herdr(["workspace", "rename", ws.workspace_id, rec.original]);
      n += 1;
    }
    // Unconditionally, not just in token mode: someone who switches mode to
    // "rename" and then restores should not be left with a stale token.
    try {
      herdr([
        "workspace",
        "report-metadata",
        ws.workspace_id,
        "--source",
        SOURCE_ID,
        "--clear-token",
        cfg.token_name,
      ]);
    } catch {
      // A Space that never carried our token is not an error.
    }
  }
  try {
    rmSync(STATE_PATH, { force: true });
  } catch {
    // Nothing to forget.
  }
  process.stdout.write(`space-topic: restored ${n} space label(s), state cleared\n`);
}

// Re-own the Space this action was invoked from, by filing its current label
// as one of ours. The next sync then overwrites it.
function doAdopt(session, state) {
  const id = process.env.HERDR_WORKSPACE_ID;
  if (!id) {
    process.stderr.write("space-topic: adopt needs a workspace context\n");
    process.exitCode = 1;
    return;
  }
  const ws = session.workspaces.find((w) => w.workspace_id === id);
  if (!ws) {
    process.stderr.write(`space-topic: no such workspace ${id}\n`);
    process.exitCode = 1;
    return;
  }
  const rec = state.spaces[id] || { original: normalize(ws.label), history: [] };
  state.spaces[id] = rec;
  const live = normalize(ws.label);
  if (live && !rec.history.includes(live)) rec.history.unshift(live);
  rec.history = rec.history.slice(0, HISTORY_LIMIT);
  saveState(state, new Set(session.workspaces.map((w) => w.workspace_id)));
  process.stdout.write(`space-topic: adopted ${id} ("${live}")\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const cfg = loadConfig();
  const state = loadState();
  const session = readSession();
  const liveIds = new Set(session.workspaces.map((w) => w.workspace_id));

  if (ADOPT) return doAdopt(session, state);
  if (RESTORE) return doRestore(cfg, session, state);
  if (!cfg.enabled) return;

  const items = plan(cfg, session, state);

  if (DRY_RUN) {
    for (const it of items) {
      const id = it.ws.workspace_id;
      if (it.skip) process.stdout.write(`${id}  "${it.ws.label}"  --  skipped: ${it.skip}\n`);
      else if (!it.changed) process.stdout.write(`${id}  "${it.ws.label}"  --  already current\n`);
      else process.stdout.write(`${id}  "${it.ws.label}"  ->  "${it.label}"\n`);
    }
    return;
  }

  let wrote = 0;
  for (const it of items) {
    if (it.skip || !it.changed) continue;
    try {
      writeLabel(cfg, it);
      wrote += 1;
    } catch (err) {
      process.stderr.write(`space-topic: ${it.ws.workspace_id}: ${err.message}\n`);
    }
  }

  saveState(state, liveIds);
  if (wrote) process.stdout.write(`space-topic: renamed ${wrote} space(s)\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`space-topic: ${err.message}\n`);
  process.exitCode = 1;
}
