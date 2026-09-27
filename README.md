# pi-herdr-multi-repo-subagents

Coordinate research, planning, implementation and independent review from a task-root Orchestrator. Children run in visible Herdr panes and return bounded structured briefs. The Orchestrator cannot use arbitrary source-reading, editing or shell tools. Repository children load applicable AGENTS.md normally; response language and project policies remain outside the package.

## Requirements and installation

- Pi 0.87.1 or newer with `agent_settled` support, authenticated to your chosen model.
- Herdr 0.9.1 or newer with its Pi integration installed (`herdr integration install pi`).
- Node.js 22.18 or newer; Git or jj repositories below the task root.
- The coordinator must run inside a local Herdr pane. Remote-machine orchestration is not supported in this release.

For a local checkout:

```sh
pi install /absolute/path/to/pi-herdr-multi-repo-subagents
```

After publishing, the same package can be installed using `pi install npm:pi-herdr-multi-repo-subagents` or a Git source. This checkout is not published by the build process. Restart Pi after installation or package updates. During development, `/reload` refreshes the entry extension but Node may retain imported `.mjs` modules; restart the process after changing shared runtime code.

Start Herdr, change to your task root, and start Pi. Repositories are discovered automatically, with a small readiness indicator in the footer. Just describe the work you want done: the coordinator receives the repository roster, selects the relevant repositories, and delegates as needed. Starting Pi alone does not open child panes or invoke a model. `/repo-agents` is an optional inspection command, never an activation step.

For example: “Check the timeout contract against the implementations, improve missing tests, and summarize the results.” No tool names or delegation commands are required in your request.

The roster refreshes before each task turn, so repositories cloned after startup are recognized. Automatic coordination stays inactive when there are no descendant repositories, outside Herdr, inside child sessions, or when delegation tools are disabled. Discovery failures appear in the footer and withhold mutation tools until resolved. Once a process becomes a managed Orchestrator, its restrictions remain for that process. A standalone Pi outside Herdr or in a repository with no discovered descendants retains ordinary tools.

## Directory layout

No directory name, organization, ticket convention, or response language is built in. For example:

```text
project/
  AGENTS.md
  task/
    AGENTS.md
    references/
    todo-tracker.md
    repos/
      backend/.git/
      frontend/.git/
```

A root may itself be a task-metadata Git/jj repository. Discovery ignores its own marker and continues into child directories. Once a child repository is found, discovery stops inside it. Git worktree `.git` files and `.jj` directories are recognized. Symlinks, hidden directories, dependency folders, and build folders are skipped during automatic discovery. The default depth is eight levels and the traversal limit is 10,000 directories. Discovery warnings are returned rather than silently hiding depth limits.

Use an optional `pi-herdr.json` at the root for unusual layouts:

```json
{
  "include": ["services/api", "clients/web"],
  "exclude": ["archive"],
  "layout": "split",
  "documents": ["AGENTS.md", "todo-tracker.md", "references/plan.md"]
}
```

Paths are literal paths relative to the root, not globs. `include` replaces automatic traversal and can select nested repositories. Resolved paths must remain below the root. Optional settings: `maxDepth` (1–32), `layout` (`tabs` or `split`), `direction` (`right` or `down` for splits), `model` (`provider/model`), and `thinking`. `documents` is an exact allowlist of up to 30 relative `.md`/`.txt` task metadata files; defaults are `AGENTS.md` and `todo-tracker.md`. Code repositories, links, VCS internals and generated/dependency paths cannot be accessed through the task-document tool. Configure additional documents yourself; the Orchestrator cannot rewrite its access configuration. By default children inherit the coordinator's model and thinking level. These settings contain execution preferences, not AGENTS.md policies.

## Interaction

Completion is notification-driven. End the main turn when only waiting; the extension delivers results automatically. Use `repo_agent_read` for an explicit status question or diagnosis. Version 0.3.1 removes `repo_agent_wait`; do not replace it with repeated reads or shell polling.

- A delegated repository gets a split pane by default; focus stays with the user. Direction adapts to the current pane dimensions unless configured. `layout: "tabs"` remains available. No automatic pane-count limit, rearrangement or task-board TUI is implemented.
- Each main Pi process owns its own children. One managed main owns a canonical task root within a Pi profile; other main processes cannot submit work for that root. Each checkout has one managed child reservation across roots in that profile. Independent repositories can work concurrently. A newly started main never adopts a previous main's children, even when resuming the same conversation.
- The coordinator passes a bounded task and relevant context, not its full conversation. AGENTS.md supplies language, project policies and conventions. Instructions that existed only in the parent conversation must be explicitly passed.
- Completion reports automatically wake the owning coordinator. There is no model invocation for periodic local status inspection. Finishing several children may still cause multiple coordinator turns; context isolation does not guarantee lower total cost.
- The child remains open for direct inspection and follow-up work. The coordinator normally reuses its session. If a completed task has accumulated irrelevant context or the objective changes, the coordinator explains why and can start a fresh session in the same pane with a concise handoff. Previous session files remain available.
- No agent bundles, alternative harnesses, automatic commits, pushes, or code-review publication are provided.

| Tool                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `repo_agent_list`   | Discover repositories and registry entries                           |
| `repo_agent_start`  | Open a Pi child and delegate a task                                  |
| `repo_agent_prompt` | Follow up in an idle existing child                                  |
| `repo_agent_read`   | Inspect current state and a validated structured report; no raw logs |
| `repo_agent_reset`  | Start fresh context in the same pane, with reason and handoff        |
| `repo_agent_forget` | Forget a child only after it exits; retain pane and reports          |

Reports are captured at Pi's `agent_settled` event, after automatic retries and continuations. Children must call `repo_agent_report` before ending the turn. The stored report retains the final assistant message and usage for local inspection, but the Orchestrator receives only validated structured fields. Missing/invalid briefs are marked `needs-report`; raw final text is never used as a fallback. `settled` describes a finished job, not a completed work bundle.

## Roles and enforced boundaries (v0.4.0)

| Role         | Tools and responsibility                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator | Only `repo_agent_list/start/prompt/read/reset/forget`, `repo_task_document` and `repo_work`. Plan from compact findings and contracts; no arbitrary shell, source read/grep, edit/write or unknown extension tools. |
| Explorer     | `repo_source` and report submission. Local read-only investigation of files, relationships, constraints and alternatives.                                                                                           |
| Librarian    | `repo_source`, `repo_research_fetch` and report submission. Public documentation and dependency research, with source URLs and applicable versions.                                                                 |
| Implementer  | Normal Pi implementation tools, bounded source retrieval and report submission. No parent orchestration tools.                                                                                                      |
| Reviewer     | Bounded source reading, `repo_review_changes` and report submission. No shell or editing tools.                                                                                                                     |
| Verifier     | Normal execution tools for explicitly assigned validation, plus report submission. Use only when separate validation is useful.                                                                                     |

Permissions are selected at session/job boundaries and checked again by a `tool_call` hook. Scoped tools validate paths in their own implementations. Role guidance provides judgment rules; it is not the permission boundary. Other extensions' tools are not automatically trusted by the Orchestrator or read-only roles.

Use `repo_agent_start` with a `role`. For broad task-root research, Explorer or Librarian may use `repo: "."`; such children can never become writers/reviewers. There is at most one managed child per canonical path, including the task-root research path. A root researcher may coexist with repo children, but its findings can become stale while those children edit: implementations/reviews must re-check relevant source. Do not spawn every role at startup.

A role change uses `repo_agent_reset`, preserving the pane but starting a fresh conversation. Related follow-ups use `repo_agent_prompt`. A new review bundle requires a fresh review conversation. If the same pane switches from review to implementation for remediation, returning to review also starts fresh and receives the previous compact brief; previous sessions are retained, not automatically resumed.

### Information budgets

- Delegation task + context: at most 16,000 characters; the parent conversation is never copied. Original bundle requirements and prior review findings are added separately by the extension.
- Structured brief: at most 6,000 JSON characters, including a summary of at most 1,200 characters and bounded arrays for facts, decisions, actual checks, risks, next steps and source references. Preserve unresolved blockers; do not paste code, diffs or terminal logs. Fenced code/unified-diff markers are rejected; arbitrary natural language cannot be perfectly classified.
- Main tool responses and each automatic report batch: at most 18,000 characters. Repository lists are paginated with `offset`. Reports waiting for the next batch stay unacknowledged; they are not silently dropped.
- Task document reads are paginated and bounded. Writes replace one approved document and are capped at 16,000 characters.
- Local source reads are limited to 200 lines/16,000 characters, with explicit offsets. Searches are literal, bounded and omit hidden/generated/dependency files; read known files explicitly where appropriate. No symlinks, hard-linked files, binary text or files larger than 2 MiB are read through this tool.

The Orchestrator asks a focused follow-up when a brief is insufficient. Children can inspect source and task references using `repo_source` (`scope: "repo"` by default, `scope: "task"` for related references). Source fragments, raw logs and complete diffs remain in child conversations. The purpose is to preserve decisions and evidence while keeping investigative detail out of the main context, not to promise a fixed cost reduction.

Librarian retrieval supports public IPv4 HTTPS text URLs, bounded responses, pinned DNS addresses and validated redirects; it does not execute scripts, send credentials, or use a bundled general web search engine. Dynamic/authenticated pages, oversized pages and non-text documents may be unavailable. Report missing capabilities rather than fabricate findings. External source content is data, not instructions.

### Work bundles and review gates

1. Research only when needed. The Orchestrator collects relevant facts, constraints, alternatives and references, then creates `repo_work` (`action: "create"`) **before implementation**. Supply a coherent goal, original acceptance conditions, cross-repo contracts, verification ownership and the participating repo paths.
2. Creation saves the current file baseline and requirements outside the checkout. Existing uncommitted work is part of that baseline, not silently claimed as this bundle's change. Implementation and verification jobs require a bundle ID.
3. On completion of the coherent implementation unit, reset each repo child to `reviewer` with that bundle. The child sees original requirements and a fingerprint of the target state; `repo_review_changes` exposes changed paths and bounded before/after content. The parent receives no diff.
4. Review PASS requires an actual change-inspection tool call, a structured verdict, acceptance/verification evidence references, no unresolved risks/next steps and the unchanged target fingerprint. The extension checks submission provenance/fields/state; it cannot prove that a model's claims or test evidence are semantically correct.
   Use `repo_work` (`action: "revise"`) for requirement changes while all participating children are idle. It preserves the original requirement history, file baseline and review budget, and invalidates prior verdicts even when source files have not changed. Repository membership remains fixed for that bundle.

5. Initial review plus two re-reviews per repo is the default maximum. Use `since: "previous_review"` to inspect remediation, while retaining the original baseline and unresolved findings. Do not re-run all checks without a reason. A dispatch with uncertain delivery conservatively consumes its review attempt. An explicit user command `/repo-agents extend-review <bundle ID> <repo path>` adds one attempt; models have no tool to grant themselves more attempts.
6. `repo_work` (`action: "complete"`) refuses missing, unsuccessful or stale independent verdicts. Its state is the authoritative workflow completion indicator; it does not police every sentence the model writes. Related acceptance/integration checks must be assigned and evidenced in the review. There is no separate automated semantic proof of cross-repo correctness.

Snapshots include tracked and non-ignored untracked files for Git/colocated jj repositories. For non-colocated jj, filesystem traversal includes hidden files but omits `.git`, `.jj`, `node_modules`, `vendor`, `dist`, `build` and `target` (it does not interpret jj ignore rules). Limits are 5,000 files, 32 MiB total and 2 MiB per file. Symlinks, hard links, submodules and unsupported entries cause refusal rather than partial approval. Code changes are detected when reviewing, submitting a verdict and completing a bundle; this is not a continuous filesystem lock. Ignore-policy changes or external writers can affect what is observable. Scope verification and repository policies still matter.

Bundle requirements, baselines, review attempts, evidence briefs and handoffs survive same-process conversation changes. A reset saves the old session/job references and a compact brief before switching. The new child receives the brief and original requirements and must reconcile them with current source. This cannot preserve facts that were never recorded. As in v0.3.0, a new parent process does not adopt the old family; previous records are retained for inspection.

### Updating from v0.3.1

Finish old work before restarting Pi. Existing sessions are not hot-migrated to the new role/report contract. Start a fresh main conversation with a concise handoff: permission filtering cannot remove code already in its transcript. The installed local path loads this source on restart. Keep a recoverable v0.3.1 revision until runtime verification is complete.

This version has had the configured TypeScript check and source formatting applied. The unit and live-model harnesses have been adapted to the new contract but have **not been run for v0.4.0**; prior v0.3.0 lifecycle results are not evidence for these new permission/review paths.

## Session lifecycle

Version 0.3.0 adds process-owned parent families. Restart existing Pi processes after updating; v0.2.0 children are not adopted. The lifecycle is covered by automated tests and the real-Herdr verification scripts below.

| Event                                                           | Behavior                                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Close the Herdr UI while the main Pi process remains alive      | Keep children and their work running.                                                                                 |
| Main Pi exits, normally or by a confirmed process death         | Idle children exit. Busy children finish the accepted request, save its report, then exit. New requests are rejected. |
| Parent liveness cannot be determined                            | Retain children and show an unknown-state indicator.                                                                  |
| Compact or reload the main conversation in the same process     | Preserve ownership and child sessions.                                                                                |
| Start a fresh main conversation through the handoff command     | Preserve children; carry a concise handoff and report acknowledgements.                                               |
| Start a new Pi process, including resume of an old conversation | Create a new parent family. Previous reports remain readable; previous children are never adopted.                    |
| A previous parent's child is still finishing                    | Keep its checkout reserved until it exits.                                                                            |
| Start ordinary Pi again in a former child pane                  | Start ordinary Pi. The child role is a one-use process launch argument, not a shell environment variable.             |

Parent checks run locally every two seconds. Normal main shutdown records its intent; abrupt exits are detected by PID, process start time and host. A timer does not imply an exact shutdown deadline. Blocked tools, approvals, provider errors, or a hung child can require manual attention. The extension does not force-kill unfinished work after a timeout. If the PC shuts down or the child is also killed, completing its request is not guaranteed.

`/repo-agents fresh <handoff summary>` starts a fresh conversation in the same main process. Include the goal, decisions, unresolved issues and next steps. Native conversation switching is guarded while child records remain, so ownership cannot silently move into an unrelated conversation. `/repo-agents continue <handoff summary>` repairs a same-process conversation handoff; it cannot take over another live main. Compaction does not require either command.

`/repo-agent-detach` in an idle child explicitly keeps that Pi process independent of parent exit. Its checkout remains reserved until it exits. The parent can no longer prompt or reset it. No automatic detachment occurs.

## Recovery and scope

A timeout or failed prompt submission may occur after text was delivered. The extension retains the registry entry and pane and does not resubmit automatically. Inspect structured status with `repo_agent_read` and inspect the actual child pane directly for raw details. Resolve trust/login questions directly in the child tab. A completed report describes a settled turn, not necessarily a successful task.

A cleanly exited child can be forgotten with `repo_agent_forget`. Its pane, reports and session files remain. A later parent may reserve that checkout after the old child process is confirmed dead. For interrupted launches or crashes, inspect the child pane and any commands it launched, then use `/repo-agents recover <relative repo path>`. Recovery checks parent and child process identities, launch expiry and the Herdr agent list; it refuses a live or unknown child and never kills processes. Recovery releases the reservation and preserves evidence. It does not resume or replay interrupted work. Unregistered background commands must be inspected separately.

`/repo-agents history` lists up to 50 parent runs for the current root, with report directories and retained agent/job IDs. It is read-only and does not adopt agents or wake a new model turn. Each agent directory contains `<jobId>.result.json` reports and session files. Older results remain available even after the parent exits.

State lives under `<Pi agent directory>/pi-herdr-multi-repo-subagents/`: a local SQLite ownership database and `runs/<root hash>/<parent run ID>/` files. It is outside code repositories. The supported storage is a local filesystem on one machine. Different Pi profiles have separate coordination databases; do not run them concurrently against the same checkout. A different Herdr server does not bypass checkout reservations within one profile. Previous v0.2.0 agents are not migrated: exit and forget them using that version before using this version on those checkouts.

This is coordination with model-tool restrictions, not an OS sandbox. Implementer and Verifier still have ordinary execution privileges; read-only roles and the managed Orchestrator use restricted tools. User-issued shell commands, another extension’s own code, and external programs are outside those restrictions. Repository scope is validated for launching and described in the task; it does not prevent access to other paths or prevent manually launched processes from editing the checkout. The extension never fabricates Herdr caller context. Removing the package does not delete retained reports or session files.

## Development and distribution

```sh
npm ci
npm test
npm run typecheck
npm pack
```

The package has no runtime dependencies beyond Pi-provided peers. `pi` manifest paths and an npm file allowlist limit the archive to the extension, documentation, license and example generator. Do not publish without selecting your own package ownership and version.

Generate an isolated example (requires Git and jj):

```sh
node scripts/create-demo.mjs /absolute/path/to/new-demo-project
```

The generator refuses an existing project directory. It creates a metadata jj repository plus two independent code repositories with local baseline commits and no remotes. The baseline timeout tests intentionally fail until the delegated agents implement the contract. Start Pi in the generated task directory inside Herdr.

## Design references

[Pi extension lifecycle](https://pi.dev/docs/latest/extensions), [Pi packages](https://pi.dev/docs/latest/packages), and [Herdr agent automation](https://herdr.dev/docs/agent-automation/) define the integration contracts.

[pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents/tree/7180d986a712e7627986a147ca8e5d5a4e0265da) was reviewed for lifecycle separation and asynchronous delivery ideas. This implementation is independent and does not install that package, include its agent bundles, or route to other harnesses.

Run the optional real-model integration test from inside Herdr after generating a fresh fixture:

```sh
npm run test:live -- /absolute/path/to/new-demo-project/DEMO-001-shared-timeout /absolute/path/to/evidence
```

This invokes your authenticated Pi model and uses its allowance/billing. It leaves the demo panes open. `PI_TEST_MODEL` optionally selects a model; `PI_TEST_TIMEOUT` changes the per-stage timeout (default 300,000 ms).

After the integration test completes, run the lifecycle checks in the same test Herdr session:

```sh
node scripts/test-lifecycle-live.mjs /absolute/path/to/evidence
```

Use a dedicated named Herdr session and a generated fixture. This test starts actual Pi processes with the installed package, exercises conversation handoff and duplicate ownership, kills its recorded test parent to simulate a crash, and checks idle exit, busy completion, new-parent isolation, normal shutdown and ordinary Pi reuse of a child pane. It invokes the configured model and retains evidence. Never point it at a working project.
