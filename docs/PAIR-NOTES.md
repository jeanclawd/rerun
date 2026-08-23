# ReRun Pair — research notes

*2026-08-23. Working notes toward a marimo-pair-like agent integration for
ReRun: an agent CLI (Claude Code first) collaborating on a live reactive
MATLAB notebook. One thing IS built: the pair-over-MCP prototype of §7
(`pair/mcp/`, 9/9 e2e). Issues will be cut from §9 once Yann picks an MVP.*

---

## 1. What marimo pair actually is (research)

Sources: [marimo's implementation blog post](https://marimo.io/blog/notebooks-as-a-tool-for-agents),
[the pair guide](https://docs.marimo.io/guides/generate_with_ai/marimo_pair/),
[AI-assist docs](https://docs.marimo.io/guides/editor_features/ai_completion/).

marimo ships **two distinct AI surfaces**, and "pair" is specifically the
second:

1. **The editor's built-in assistant** — chat sidebar + per-cell prompts,
   BYO-LLM (OpenAI/Anthropic/Gemini/ollama). Data-aware: `@df` in a prompt
   splices a live variable's schema/values into context. Chat has *Ask* mode
   (read-only inspection tools) and *Agent* mode (add/remove/update cells, run
   stale cells).

2. **`marimo pair`** — the inverse topology: instead of an LLM embedded in the
   notebook, the **running notebook becomes a tool for a terminal agent**
   (Claude Code, Codex, OpenCode), on the user's existing agent subscription.
   Distribution is an **agent skill** (`npx skills add marimo-team/marimo-pair`),
   invoked as `/marimo-pair pair with me on my_notebook.py`. Works locally and
   against their cloud sandbox (molab).

### How pair works under the hood

- **One entrypoint: `execute-code`** — a CLI/script that runs Python *inside
  the live kernel*. Notebook variables are in scope; code run this way is
  **scratchpad** — it does not touch the notebook document.
- **Durable changes go through an internal "code mode" API**, used *from
  Python inside the kernel*:

  ```python
  import marimo._code_mode as cm
  async with cm.get_context() as ctx:      # transaction boundary
      cid = ctx.create_cell("df.head()")
      ctx.edit_cell(cid, code="df.head(20)")
      ctx.run_cell(cid)
  ```

  The `async with` block batches ops; on exit marimo **validates the whole
  batch with the same rules as UI edits** (syntax, multiple definitions,
  cycles, removing names others depend on). Any failure → the entire batch is
  rejected, notebook unchanged, offending cells named. Success → per-cell
  report: clean / errored / broken-by-upstream.
- **The skill teaches almost nothing**: it tells the agent to run `help(cm)`
  at startup and learn the API from runtime help, so skill and implementation
  evolve independently.
- **Design iteration worth internalizing** — their v1 vs v2:
  - *v1*: agent edits the `.py` file with normal file tools; `--watch` reloads
    it; read-only MCP endpoints for inspecting state. **Failed** because read
    and write took different paths, coordination was fiddly, and fixed
    endpoints couldn't anticipate what the agent would need to inspect.
  - *v2*: inspection AND mutation are both *code execution in the kernel*.
    The agent decides what to look at based on what it encounters; the
    notebook server (not the agent) enforces the invariants.
- Accepted cells land in the pure-`.py` file and the dataflow graph →
  deterministic replay in dataflow order, git-diffable artifact, no hidden
  state, every commit pre-validated.

### The transferable lessons

1. **Unify observe and act as code execution.** Fixed tool schemas rot;
   "run code in the kernel" doesn't.
2. **Scratchpad vs. commit is the core distinction.** Exploration must be
   cheap and leave no trace in the document; durable edits are explicit,
   batched, transactional.
3. **The runtime validates, not the agent.** Same rules as human edits, batch
   all-or-nothing.
4. **Ship it as a skill; keep the skill thin** (self-describing API).
5. **Reactivity is what makes agent edits safe** — an agent edit propagates
   exactly like a human edit, and upstream invalidation means nothing stale
   survives silently.

---

## 2. Where ReRun differs structurally (the honest part)

**marimo's kernel is a server process; ReRun's kernel is a browser tab.**
Everything in marimo pair assumes an external process can reach the running
kernel. ReRun has no server at all — the wasm session, the DAG, and the
document live in the user's tab. So pair needs a bridge, and the bridge choice
is the main architectural decision:

### Option A — the tab stays the kernel; a relay connects the agent
A tiny WebSocket relay on the box (`/rerun/pair/<session>`); the open ReRun
tab registers, the agent CLI connects with a pairing token shown in the
header. Ops travel agent → relay → tab; the tab executes against its live
session and answers.

- ✓ the user's tab remains the single source of truth; they *watch the agent
  work* — cells appear, statuses pulse, plots redraw (the marimo-pair demo
  effect, which is most of the magic)
- ✓ zero second-runtime cost; the session already exists
- ✗ notebook must be open in a browser; tab sleep/refresh drops the pair
- ✗ relay is new infra (small: dumb message pipe, auth by token)

### Option B — headless Node kernel, browser mirrors it
Run the session server-side (runmat-python's NodeTransport already drives
RunMat under Node), agent talks to it directly; browsers become viewers.

- ✓ closest to marimo's topology; agent can pair with no browser open
- ✗ inverts ReRun's architecture (v0.1 is proudly serverless); state
  mirroring browser↔server is a whole project
- ✗ two runtimes to keep honest (Node wasm vs web wasm — F-series quirks may
  differ)

**Lean: Option A.** It preserves what ReRun is, it's a weekend of work, and
the on-box agent (Claude Code driving this repo via Telegram) is the natural
first client — the relay can even be tested agent-side without any skill
distribution story.

### Second structural difference: the language of the scratchpad
marimo's agent writes *Python in a Python kernel* — inspection code is
arbitrarily expressive. Our scratchpad is MATLAB in RunMat, which is fine for
data inspection (`size(x)`, `x(1:5)`, `fieldnames(s)`) but the *notebook
manipulation API* can't live inside MATLAB the way `marimo._code_mode` lives
inside Python (RunMat can't call back into the app). So ReRun pair needs a
**two-verb protocol** rather than marimo's one-verb elegance:

- `exec` — scratchpad MATLAB in the live session (observe)
- `apply` — a batched cell-ops transaction (act)

That's still v2-shaped (the runtime validates; scratch is traceless), just
with the act-verb as structured ops instead of in-language API calls.

---

## 3. What ReRun already has that pair needs

Inventory of existing assets, mapped to marimo-pair concepts:

| marimo pair concept            | ReRun equivalent, today                          |
| ---                            | ---                                              |
| batch validation rules         | `dag.js buildGraph` — duplicate defs, cycles, cross-cell mutation, exactly the UI's rules (18 unit tests) |
| run in dataflow order          | `graph.order`, `descendantsOf()` — the scheduler |
| kernel with variables in scope | the persistent wasm session + `SessionRunner`    |
| variable inspection            | `runner.workspace()` previews; `materializeVariable` for deep reads |
| per-cell result report         | `runOne` already yields ok/error/duration/figures |
| clean/errored/broken-upstream  | falls out of reactive rerun + honest errors      |
| pure-file artifact             | `.rerun.m` export (issue #1: stable IDs)         |
| `@df` data-aware prompts       | workspace previews are textual already           |

The batch-validation story is *identical* to marimo's and we get it client-side
for free — `buildGraph(proposedCells)` on a copy, reject on any new graph
error, before anything executes.

---

## 4. Proposal sketch (v0)

### Protocol (JSON over the relay WebSocket)

```
→ {op: "hello", token}
← {ok, notebook: {cells: [{id, source, status, defs, uses}], edges}}

→ {op: "exec", code}                     // scratchpad; traceless
← {ok, stdout, displays, error, workspace}

→ {op: "read", what: "workspace" | "cell", id?, name?, maxElements?}
← {ok, ...}                              // materialize a variable, fetch a cell

→ {op: "apply", ops: [                   // transaction, all-or-nothing
     {kind: "create", after?, source},
     {kind: "edit", id, source},
     {kind: "delete", id}]}
← {ok, report: [{id, status: "ok"|"error"|"stale-parent", ms, error?}],
   rejected?: [{id, graphErrors}]}       // rejected → nothing ran

→ {op: "figure", cellId}                 // SVG of a cell's current figure
← {ok, svg}
```

`apply` semantics, stolen from marimo verbatim: validate the whole batch with
`buildGraph` on the would-be cell list; any new graph error rejects the batch
untouched. On success, run created/edited cells + descendants reactively and
return the per-cell report. The user *sees* all of it happen in their tab.

### Scratchpad hygiene
`exec` shares the workspace (as marimo's does). Two guards: (1) the skill
teaches a `pad_` prefix convention for scratch variables; (2) `exec` responses
include the workspace delta so the agent knows what it leaked, and a
`{op:"exec", cleanup:true}` variant clears any new names afterward. A scratch
assignment that collides with a notebook-owned name is refused client-side
(dag ownership check) — that's a guard marimo doesn't have.

### Relay
~100 lines of Node `ws` on the box behind `handle /rerun/pair`: rooms keyed by
session id, token auth, no persistence, messages opaque. The ReRun tab shows
"⟳ paired with an agent" + a kill switch when a client is attached.

### Skill
`~/.claude/skills/rerun-pair/SKILL.md`: connect via `websocat`/small node
client, run `{op:"hello"}`, learn the notebook shape from the response, follow
the scratch-then-apply loop, prefer small batches, read errors from the report
and iterate. Thin, marimo-style; the protocol answers `hello` with its own
op list so the skill never hardcodes the surface.

### Not in v0
- Shadow-session speculation (trial-run applies in a second wasm session) —
  valuable, later; `apply`'s all-or-nothing validation covers the worst cases.
- The embedded chat sidebar (marimo surface #1) — different feature; the
  browser-side "✨ fix this cell" loop can reuse the same `apply` machinery
  when it comes.
- UI-element manipulation (ReRun has no widgets yet — that's a streamlab
  crossover waiting to happen).

---

## 5. Open questions

1. **Pairing UX**: token in the header vs. a `/rerun/pair new` page that mints
   a link to paste to the agent? (marimo/molab does "Pair with an agent" →
   copy instructions.)
2. **Multi-notebook**: relay rooms make several tabs pairable; does the agent
   pick by name? (`hello` should return a notebook title — add one to ReRun.)
3. **Offline agent edits**: when no tab is open, should the agent fall back to
   editing the `.rerun.m` file (marimo v1 style, acknowledged worse) or just
   refuse? Leaning: refuse — v1 is the documented failure mode.
4. **Does `exec` allow `clear`/`close` etc.?** Probably yes (the user watches
   and holds the kill switch), but the skill should discourage destructive ops
   outside `apply`.
5. **Figures to the agent**: SVG text is fine for Claude (it reads structure),
   but a rasterized PNG option might serve vision-based review better.

---

## 6. Backend research: which harness does pair serve? (substrate-eval applied)

The estate already answered the harness question once —
[`/root/Projects/substrate-eval`](https://github.com/yanndebray) compared
**pi** (earendil-works, TS), **Pydantic AI + harness** (Python), **opencode**,
and **Codex app server** (Rust) at source level on nine axes. The findings
that matter for pair:

1. **"Publish the protocol, withhold the loop."** All three non-Python
   substrates converge on the same shape: opencode's core is `private: true`
   on npm, pi's `AgentHarness` throws `HarnessNotImplemented` for 22 methods,
   Codex publishes `codex-app-server-protocol` but not `codex-core`. You
   cannot build *inside* these harnesses; you can only stand next to them and
   speak their wire.
2. The eval's decisive axis was **where the live objects live**. For the
   data-science product that meant Python (Pydantic AI won). For pair the
   live objects are the **wasm session and the DAG** — they live in *our*
   process, not the harness's, in any design. So the axis flips: no harness
   holds our objects, therefore **choose the wire every harness speaks**.
3. The eval's own 22-Aug addendum says it outright: *"an MCP server is a
   process you own, so it can hold the real objects while staying reachable
   from every harness."*

**Conclusion for pair:** a Claude-Code-only skill+CLI (marimo's distribution)
is the wrong dependency to take first. Ship the pair surface as an **MCP
server that owns the notebook**; every harness in the eval — and Cursor,
Windsurf, Pydantic AI's MCP client, this box's own Claude — can attach. A
skill remains worth having, but as a thin *etiquette layer* (scratch-then-
apply discipline, small batches) on top of the MCP tools, not as the
mechanism.

### The engine already ships the hard part

Worth stating (this was the striking realization reviewing marimo's build):
marimo had to *build* "code mode" — a semi-private kernel API plus scripts —
because Jupyter-descended kernels don't expose a session boundary. RunMat's
TS/wasm binding already has one: `executeRequest`, workspace snapshots
(deltas), lazy `materializeVariable`, figure-scene export — host-neutral,
the same API from Node and the browser. Pair-equivalent is therefore mostly
*protocol + validation + etiquette*; the execution primitive exists. The
prototype below confirmed it: zero engine-side work was needed.

And the second half is coming for free too: RunMat's compiler pipeline
resolves names and bindings in HIR, so an engine-assisted version of our
validation could reject a commit with a *precise* diagnostic ("redefines a
name owned by cell 4") instead of our lexical approximation. Our `dag.js` is
the 90% version; HIR is the upstream opportunity to note in runmat-lab when
the lab de-stealths.

---

## 7. Prototype: pair-over-MCP (built, works)

`pair/mcp/server.mjs` — ~330 lines, no SDK dependency: an MCP stdio server
(JSON-RPC 2.0, protocol 2024-11-05) that owns a **headless RunMat session +
a ReRun notebook** (cells, DAG, no-hidden-state clears, F16/F17 guarded
function install). Five tools:

| tool            | verb it implements |
| ---             | --- |
| `notebook`      | hello — cells with defines/uses, execution order, workspace previews |
| `exec`          | scratchpad MATLAB, notebook vars in scope, **refuses assigning a notebook-owned name** (a guard marimo doesn't have) |
| `apply`         | transactional batch (create/edit/delete); whole batch validated by `buildGraph` first, any violation → rejected untouched; success → changed cells + descendants rerun, per-cell report |
| `read_variable` | lazy materialization beyond previews |
| `export_m`      | the dependency-ordered plain-`.m` artifact |

`pair/mcp/test-client.mjs` drives it like a harness would. **9/9 pass**,
including the two that matter:

- *reactive edit*: `apply(edit f=3→7)` reran exactly 3 cells (f, y, peak —
  t untouched), peak 0.88012 → 0.94602
- *guardrail*: a batch adding a second `f` was rejected with the graph error
  and the notebook verifiably unchanged

Registering it with any MCP-capable harness is one config line
(`node pair/mcp/server.mjs`). What the prototype deliberately lacks: the
**browser tab**. It proves the tool surface against a headless session; the
same five verbs later front the browser relay (§4 Option A), at which point
the human watches the agent's applies land live.

---

## 8. Sidebar: the rerun.io "diary" idea (parked, promising)

Separate thread worth keeping (from Yann's notes): [Rerun](https://rerun.io)
— the robotics visualization/logging tool — has a data model (entity paths ×
multiple timelines) that maps onto a reactive notebook suspiciously well:

- `/workspace/A`, `/cell/3/output` as entity paths
- an `edit` timeline (every cell mutation, attributed human vs agent)
- a `run` timeline (every propagation through the graph)

Every re-execution becomes a time point → dragging a parameter gives a
*scrubbable recording of the whole sweep*, and when an agent breaks something
at 2am you scrub back and watch which variable changed shape. The sharpest
version logs the **agent's scratchpad too** — exactly what marimo pair throws
away, and the most useful forensic data in a pair session. "Rewind what your
agent explored, not just what it committed" is a feature nobody has.

Two known costs before believing in it: (1) Rerun's viewer is immediate-mode
egui on canvas — no DOM, no text selection, no CSS — so it must be a
side-by-side panel, never the inline cell renderer (decide early, expensive
to reverse); (2) MATLAB plotting is stateful/imperative (`figure`, `hold on`)
vs Rerun's declarative entity logging — the shim is real work.

### Naming (also from Yann's notes — name the system, not the feature)

MATLAB's own vocabulary gives the family for free:

- **`hold on`** — pair mode. MATLAB's "add to the existing plot without
  erasing it," which is precisely human-and-agent-on-one-canvas. The one.
- **`diary`** — the recording layer. Already means "the record of everything
  that happened" in MATLAB.
- **`keyboard`** — the agent's live-workspace access; MATLAB's command for
  dropping into the workspace mid-execution.

`hold on` + `diary` reads like it was always part of the language.

---

## 9. MVP options

Ordered by how much they build on what now exists (the MCP prototype):

**Option 1 — headless pair, ship it (1 day).** Harden `pair/mcp` as-is:
notebook load/save (`.rerun.m` from issue #1), figure SVGs returned by a
tool, register with this box's Claude Code + write the thin etiquette skill.
Agent-only notebooks; the human reviews via `export_m` or by opening the
file in ReRun afterwards. Cheapest possible validation of whether pair
sessions are actually useful for MATLAB work.
*Risk: nobody watches the agent live — the demo magic is missing.*

**Option 2 — the relay: same five verbs, live tab (2–3 days).** §4 Option A:
WebSocket relay on the box, the MCP server becomes a *bridge* — same tools,
but `exec`/`apply` forward to the open ReRun tab, which executes in ITS
session and renders as it goes. Human watches cells appear, statuses pulse,
plots redraw; kill switch in the header. MCP stays the harness-facing wire
(the substrate-eval lesson), the tab stays the kernel (the ReRun principle).
*Risk: relay/tab lifecycle (sleep, refresh, two tabs) is fiddly state.*

**Option 3 — `hold on` in the UI first (2 days, different bet).** Skip
agents-from-outside; build the browser-side ✨ loop (fix this error /
generate cell) calling the Anthropic API directly with ancestor-subgraph
context + dag.js pre-flight. No relay, no MCP, instant demo value.
*Risk: it's marimo surface #1, not pair — doesn't answer the harness
question and locks to one provider unless BYO-key UI is added.*

**Option 4 — `diary` spike (research, 1 day).** Log edit/run/scratch events
from the MCP prototype into an .rrd via rerun-io's JS/Node SDK, open in
their viewer. Validates the recording idea with zero UI work.

**Recommended path: 1 → 2**, with 4 as a side-spike whenever the forensic
story wants a demo. 1 is nearly done (this prototype), 2 makes it a product,
and 3's machinery (context assembly, validation) is shared with both anyway.
