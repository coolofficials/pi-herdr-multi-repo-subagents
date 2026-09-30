# pi-herdr-multi-repo-subagents

Coordinate overall requirements through a task-root Orchestrator, scoped execution through Task Leads, and independent task/project reviews. Children run in visible Herdr panes and return bounded structured briefs. The Orchestrator cannot use arbitrary source-reading, editing or shell tools. Repository children load applicable AGENTS.md normally; response language and project policies remain outside the package.

## Setup by an agent

For installation, configuration, optional integrations, updates and recovery,
start with [the agent setup guide](docs/agent-setup.md). The root `AGENTS.md`
provides an entry point for agents. Both files are included in package distribution.
The guide distinguishes local source features from actually published versions
and preserves existing settings and active sessions.

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

## Session identity and concurrent work

The main session is named `Orchestrator`, regardless of how many tasks it coordinates. Child session names are `Role · task title` (Oracle uses the project title). These automatic names are presentation metadata, not new agent sessions.

A local widget above the editor separates identity, assignment, execution state and direct children. For example:

```text
[Task Lead] Task: Prepare release artifacts
State: waiting for 2 children | Reports to: Orchestrator
  → Implementer [agent-id] | repos/app | running
  → Scout [agent-id] | repos/api | running
Children: 2 pending · 0 attention · 0 reported
```

The compact footer repeats only this agent's role and current state. Implementer and other repo workers also show their repository and report recipient. The Orchestrator shows its root scope and active/completed task counts instead of implying that it owns just one task. Up to three pending/attention children are shown, with attention first and a remaining count; the board retains the full roster. Long labels are bounded. `reported` means a child has returned a report, not that an entire task or project has passed its review gate.

Different checkouts can run concurrently. The Orchestrator can delegate several Task Leads before their results arrive; each Lead can delegate multiple workers in its assigned repositories. Mutating dispatch uses a process-safe SQLite lease to protect coordination state, while accepted jobs execute independently. Competing calls wait locally (up to 120 seconds) for the lease; they do not ask the model to retry or repeat a submitted operation. Automatic view cleanup skips a busy lease and tries again on a later tick. Unknown owners are retained; only confirmed dead owners can be replaced. Unfinished tasks sharing a checkout are rejected and must run sequentially. Cross-repo dependencies still need an explicit task order.

Status refreshes use local durable job state (about 2 seconds in children / 3 seconds in main), independently of automatic-report delivery acknowledgements. They do not invoke the model or add status text to its context. A waiting manager receives automatic reports and resumes; no polling tool is required. The UI is an eventually consistent snapshot, not a guarantee that every transition is shown instantly.

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

Paths are literal paths relative to the root, not globs. `include` replaces automatic traversal and can select nested repositories. Resolved paths must remain below the root. Optional settings: `maxDepth` (1–32), `layout` (`tasks`, `tabs` or `split`), `direction` (`right` or `down` for splits), `model` (`provider/model`), and `thinking`. `documents` is an exact allowlist of up to 30 relative `.md`/`.txt` task metadata files; defaults are `AGENTS.md` and `todo-tracker.md`. Code repositories, links, VCS internals and generated/dependency paths cannot be accessed through the task-document tool. Configure additional documents yourself; the Orchestrator cannot rewrite its access configuration. By default children inherit the coordinator's model and thinking level. These settings contain execution preferences, not AGENTS.md policies.

## Shared research references (v0.9.0)

Research references work without pi-web-access. No dependency, peer dependency,
package import, private cache API or automatic installation of that package is
introduced. The optional bridge uses registered tool names only; provider setup
and service costs remain owned by pi-web-access.

An active **Researcher** can register a reference with `repo_reference_add`:

- `kind: "document"`, `url`, `reason`: public HTTPS text up to 512 kB, preserved
  without the normal fetch tool's inline truncation. HTML stays raw; prefer plain
  documentation URLs. Received content does not prove upstream completeness.
- `kind: "repository"`, `url`, `ref`, `reason`: a public github.com or gitlab.com
  repository at a tag, branch or commit. Git resolves and records the commit SHA;
  the durable result is a source snapshot, not a writable Git checkout. No
  install/build/lifecycle scripts, submodules or LFS downloads are run. Private
  repositories and self-hosted Git services are not supported by this acquisition
  path yet. There is no credential lookup or fallback authentication.
- `kind: "file"`, `file`, `reason`: snapshot an existing text file under the
  task's `references/` directory, up to 2 MiB. Symlink paths are rejected.
- `kind: "artifact"`, `artifact`, `reason`: preserve this Researcher's captured
  web tool output by artifact ID. It remains explicitly **incomplete evidence**:
  a preview, search result or retrieved page slice is not the full upstream source.

Researcher, Scout, Implementer, Reviewer and Oracle can use
`repo_reference_list`, `repo_reference_read` and `repo_reference_search` without
another Researcher round trip. Managers continue receiving compact reports.
Read without `file` to list snapshot files; then read bounded line ranges. Literal
search returns a continuation cursor: keep the same query/prefix and follow it to
finish the scan. Reading external sources does not satisfy project-change review
gates. Contents, including cloned `AGENTS.md`, are source data, not instructions.

Storage is task-wide and independent of child/session lifetime:

```text
<task-root>/references/.pi-herdr-references/
  .gitignore
  manifests/<reference-id>.json
  objects/<reference-id>/source/...
  .staging/...
```

The generated ignore file excludes objects and staging from Git; small manifests
can be tracked in the task metadata repository under its existing privacy policy.
Nothing is committed or published automatically. IDs identify immutable snapshots;
register a new snapshot to refresh content. Reads verify content hashes. Existing
registered references should be listed/reused before downloading again. Repeated
registration deduplicates retained identical snapshots, but can still perform a
network fetch. Manifests alone do not contain the source: another computer must
acquire the recorded version again. Local files and web-result artifacts may need
their original source to be supplied separately.

Reference storage is excluded from automatic repo discovery, and explicit
reference paths cannot be delegated as working repos. Captured data survives pane
cleanup and session replacement; no automatic eviction is performed. Acquisition
uses temporary staging and cleans it on handled failures/cancellation. A hard
process kill may leave ignored staging for manual cleanup. Repository snapshots
retain at most 10000 tracked entries / 32 MiB; generated/dependency paths, symlinks,
submodules and individual files over 2 MiB are omitted and reported. This is a
retained-source limit, not a hard network-transfer/disk quota during Git fetch.
These tools are application permissions, not an OS sandbox.

### Optional pi-web-access bridge

Install pi-web-access separately into the Pi profile used by the children, then
merge this setting into **the task root's** `pi-herdr.json`:

```json
{
  "research": { "webAccess": true }
}
```

Default is `false`. When enabled and the tools are registered, active Researchers
may use `web_enable`, `web_search`, `fetch_content` and `get_search_content`.
The tool-call gate continues blocking other roles and unknown tool names, even if
another extension makes those tools visible. Renamed web tools are not supported
by this bridge. Researcher fetches accept HTTPS URLs, not local video/file uploads.
Missing pi-web-access produces no startup dependency error: known-URL retrieval,
local imports and repository snapshots still work. The bridge discovers current
registered tools at each turn so lazy activation does not grant extra permissions.

Web results are captured in the Researcher's artifacts and bounded for the model.
The temporary web response ID is retained for paging, while important findings
must be registered as durable references. The bridge does not access private web
cache paths or promise that a captured result contains all source content.
Configure approved providers, bounded results and `workflow: "none"` in
pi-web-access for ordinary research; automatic summaries or model-backed providers
can add model/service cost. Its temporary GitHub clones are not a replacement for
our versioned references; prefer `repo_reference_add` for persistent source
inspection without shell access.

Static integration was developed against pi-web-access 0.32.0 default tool names.
Runtime co-execution and full Pi/Herdr scenarios have not been verified for v0.9.0.

## Role-specific models (v0.8.0)

From the main Pi pane, run `/repo-agents models`. Choose **User profile** or
**This task**, then a role, model, and thinking level. **Save** writes the draft;
**Cancel** or Escape at the role list discards it. **Inherit both** removes that
scope's override. Orchestrator continues to use Pi's own model selector.

The menu lists registered models with configured authentication and the selected
model's supported thinking levels. It shows effective values and their source.
Profile editing previews the profile independently; task overrides may still
apply. Inherited values in this menu preview the main Pi model; a worker launched
by a Task Lead inherits that Lead's model instead when no override applies. Choosing a model does not change thinking automatically: select a
supported level explicitly if the inherited level is incompatible.

- Profile file: `~/.pi/agent/pi-herdr-models.json`, or
  `$PI_CODING_AGENT_DIR/pi-herdr-models.json` with a custom Pi profile.
- Task file: `pi-herdr.json` in the main Pi root. Existing discovery, layout and
  document settings are preserved when saving.
- Model and thinking resolve independently: **task role → task default → profile
  role → profile default → requesting parent's current value**.
- Model IDs must match the registry's exact `provider/model` ID; no fuzzy matching
  or replacement model is used. Unknown roles and malformed values are errors.
- Saving is local extension code, with no model invocation or conversation entry.
  Concurrent menu saves reject stale drafts. A small `.lock/operation.sqlite`
  beside the settings file coordinates saves; keep this runtime lock out of VCS.

Both files accept `model`, `thinking`, and `roles`. Only the task file also accepts
repository discovery/layout settings. Example (use model IDs available on your PC):

```json
{
  "roles": {
    "task_lead": { "model": "openai-codex/gpt-5.5", "thinking": "medium" },
    "implementer": { "model": "openai-codex/gpt-5.5", "thinking": "medium" },
    "reviewer": { "model": "openai-codex/gpt-5.5", "thinking": "high" },
    "oracle": { "model": "openai-codex/gpt-5.5", "thinking": "high" },
    "scout": { "model": "openai-codex/gpt-5.5", "thinking": "low" },
    "researcher": { "model": "openai-codex/gpt-5.5", "thinking": "low" }
  }
}
```

This example illustrates the schema, not a cost/quality recommendation. No model
assignments are installed automatically. Omit fields to inherit; do not use `null`.
A task-level common `model` overrides profile role models, so omit it when you
want profile role routing to apply.

### Applying changes

Running conversations and reused workers keep their models. New child launches
resolve settings before opening a pane and reject unavailable models or unsupported
thinking. The parent also checks the actual child model/thinking before submitting
work, so CLI fallback cannot silently run a different model.

An idle child's new conversation (`/new`, including `repo_agent_reset`) reloads
settings. Its inherited fallback is the parent's model/thinking captured at that
child's original launch. A checkpoint/compaction or `/reload` in the same
conversation does not change models. If accepted work is still pending, changing
conversation does not apply new routing mid-job. Invalid settings at a fresh
conversation cause a visible initialization error and shutdown; inspect the pane
and fix the settings before recovery.

The board displays the selected agent's actual model/thinking and a next-session
preview when settings differ; the details view includes source information.
The preview uses the inherited values recorded at launch. A future new launch
from a different parent model can therefore differ from the preview. Older
agents without model metadata are shown as unknown. Registration/authentication
checks cannot guarantee provider availability, quota, or successful requests.

## Hierarchy (v0.6.1)

```text
Orchestrator (requirements and overall coordination)
  Task Lead A (one coherent task, possibly several repositories)
    Implementer(s) (repository work and assigned checks)
    Reviewer (independent inspection of the whole task)
  Task Lead B
    Implementer(s)
    Reviewer
  Oracle (independent overall/integration review)

Scout / Researcher: optional context collection for either manager.
```

Orchestrator and Task Lead are read-only with respect to product code. They cannot use shell, raw source, diff, edit/write, or unknown extension tools. They advance scoped workflow records through dedicated tools. Orchestrator owns overall requirements, task assignments and approved task-root documents. A Task Lead owns only its task's decisions and execution loop; it cannot revise acceptance criteria, create other leads, or call Oracle. It must escalate scope/contract changes.

Scout (formerly Explorer) reads local code. Researcher (formerly Librarian) reads local references and bounded public HTTPS sources; there is no bundled general web search engine. Reviewer and Oracle read actual artifacts but cannot run commands or edit. Implementer performs implementation and explicitly assigned execution checks. No separate Verifier is needed in this hierarchy.

Role permissions are selected at session/job boundaries and checked by tool hooks. A child has a fixed role and task/project for its lifetime. Implementation and review use **separate panes/conversations**. Reset refreshes the same role, not a role switch. No role bundles, multi-harness routing or automatic commits/publication are supplied.

### Automatic execution routing (v0.10.0)

Orchestrator chooses the execution path using the current request and known facts.
There is no classifier agent, consensus vote, numeric difficulty score or mandatory
repository survey. Bounded, clear, reversible work with a direct result check uses
**single execution**. Consequential/uncertain behavior, public/shared contracts,
security/permissions/data changes, coupled cross-repository behavior, or an explicit
independent-review requirement uses **reviewed execution**. File/step/repository count
alone does not determine the route. Unknowns may first be inspected by one bounded
single worker, which escalates before risky changes. This is model judgment; tooling
cannot prove that hidden effects were recognized.

For single execution, Orchestrator calls:

```json
{
  "action": "create",
  "title": "Update local display text",
  "requirements": "Change the specified text and confirm the requested value.",
  "repos": ["repos/app"],
  "executionMode": "single",
  "executionReason": "Local reversible change with a direct result check"
}
```

`repo_work create` returns `executionRepo`, task `id` and `project`. Project is optional
for single creation; the tool creates a standalone project if omitted, and completes
it together with the single task after its evidence passes. Start ONE `implementer` at that
`executionRepo` with `bundle=id`. No Task Lead, Reviewer or Oracle is created for this
path. Several assigned repositories can share one root executor. Omit `repos` only
for task-root administrative operations, such as preparing directories or cloning
repositories. These operations have no product-code baseline and must not silently
expand into code edits; code work needs a new scoped repository task before editing.
Do not use this mode to circumvent scoped mandatory reviews.

The worker confirms only the requested outcome, reports actual checks and evidence
references through `repo_agent_report`, and returns a compact report directly to
Orchestrator. Builds, tests, research and source surveys are not obligatory. The main
calls `repo_work complete` after the report settles. Single completion is explicitly
**not independent approval**. Repository receipts bind changed files, declared file
references, instructions and the current project/task contracts; unrelated files
remain outside that receipt. This is not a complete dependency graph. Root operation
receipts rely on reported operation evidence and do not continuously verify cloned
repository contents. An all-single project finishes through `repo_project complete`
without Oracle. A project containing any reviewed task still requires Oracle PASS.

If risk/scope/uncertainty exceeds the chosen route, a direct Implementer calls
`repo_execution` with a concise reason before further edits. The hook blocks further
execution and completed reports for that job; the worker reports incomplete. This
escalation does not start another agent. Orchestrator calls `repo_work promote` with
`executionReason` for an existing repository task, preserving its original baselines,
execution evidence and review budget. Resume the same worker only for unfinished work
or remediation. Once it reports readiness, call `repo_request_review` with the **task**
ID to attach an independent Reviewer directly, then `repo_work complete` after PASS.
A Task Lead is not inserted retroactively. Requests with a project ID still dispatch
Oracle. Reviewed work cannot be downgraded to single. Subsequent user refinements to a
direct task go through Orchestrator so scope and mode remain recorded.

The board and child status widget show the selected mode; the board includes its
one-line reason. Legacy tasks and calls omitting `executionMode` retain reviewed
gates. Existing sessions are not migrated or restarted. Policy enforcement is within
Pi tools/hooks, not an OS sandbox; shell commands, external writers and semantic
misclassification remain limitations.

### Reviewed completion protocol

1. Orchestrator creates `repo_project` with overall requirements, then `repo_work` tasks containing a goal, acceptance criteria, repository set and verification ownership. Baselines are captured before implementation. Start a `task_lead` at `repo: "."` for each task, passing its task ID as `bundle`.
2. Task Lead delegates to Implementers in its assigned repositories. It judges readiness **from their conversations and completed reports**, not from reading code. When the coherent task is ready, call `repo_request_review` with the task ID and a concise readiness reason.
3. That tool validates completed Implementer reports and classified inputs, records candidacy, and starts/reuses an independent Reviewer in a separate pane. An existing pending review or valid approval prevents duplicate dispatch. Reviewer inspects actual changes and evidence. Findings return to Lead, which batches remediation and requests re-review when ready. There is no review after every individual edit.
4. Lead submits `repo_agent_report outcome=completed`. The tool checks current independent Reviewer PASS and idle members. When the turn settles, it rechecks approval and commits task completion; a draft invalidated by subsequent tool use does not prematurely complete the task. Separate model calls to mark candidate/complete are unnecessary. Blocked/incomplete reports do not require approval.
5. After all required Leads deliver approved completion reports, Orchestrator calls `repo_request_review` with the project ID and its readiness reason. It checks those reports and dispatches Oracle in a separate pane.
6. Oracle evaluates overall acceptance and actual integration boundaries using valid task approval evidence. Findings return to Orchestrator, which revises/reopens affected tasks and resumes their Leads. Only `repo_project complete` with a current Oracle PASS authorizes overall completion.

The manager's judgment starts review; it does not substitute for independent approval. A settled model turn is not task or project completion. The extension gates state transitions and structured reports, not every natural-language sentence a model might write. If dispatch is uncertain, inspect the retained agent before retrying; the tool never blindly resubmits.

A Lead ending a turn without a report remains in `waiting_children` only while it has actual pending children. With no pending children, or a confirmed child interruption, it produces `needs-report` so its parent can request clarification or repair. It cannot silently remain busy forever just because it omitted a brief. Child reports wake only the immediate manager.

### Direct input in the Task Lead pane

Use the **Task Lead pane** for questions and minor adjustments. Each input gets a durable local receipt. `repo_task_input` lets Lead list/read receipts and classify them:

| Kind         | Effect                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `question`   | Answer locally; preserve requirements, decision versions and existing approval.                                                          |
| `refinement` | Accept an in-scope adjustment, append a compact decision, and invalidate the old task approval. Delegate the actual edit to Implementer. |
| `escalation` | Record the decision needed and block further advancement until Orchestrator revises/reopens the task.                                    |

Receiving input alone does not invalidate approval. Unclassified input temporarily blocks new delegated work, candidacy and completion; classification as a question releases the block without another review. Classification is model judgment. A hook cannot prove that a requested change was correctly distinguished from a question.

Input may arrive during review. Questions can be answered, but accepting a refinement must wait until the active review settles. The receipt remains pending and readable; the user need not submit the same request again. Completed work accepts questions; changes require escalation and explicit reopening by Orchestrator. Raw input stays in the Lead conversation/local evidence and is not automatically forwarded upward.

Changes to overall requirements, acceptance criteria or cross-task contracts must be escalated. This release adds no queue or steering UI. Free-form input in managed Implementer panes is rejected to avoid untracked mutations; use Lead for reviewed hierarchical tasks or Orchestrator for direct tasks. User shell commands and independently launched processes remain outside the tool policy.

### Tools

| Tool                                              | Scope                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `repo_agent_list/start/prompt/read/reset/forget`  | Only the caller's directly managed children; role and task restrictions enforced                   |
| `repo_agent_recover`                              | Lead: own direct children; Orchestrator: its family, including grandchildren; confirmed exits only |
| `repo_project create/list/status/complete/revise` | Orchestrator: overall requirements and Oracle completion gate                                      |
| `repo_work create/revise/complete/promote`        | Orchestrator: assign or reopen a task, preserving baseline and review budget                       |
| `repo_work list/status`                           | Orchestrator: tasks; Lead: only its assigned task                                                  |
| `repo_request_review`                             | Lead: validate readiness and request Reviewer; Orchestrator: request Oracle                        |
| `repo_task_document`                              | Orchestrator: configured task-root metadata allowlist                                              |
| `repo_task_note`, `repo_task_input`               | Lead: bounded decisions and direct-input receipts/classification                                   |
| `repo_source`, `repo_research_fetch`              | Scoped child source/research access according to role                                              |
| `repo_review_changes`                             | Reviewer/Oracle: repository roster and paginated before/after content                              |
| `repo_review_scope`                               | Reviewer: additional dependency files or conservative whole-repository scope                       |
| `repo_agent_report`                               | Child: bounded result to immediate manager; Lead completion also enforces the approval gate        |

Oracle can retrieve one task's requirements, notes or review brief with `repo_review_changes evidenceTask=<id> section=requirements|notes|brief`, paginated using `offset`. The roster does not concatenate every task's detailed evidence.

### Context, cost and approval validity

- Reports wake only the immediate manager. Implementer/Reviewer exchanges do not directly wake Orchestrator. Local monitoring invokes no model. End the turn when only waiting; there is no `repo_agent_wait`.
- A child receives the assigned task/context (combined maximum 16,000 characters), requirements and relevant saved decisions, never its parent's full conversation. Structured reports are limited to 6,000 JSON characters and main/Lead response batches to 18,000 characters. These are character limits, not token limits.
- Keep Task Lead reports about outcomes, decisions, blockers and remaining risk. Code, raw logs and diffs stay in worker/review contexts. Missing reports do not fall back to raw transcripts.
- Each task and each project has an initial review plus two re-reviews by default. The user may explicitly extend a budget from the main pane with `/repo-agents extend-review task <task-id>` or `/repo-agents extend-review oracle <project-id>`. No model tool can extend its own budget.
- Reviewer PASS requires inspection of all pages of baseline changes plus evidence references. Unchanged files inspected in the previous review can retain their coverage; changed files require renewed inspection. Incremental `since=previous_review` helps locate changes, but baseline pages establish coverage for changed files. This checks access provenance, not semantic review quality.
- Oracle must inspect real changes in each changed repository and evaluate integration evidence; it need not repeat every local file review. The tool can enforce actual access and current state, not prove that integration reasoning or reported verification is correct.
- Approvals bind to task requirements/decision versions, project requirements revision, and artifact fingerprints. Unclassified/escalated input blocks completion. Oracle completion rechecks the task approval set and current artifacts.
- Each task has 1–12 repositories; a project has at most 32 tasks. Unfinished tasks sharing a repository are serialized. Implementers keep exclusive checkout reservations; read-only Leads/reviewers/research can coexist. Approved task completion retires idle Implementers so another task can acquire the checkout. Panes/reports remain. Reopened work needs a new Implementer after forgetting the exited one.
- Task approvals cover changed files plus dependencies recorded from Reviewer source reads/search matches and explicit `repo_review_scope` declarations. Deletions/absent paths and file modes are included. Later task B changing unrelated files in the same repo preserves task A's approval if its recorded files and requirement/decision versions remain unchanged. Final Oracle review is still required.
- Reviewer declares additional configuration, schema, contract or dynamic-discovery dependencies. Use `wholeRepositories` when the dependency scope cannot be narrowed safely. A changed recorded dependency invalidates approval; re-review must inspect or explicitly re-evaluate it. Scope records stay on disk; parent reports do not contain the file map.
- This is an observed/declared dependency set, not a complete static dependency graph. Negative searches and newly added dynamically discovered files are not inferred automatically. Missing dependency declarations may defer defect discovery to Oracle. During an active review, whole assigned repository fingerprints must stay stable. Oracle approval always covers complete supported repository snapshots and the task approval set.
- Context isolation does not guarantee lower total cost: Leads, independent review and fresh implementation contexts add work. This version has no measured savings or quality benchmark.

Snapshots include tracked and non-ignored untracked files for Git/colocated jj. Non-colocated jj uses bounded filesystem enumeration, skipping VCS/dependency/build directories rather than interpreting jj ignore rules. Limits remain 5,000 files, 32 MiB total and 2 MiB per file. Unsupported links/submodules cause refusal, not partial approval. External writers and ignore changes remain observable-scope limitations; snapshots are not a continuous filesystem lock.

### Updating

Finish old work before restarting Pi. Earlier role-switching or hierarchy sessions are **not automatically migrated**. Start a fresh main process/conversation with a concise handoff. This installed local checkout is loaded on restart; `/reload` may retain imported modules. The local `pre-consistency-v0.5.0` bookmark preserves the source before these changes. Do not hot-reload this update into active work.

v0.6.1 fixes a live-discovered race: parallel Reviewer/Oracle inspection tools could overwrite each other's coverage records, causing a false missing-inspection rejection and unnecessary re-review. A per-session queue now serializes evidence updates and PASS validation.

Automated tests cover lifecycle controls, role restrictions, pending Lead reports, input classification, approval dependencies, parallel inspection and interrupted recovery retry. TypeScript and formatting checks are also configured; `checkJs` remains disabled globally. Real Pi/Herdr checks use generated fixtures on a dedicated named server. They exercise hierarchical completion, unrelated-file approval reuse, final Oracle, direct Lead input, missing reports, nested recovery and parent-exit draining. These small-fixture checks do not establish general review quality or cost savings.

## Session lifecycle

Process identity still owns each family. Task Leads have separate coordination scopes and immediate child registries; every descendant also observes ancestor identities. Root exit prevents new work throughout the tree. Busy leaves finish accepted jobs and save results; Leads drain accepted children and record interrupted coordination before exiting. Lead exit drains its own subtree. No new process automatically adopts an old family. Nested draining and recovery have been exercised in isolated real Pi/Herdr sessions; no exact shutdown deadline is promised.

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

A cleanly exited child can be forgotten with `repo_agent_forget`. Its pane, reports and session files remain. A later parent may reserve that checkout after the old child process is confirmed dead. For interrupted launches or crashes, inspect the child pane and any commands it launched, then use `/repo-agents recover <agent ID or relative repo path>`. Recovery checks parent and child process identities, launch expiry and the Herdr agent list; it refuses a live or unknown child and never kills processes. Lead may recover its own direct children from its pane or with `repo_agent_recover`; Orchestrator may recover its family's descendants even while their Lead remains alive. Recovery records interruption, retires the matching task member, removes the registry entry and releases the reservation while retaining evidence. A durable journal allows an interrupted cleanup to be retried by exact agent ID. Recovery does not create a successful report/PASS or resume/replay interrupted work. Unregistered background commands must be inspected separately.

`/repo-agents history` lists up to 50 parent runs for the current root, with report directories and retained agent/job IDs. It is read-only and does not adopt agents or wake a new model turn. Each agent directory contains `<jobId>.result.json` reports and session files. Older results remain available even after the parent exits.

State lives under `<Pi agent directory>/pi-herdr-multi-repo-subagents/`: a local SQLite ownership database and `runs/<root hash>/<parent run ID>/` files. It is outside code repositories. The supported storage is a local filesystem on one machine. Different Pi profiles have separate coordination databases; do not run them concurrently against the same checkout. A different Herdr server does not bypass checkout reservations within one profile. Previous v0.2.0 agents are not migrated: exit and forget them using that version before using this version on those checkouts.

This is coordination with model-tool restrictions, not an OS sandbox. Implementers still have ordinary execution privileges; read-only roles and the managed Orchestrator use restricted tools. User-issued shell commands, another extension’s own code, and external programs are outside those restrictions. Repository scope is validated for launching and described in the task; it does not prevent access to other paths or prevent manually launched processes from editing the checkout. The extension never fabricates Herdr caller context. Removing the package does not delete retained reports or session files.

## Development and distribution

```sh
npm ci
npm run typecheck
npm test
npm run format:check
```

`npm run test:live -- TASK_ROOT EVIDENCE_DIRECTORY` runs the current hierarchy scenario inside a dedicated Herdr pane against a fresh `create-demo.mjs` fixture. It starts actual model sessions using installed Pi settings, retains panes/evidence, and checks two task approvals, approval reuse, final Oracle and bounded manager permissions. Use a separate named Herdr test server; close only the test-owned processes afterward. The saved launch prevents blind resubmission on retry. `npm pack` runs prepack checks, including unit tests; it does not run model-backed live tests.

`node scripts/test-routing-live.mjs /absolute/new-fixture-directory` creates isolated
Git fixtures and runs four actual Pi/Herdr routing scenarios: natural clone and
documentation requests, an explicitly induced review escalation, and the reviewed
Task Lead workflow. Run inside a genuine dedicated Herdr pane with a separate Pi
profile configured to load this checkout and a usable provider. These model calls
consume provider usage. Saved launch intents prevent blind prompt resubmission;
inspect retained evidence after a failure. This is a bounded behavior check, not
a classification accuracy or cost benchmark.

The package has no runtime dependencies beyond Pi-provided peers. `pi` manifest paths and an npm file allowlist limit the archive to the extension, documentation, license and example generator. Do not publish without selecting your own package ownership and version.

Generate an isolated example (requires Git and jj):

```sh
node scripts/create-demo.mjs /absolute/path/to/new-demo-project
```

The generator refuses an existing project directory. It creates a metadata jj repository plus two independent code repositories with local baseline commits and no remotes. The baseline timeout tests intentionally fail until the delegated agents implement the contract. Start Pi in the generated task directory inside Herdr.

## Design references

[Pi extension lifecycle](https://pi.dev/docs/latest/extensions), [Pi packages](https://pi.dev/docs/latest/packages), and [Herdr agent automation](https://herdr.dev/docs/agent-automation/) define the integration contracts.

[pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents/tree/7180d986a712e7627986a147ca8e5d5a4e0265da) was reviewed for lifecycle separation and asynchronous delivery ideas. This implementation is independent and does not install that package, include its agent bundles, or route to other harnesses.

`scripts/test-live.mjs` and `scripts/test-lifecycle-live.mjs` are historical v0.3/v0.4 harnesses, retained as references. Do not execute them against the current role contracts or ongoing work. The current entry point is `scripts/test-hierarchy-live.mjs`. Destructive lifecycle scenarios require a dedicated disposable fixture and test process identities; never target a user's working family.

## Board lifecycle correction (v0.9.1)

The board belongs to the main pane. A new main process in the same task root,
Herdr socket and pane reuses a recorded board pane after its previous owner is
confirmed dead and the pane is an idle shell. Board creation is serialized across
runs; uncertain topology or an occupied previous board prevents another split.
A board now exits when its owner releases coordination or is confirmed dead.
Reports and sessions remain accessible through `/repo-agents history`.

Older boards do not have the new owner-exit behavior. Press `q` in the old board
before starting the replacement, then use `/repo-agents board` if initialization
reported that the pane was occupied. Existing extra splits are not automatically
closed. The extension does not commandeer unrelated processes or migrate child
ownership between runs. Finished task tabs and the main board have separate
lifecycles.

Task tabs group a **task**, not a repository: one task can include several repos
and its Lead/workers share the tab. Repo cwd belongs to the individual worker.
Legacy `layout: "split"` directly splits the caller pane; use `layout: "tasks"`
for task tabs. Existing families need to finish before a new process applies a
layout/source update.

Board launch now waits for a process readiness record instead of marking a pane
open immediately. `board-error.json` records board initialization errors;
`startup-error.json` in an agent directory records child launch/submission failures.
Herdr JSON error codes/messages are retained in the reported error instead of
only the command exit status. The exact reported user startup message has not
been identified. v0.9.1 has static checks only; no new live Pi/Herdr scenario or
automated tests have been run for this correction.

## v0.7: bounded context and task views

The default layout is `tasks`: one tab per task, with the Lead and the workers it
actually needs (maximum four visible panes per task tab). The main tab receives
one right-hand board. Set `board: false` to disable it; `layout: "split"` and
`layout: "tabs"` retain the older layouts. Explicit legacy configuration is not
silently rewritten. A capacity error preserves all panes; finish or explicitly
close idle work before requesting more concurrent roles.

The board reads durable state directly, without model calls. Arrow keys select;
Enter focuses a live agent; `d` shows its report and evidence/session paths; `k`
toggles keeping its pane; `a` toggles completed history; `r` accepts a follow-up
request for the Orchestrator; `q` exits the board. `/repo-agents board` opens a
missing board. A follow-up is a user request, not automatic approval or adoption
of an old parent's agents.

After reviewed task completion and its Lead's settled report, or direct task
completion from its settled Implementer evidence, idle owned agents
exit and their shell panes close. Reports, verification artifacts and sessions
remain. Unknown processes, active jobs, detached agents, user-kept panes and
shells with background children are retained. Cleanup closes individual verified
panes, never a tab containing unrelated terminals. Direct child input marks its
pane kept. Same-scope `repo_agent_start` reuses an idle live agent; a cleanly exited
same-role pane can be reused after checking its identity. `/new`/reset refreshes a
conversation without adding another pane.

Scout/Researcher jobs do not wait for a task's code-review gate. A settled structured
research report must first be queued to the immediate manager (or read by it); then
the idle owned agent retires and its verified shell pane closes. Delivery is recorded
for the specific job and parent, and does not mean the model has assessed the report.
Missing reports, running jobs, unknown ownership and kept/detached panes are retained.
Entering text in a finished research pane keeps it and shows its actual manager;
it does not start an untracked model turn. Request further research through that manager.

### Contracts and progress

On `repo_project create`, explicitly declare `progressDocuments`, e.g.
`["todo-tracker.md"]`, only for task metadata containing status. There is no
filename-based exemption. Requirements belong in versioned project/task
contracts; instruction files and repository files cannot be declared as progress.
Reviewer reads of declared progress do not create code approval dependencies.
Other observed/declared dependencies and supplied scoped AGENTS.md files do.
External progress edits block advancement until the Orchestrator reads and
classifies them using `repo_task_document reconcile` with a reason. Requirement
changes must first revise the affected contract. Classification is model judgment;
the extension enforces acknowledgment and approval gates, not semantic truth.

`repo_work status` returns the invalidation reason and recovery action.
`repo_work reopen_review` preserves requirements, baseline, execution records and
review budget for approval-only recovery. Use `revise` for changed requirements.
Repeated review requests with unchanged semantic requirements and artifact
candidates are bounded independently of session/job IDs.

### Evidence and context

Large native Implementer tool results are replaced by bounded head/tail excerpts.
Their captured tool result is retained under an artifact ID for `repo_artifact`
queries. Native tools may already have truncated output: a captured result is
not a promise that the original shell log is complete. `repo_check` runs an
Implementer's authorized check in its assigned checkout, records exit status and
up to 8 MiB of output, and reports truncation explicitly. Checks are never
implicitly rerun or cached across changes to unknown external/environment inputs.

Review diff pages retain their existing complete-file coverage requirements.
Root Reviewers/Oracles must address sources with assigned task-relative paths
(e.g. `repos/api/file.ts`); choosing `scope: "repo"` at the task root does not
implicitly select a repository. Task Leads and Orchestrators cannot read code.
Applicable root-to-repository AGENTS.md files are explicitly delivered to root
roles; their aggregate input is capped at 24000 characters without silent loss.

A missing report receives at most one automatic **report-only** continuation in
the same job/review attempt. No implementation/check tools are available in that
continuation. Insufficient evidence requires an incomplete/unknown report.

`repo_checkpoint` stores a concise handoff, then applies a Pi compaction at the
next settled boundary. It retains the same job, role, artifacts, review attempt
and parent ownership; it does not allocate a pane or reset budgets. A Lead waiting
for children stays waiting. This is a durable context replacement within the same
Pi session, distinct from `/new`, which starts another conversation after a job
settles. The handoff must preserve decisions, evidence IDs, unresolved findings
and the next action. Context-pressure indicators start at 48k/64k input tokens or
25%/35% of a smaller model's context window. Cumulative cache-read volume alone
never forces a rotation. These controls reduce avoidable input; they do not
guarantee cost reduction or that a model's summary preserves every relevant fact.
