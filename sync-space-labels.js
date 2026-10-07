#!/usr/bin/env node
//
// Space Topic -- name each herdr Space after the work happening inside it.
//
// herdr labels a Space after its directory, so five worktrees of one repo all
// read "api-server" in the sidebar and you have to open each to remember what
// it is doing. Agents already publish what they are working on: Claude Code,
// Codex and friends set the terminal title, and herdr exposes it per pane as
// `terminal_title_stripped`. This walks the session, picks the pane that leads
// each Space, and writes that pane's topic onto the Space. When the branch it
// has checked out has an open pull request, the Space is named after the PR.
//
// Nothing here is a daemon: herdr runs this script on the events declared in
// herdr-plugin.toml, it does its walk, and exits.
//
//   node sync-space-labels.js              sync every space
//   node sync-space-labels.js --dry-run    print the plan, write nothing
//   node sync-space-labels.js --restore    put the original labels back
//   node sync-space-labels.js --adopt      re-manage the space you are in
//
// Requires: node >= 18, herdr >= 0.9.0. No npm dependencies. PR names need the
// GitHub CLI (`gh`), logged in; without it Spaces simply keep their topics.

"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } = fs;
const { homedir } = require("node:os");
const { join } = require("node:path");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const SOURCE_ID = "plugin.space-topic"; // our reporter identity for workspace tokens
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || ".";
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || ".";
const STATE_PATH = join(STATE_DIR, "space-topic-state.json");
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const PR_CACHE_PATH = join(STATE_DIR, "space-topic-prs.json");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const RESTORE = argv.includes("--restore");
const ADOPT = argv.includes("--adopt");
// Switching to a Space re-checks its pull request and CI on the spot.
const FOCUS_EVENT = process.env.HERDR_PLUGIN_EVENT === "workspace.focused";

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
  // Used instead of `format` when the lead pane's branch has an open pull
  // request. Takes the same tokens plus {pr}, {pr_title} and {ci} (a mark for
  // the PR's checks, or for merge conflicts). "" turns PR lookups off.
  pr_format: "{ci} PR#{pr}: {pr_title}",
  max_label_length: 40,
  // Once you rename a Space by hand, it is yours -- we stop writing to it.
  respect_manual_names: true,
  // Only manage Spaces that actually host an agent.
  require_agent: true,
  // Workspace ids or exact labels this plugin must never touch.
  skip: [],
};

// Drop a trailing `# comment`, but not a `#` inside a quoted value:
// `pr_format = "PR #{pr}"` is a format, not a comment.
function stripComment(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseToml(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
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
  if (typeof cfg.pr_format !== "string") cfg.pr_format = "";
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

// The checkout `cwd` is in: its root, and its branch ("" when detached or not
// a repo). The root keys the PR cache, so panes in subdirectories of one
// worktree share a lookup.
//
// HEAD is detached for the length of a rebase -- which is exactly when an
// agent is fixing a PR's merge conflicts -- but git still records the branch
// being rebased, so we report that one, flagged `rebasing`.
function gitHead(cwd) {
  const none = { root: "", branch: "", rebasing: false };
  if (!cwd) return none;
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return none;
  const [root = "", gitDir = "", b = ""] = (r.stdout || "").trim().split(/\r?\n/);
  if (b !== "HEAD") return { root, branch: b, rebasing: false };
  for (const f of ["rebase-merge/head-name", "rebase-apply/head-name"]) {
    try {
      const ref = readFileSync(join(gitDir, f), "utf8").trim();
      if (ref.startsWith("refs/heads/")) return { root, branch: ref.slice("refs/heads/".length), rebasing: true };
    } catch {
      // Not this kind of rebase, or none at all.
    }
  }
  return { ...none, root };
}

// Where a Claude Code agent is really working. Claude Code moves a session
// into a worktree (`claude --worktree`, or its EnterWorktree tool) without
// changing its process's directory, so herdr keeps reporting the directory it
// was launched from -- usually the main checkout, on main, which has no PR.
// The session transcript records the truth: every entry carries the
// session's cwd. herdr hands us the session id; the newest entry with a cwd
// wins. "" when that cannot be read, and the caller falls back to herdr's.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

function claudeCwd(pane) {
  const id = pane.agent === "claude" ? pane.agent_session?.value : "";
  if (!id || !/^[\w-]+$/.test(id)) return "";
  const projects = join(CLAUDE_DIR, "projects");
  let file = "";
  try {
    // Transcripts are filed under the directory the session is in, which is
    // exactly what we do not know yet -- so look the id up across all of them.
    for (const dir of fs.readdirSync(projects)) {
      const f = join(projects, dir, `${id}.jsonl`);
      if (fs.existsSync(f)) {
        file = f;
        break;
      }
    }
  } catch {
    return "";
  }
  if (!file) return "";

  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (len < size) lines.shift(); // we started mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"cwd"')) continue;
      try {
        const cwd = JSON.parse(lines[i]).cwd;
        // A worktree removed since is no place to look for a branch.
        if (typeof cwd === "string" && cwd && fs.existsSync(cwd)) return cwd;
      } catch {
        // A line still being written; try the one before.
      }
    }
  } catch {
    // Unreadable transcript: fall back to herdr's view.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return "";
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
// Pull requests
//
// A lookup is a GitHub round trip (most of a second), and this script runs on
// nearly every focus change, often as several copies at once. So answers are
// cached per checkout and branch -- Spaces sharing a checkout share one
// lookup -- and a run claims a stale entry, stamping it fresh while keeping
// the old answer, before it asks GitHub. A concurrent run that finds the
// claim reuses the old answer and moves on instead of asking again.
//
// How long an answer lasts depends on what it was. A branch with no PR yet,
// a PR whose checks are still running, or one GitHub has not finished
// checking for conflicts is about to change, so it is asked again after
// PR_TTL_MS. A settled PR is asked again after PR_SETTLED_TTL_MS, or as soon
// as you switch to its Space.
// ---------------------------------------------------------------------------

const PR_TTL_MS = 2 * 60 * 1000;
const PR_SETTLED_TTL_MS = 30 * 60 * 1000;
// A focus switch skips the cache unless the answer is younger than this, so a
// burst of focus events costs one lookup, not one each.
const PR_FOCUS_MIN_AGE_MS = 10 * 1000;
const PR_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function loadPrCache() {
  try {
    const c = JSON.parse(readFileSync(PR_CACHE_PATH, "utf8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

// Read-merge-write a single entry, so a concurrent run's other entries survive.
function savePrEntry(key, entry) {
  if (DRY_RUN) return; // a preview writes nothing, the cache included
  const cache = loadPrCache();
  if ((cache[key]?.at ?? 0) > entry.at) return;
  cache[key] = entry;
  for (const [k, e] of Object.entries(cache)) {
    if (!e || entry.at - (e.at ?? 0) > PR_CACHE_MAX_AGE_MS) delete cache[k];
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${PR_CACHE_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2));
    renameSync(tmp, PR_CACHE_PATH);
  } catch (err) {
    process.stderr.write(`space-topic: cannot write PR cache: ${err.message}\n`);
  }
}

// The {ci} mark for each verdict. Emoji, because a Space label is plain text
// and these carry their own colour. A PR with no checks gets no mark. Not ⏳
// for pending: STATUS_GLYPHS would strip it from the head of the label.
const CI_MARKS = { pass: "✅", fail: "❌", pending: "🟡" };
// Shown instead of the CI mark when the PR has merge conflicts: it cannot be
// merged whatever its checks say, so that is the thing to know.
const CONFLICT_MARK = "🔀";

function ciMark(pr) {
  if (!pr) return "";
  return pr.mergeable === "CONFLICTING" ? CONFLICT_MARK : CI_MARKS[pr.ci] || "";
}

// Conclusions and commit-status states that mean a check did not pass.
const CI_FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

// Roll a PR's checks up into one verdict, as GitHub's own badge does: any
// failure fails (a red cross will not turn green by waiting), anything still
// running is pending, otherwise it passes. "" when the PR has no checks.
function ciState(checks) {
  if (!Array.isArray(checks) || !checks.length) return "";
  let pending = false;
  for (const c of checks) {
    // A CheckRun (Actions) has status + conclusion; a legacy commit
    // StatusContext has only state.
    const verdict = c.conclusion || c.state || "";
    if (CI_FAILED.has(verdict)) return "fail";
    if ((c.status && c.status !== "COMPLETED") || verdict === "PENDING" || verdict === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "pass";
}

// The open PR for the branch checked out at `root`. `gh pr view` with no
// argument finds the branch's PR the way gh always does -- tracking remote,
// forks included -- but also returns merged and closed ones, so anything not
// OPEN counts as none. Mid-rebase gh cannot tell which branch that is, so
// then we name it (`branch`), at the cost of matching it by name alone.
//
// Returns null for "no open PR" and undefined for "could not tell" (no gh, not
// logged in, offline), so a network blip keeps the last answer instead of
// flipping the Space back to its topic.
function fetchPr(root, branch) {
  const args = ["pr", "view", ...(branch ? [branch] : []), "--json", "number,title,state,mergeable,statusCheckRollup"];
  const r = spawnSync("gh", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
  });
  if (r.error) return undefined;
  if (r.status !== 0) return /no pull requests found/i.test(r.stderr || "") ? null : undefined;
  try {
    const pr = JSON.parse(r.stdout);
    if (pr.state !== "OPEN") return null;
    // mergeable: MERGEABLE, CONFLICTING, or UNKNOWN while GitHub works it out
    // in the background (after a push, or after the base branch moves).
    return {
      number: pr.number,
      title: normalize(pr.title),
      ci: ciState(pr.statusCheckRollup),
      mergeable: pr.mergeable || "UNKNOWN",
    };
  } catch {
    return undefined;
  }
}

function prFor(head, refresh) {
  if (!head.root || !head.branch) return null;
  const key = `${head.root}::${head.branch}`;
  // Fresh from disk, not a copy read at startup: a concurrent run may have
  // claimed this entry a moment ago.
  const hit = loadPrCache()[key];
  // A claim on a branch never looked up before has no answer to lend (no `pr`
  // key at all), so that one we look up ourselves rather than guess "no PR".
  const age = hit ? Date.now() - hit.at : Infinity;
  // An entry cached before `mergeable` was looked up has it missing, and so
  // counts as unsettled too: it is refreshed rather than trusted for 30 min.
  const settled = hit?.pr && hit.pr.ci !== "pending" && hit.pr.mergeable && hit.pr.mergeable !== "UNKNOWN";
  const ttl = refresh ? PR_FOCUS_MIN_AGE_MS : settled ? PR_SETTLED_TTL_MS : PR_TTL_MS;
  if (hit && "pr" in hit && age < ttl) return hit.pr;
  const previous = hit?.pr;
  savePrEntry(key, { at: Date.now(), pr: previous });
  const fetched = fetchPr(head.root, head.rebasing ? head.branch : "");
  const pr = fetched === undefined ? previous ?? null : fetched;
  savePrEntry(key, { at: Date.now(), pr });
  return pr;
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
    const cwd = claudeCwd(pane) || pane.foreground_cwd || pane.cwd || "";
    // Only shell out to git (and gh) when something actually asks for it.
    const wantsPr = Boolean(cfg.pr_format);
    const wantsBranch =
      wantsPr || cfg.fallback === "branch" || /\{branch\}/.test(String(cfg.format) + cfg.pr_format);
    const head = wantsBranch ? gitHead(cwd) : { root: "", branch: "" };
    const branch = head.branch;
    const focused = process.env.HERDR_WORKSPACE_ID ? id === process.env.HERDR_WORKSPACE_ID : ws.focused;
    const pr = wantsPr ? prFor(head, FOCUS_EVENT && focused) : null;

    let body = topic;
    if (!body) {
      // An open PR is a name in its own right; it does not wait for a topic.
      if (cfg.fallback === "keep" && !pr) {
        items.push({ ws, rec, skip: "no topic yet" });
        continue;
      }
      if (cfg.fallback === "branch") body = branch;
      else if (cfg.fallback === "cwd") body = baseName(cwd);
      if (!body) body = rec.original;
    }

    const label = cap(
      normalize(
        applyFormat(pr ? cfg.pr_format : cfg.format, {
          pr: pr ? pr.number : "",
          pr_title: pr ? pr.title : "",
          ci: ciMark(pr),
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
