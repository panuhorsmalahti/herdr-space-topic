# herdr-space-topic

> herdr plugin: name each **Space** after the work happening inside it, instead of after its directory.

herdr labels a Space from its directory, so several worktrees of one repo all
read the same name in the sidebar and you have to open each one to remember
what it is doing.

![Six spaces that all read api-server become six distinct names, two of them from open pull requests](docs/sidebar.svg)

<sub>Illustration — labels are examples, not a capture of a real session.</sub>

Agents already say what they are working on: Claude Code, Codex and friends set
the terminal title, and herdr exposes it per pane as `terminal_title_stripped`.
This plugin picks the pane that leads each Space and writes that topic onto the
Space itself.

It is the Space-level companion to
[`danbuhler/herdr-pane-topic-sync`](https://github.com/danbuhler/herdr-pane-topic-sync),
which does the same for panes and tabs. The two compose: panes and tabs from
that one, Spaces from this one. Neither needs the other.

## Install

```bash
herdr plugin install panuhorsmalahti/herdr-space-topic
```

Requires herdr >= 0.9.0 and `node` >= 18 on your `PATH`. No npm dependencies,
no build step, no API key — the topic is already on the server. Naming Spaces
after pull requests also needs the GitHub CLI, [`gh`](https://cli.github.com),
logged in; without it the plugin just sticks to topics.

Look before you leap. `preview` walks the session and prints what it *would*
rename, writing nothing:

```bash
herdr plugin action invoke phorsmalahti.space-topic.preview
herdr plugin log list --plugin phorsmalahti.space-topic   # actions log, not tty
```

Actions are refused while a plugin is disabled (`plugin_disabled`), so that
only works once the plugin is enabled — by which point it has already renamed
on the first event. To see the plan *before* anything is written, run the
script directly from the plugin directory instead:

```bash
node sync-space-labels.js --dry-run
```

It prints to your terminal, reads the same live session through the `herdr`
CLI, and needs no plugin context. `restore` undoes the lot either way.

## How a Space gets its name

1. **Pick the pane that speaks for the Space.** By default that is reading
   order — lowest tab number, then top-left. A pane that is an agent *and* has
   a topic beats one that is only an agent, so a leading shell pane does not
   silence the Space. Set `source = "active"` to follow the focused pane inside
   that Space instead.
2. **Take its topic** — `terminal_title_stripped`, the agent's live terminal
   title with the spinner glyph removed.
3. **Format and truncate it**, then write it with `herdr workspace rename`.

When there is no topic yet — agent still starting, plain shell, agent exited —
`fallback` decides: the original label, the Git branch, the directory basename,
or leave the sidebar alone.

## Spaces with a pull request

If the branch checked out in the lead pane's directory has an **open** pull
request on GitHub, the Space is named after the PR instead of the topic, with a
mark for its CI:

```text
✅ PR#232: feat(voice): run voice chat a…    every check passed
❌ PR#238: fix(bedrock): send Converse m…    a check failed
🟡 PR#269: test(e2e): answer repeated m…    checks still running
🔀 PR#255: feat(prism-client): publish…     merge conflicts, whatever CI says
PR#271: docs: fix a typo in the READM…       no checks at all
```

A single failed check is enough for ❌, even while others are still running,
since waiting will not turn it green. A PR with merge conflicts shows 🔀
instead of its CI mark: it cannot be merged either way, so that is the thing to
know. The marks are emoji because a Space label is plain text and these carry
their own colour.

An approved PR also gets 📝, in front of the other mark:

```text
📝 ✅ PR#270: docs(agents): drop the mig…    approved, every check passed
📝 🔀 PR#232: feat(voice): run voice cha…    approved, but has conflicts
```

The PR keeps its name while an agent rebases it to fix those conflicts: HEAD is
detached for the length of a rebase, so the plugin reads the branch being
rebased from git instead.

The lookup is `gh pr view` in that checkout, so it finds the PR the same way
`gh` does from your shell, forks included. Draft PRs count; merged and closed
ones do not, so a Space goes back to its topic once its PR is merged.

A PR and its checks come from the same lookup, which is refreshed:

- **when you switch to the Space**, straight away;
- **every 30 minutes or so** once its checks have settled on ✅ or ❌;
- **every 2 minutes** while checks are still running, or while the branch has
  no PR yet, so a result or a newly opened PR shows up quickly.

herdr has no timers for plugins, so "every" means on the next herdr event after
that much time has passed. Any agent changing state or any focus change counts,
so while agents are running it is rarely late by much. If `gh` is missing,
logged out or offline, a Space keeps whatever the last successful lookup said.

**Claude Code worktrees are followed.** A Claude Code session moved into a
worktree (`claude --worktree`, or its EnterWorktree tool) keeps its process in
the directory it was launched from, so herdr reports the main checkout, which
is usually on `main` with no PR. For Claude panes the plugin reads where the
session really is from its transcript under `~/.claude/projects` (or
`$CLAUDE_CONFIG_DIR`), so each worktree Space finds its own branch and PR.
Other agents are looked up in herdr's directory for the pane; Spaces sharing
one checkout there share its branch, and therefore its PR name.

Change the shape with `pr_format`, which takes every `format` token plus `{pr}`,
`{pr_title}`, `{review}` (📝 when approved, else nothing) and `{ci}` (the CI or
conflict mark, or nothing when the PR has no checks and no conflicts); set it
to `""` to turn PR lookups off:

```toml
pr_format = "{review} {ci} PR#{pr}: {pr_title}"   # default
pr_format = "PR#{pr}: {pr_title}"                 # no marks
pr_format = "#{pr} {review}{ci} {topic}"          # #265 📝✅ Fix flaky auth test
pr_format = ""                                    # topics only, never call gh
```

PR titles run long, so consider raising `max_label_length` alongside.

## Your own names win

Rename a Space by hand and the plugin stops writing to it. It tracks the labels
it has written; a live label it does not recognise is a name you typed, and it
leaves it alone from then on.

To hand a Space back, rename it to its original label, or run:

```bash
herdr plugin action invoke phorsmalahti.space-topic.adopt   # from that Space
```

To undo everything:

```bash
herdr plugin action invoke phorsmalahti.space-topic.restore
```

`restore` puts back the label each Space had the first time the plugin saw it,
and forgets its state. It only reverts Spaces still carrying a label the plugin
wrote — one you renamed yourself is left as you left it.

## Non-destructive mode

`mode = "rename"` overwrites the Space label, which is what makes it work with
no setup. If you would rather keep your labels, use `mode = "token"`: the topic
is published as a workspace token via `herdr workspace report-metadata` and
your label is never touched. Then place `$topic` in a Space sidebar row in your
herdr config. `mode = "both"` does both.

## Configuration

Optional. Every key has a default; see
[`examples/default-config.toml`](examples/default-config.toml) for the annotated
list.

```bash
cp examples/default-config.toml "$(herdr plugin config-dir phorsmalahti.space-topic)/config.toml"
```

| key | default | what it does |
| --- | --- | --- |
| `enabled` | `true` | turn the plugin off without unlinking it |
| `mode` | `"rename"` | `rename`, `token`, or `both` |
| `token_name` | `"topic"` | token name for `token`/`both` (`$topic` in a Space row) |
| `source` | `"first"` | which pane speaks for the Space: `first` or `active` |
| `fallback` | `"original"` | with no topic: `original`, `branch`, `cwd`, `keep` |
| `format` | `"{topic}"` | `{topic} {agent} {original} {branch} {cwd} {number} {status}` |
| `pr_format` | `"{review} {ci} PR#{pr}: {pr_title}"` | used instead of `format` when the branch has an open PR; adds `{pr} {pr_title} {review} {ci}`; `""` turns it off |
| `max_label_length` | `40` | truncate after formatting (clamped 8–80) |
| `respect_manual_names` | `true` | never overwrite a Space you renamed |
| `require_agent` | `true` | only manage Spaces that host an agent |
| `skip` | `[]` | workspace ids or exact labels to never touch |

A couple of formats worth trying:

```toml
format = "{agent} › {topic}"     # claude › Fix flaky auth test
format = "{branch} · {topic}"    # fix-auth · Fix flaky auth test
format = "{number}· {topic}"     # 2· Fix flaky auth test
```

## When it runs

herdr runs the script on the events in
[`herdr-plugin.toml`](herdr-plugin.toml): Space, tab and pane lifecycle and
focus, plus the one that carries the topic — `pane.agent_status_changed`, an
agent flipping idle↔working, which is when it names the task it just started.

herdr 0.9 has no plugin hook for a bare terminal-title change:
`pane.updated` exists as a socket subscription but is rejected as a hook name,
so a topic the agent rewrites mid-turn lands on the next status flip rather
than instantly. Run the `sync` action to force one.

It deliberately does **not** subscribe to `workspace.renamed`: its own renames
emit that event, and it would re-trigger itself forever.

There is no daemon. Each run is a short walk of `workspace list`, `tab list`
and `pane list` that exits when it is done, and it writes only when a label
actually changes.

## Notes

- **Concurrency.** herdr fires several of these events at once, so copies of
  the script run concurrently. State is a short history of labels per Space
  rather than one string, so concurrent runs merge instead of clobbering, and
  writes to the state file are atomic.
- **State** lives in `HERDR_PLUGIN_STATE_DIR`. Delete it and the plugin treats
  the labels currently on screen as the originals — `restore` then puts those
  back rather than the directory names.
- **Git and GitHub.** `git` only runs when something needs the branch:
  `pr_format`, `fallback = "branch"`, or `{branch}` in a format. `gh` only runs
  when `pr_format` is set, at most once per checkout and branch per refresh
  (see above); the cache sits next to the state as `space-topic-prs.json`.
- **Verified** against herdr 0.9.0 on macOS with Claude Code and Codex panes.
  `min_herdr_version` is `0.9.0` because that is what it has been run against,
  not because older versions are known to break.

## License

MIT
