# pi-herdr-multi-repo-subagents

Coordinate overall requirements through a task-root Orchestrator, scoped execution through Task Leads, and independent task/project reviews. Children run in visible Herdr panes and return bounded structured briefs. The Orchestrator cannot use arbitrary source-reading, editing or shell tools. Repository children load applicable AGENTS.md normally; response language and project policies remain outside the package.

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

## Hierarchy (v0.5.0)

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

### Completion protocol

1. Orchestrator creates `repo_project` with overall requirements, then `repo_work` tasks containing a goal, acceptance criteria, repository set and verification ownership. Baselines are captured before implementation. Start a `task_lead` at `repo: "."` for each task, passing its task ID as `bundle`.
2. Task Lead delegates to Implementers in its assigned repositories. It judges completion candidacy **from their conversations and completed reports**, not from reading code. When the coherent task is ready, it explicitly calls `repo_work candidate`.
3. Only after candidacy may the Lead launch/prompt a `reviewer` at `repo: "."` for that task. Reviewer inspects actual changes and evidence. Findings go to the Lead, which batches remediation through Implementers and requests re-review when ready. There is no review after every individual edit.
4. `repo_work complete` is Task Lead-only and requires a settled, current Reviewer PASS. A Lead's `repo_agent_report outcome=completed` is also gated and checked again when its turn settles. Blockers/incomplete reports may be sent without approval; interim waiting turns need no final report.
5. After all required Leads have delivered approved completion reports, Orchestrator calls `repo_project candidate`, then starts/prompts `oracle` at `repo: "."`, passing the project ID as `bundle`.
6. Oracle evaluates overall acceptance and actual integration boundaries, using task approval evidence. Findings return to Orchestrator, which revises/reopens affected tasks and resumes their Leads. Only `repo_project complete` with a current Oracle PASS authorizes overall completion.

The manager's judgment starts review; it does not substitute for independent approval. A settled model turn is not task or project completion. The extension gates state transitions and structured reports, not every natural-language sentence a model might write.

### Direct refinements

Use the **Task Lead pane** for minor adjustments to ongoing work. Direct input is recorded locally and marked pending. The Lead must incorporate the decision into `repo_task_note` before declaring candidacy. Raw input stays in its conversation/local evidence and is not automatically forwarded to Orchestrator. The Lead delegates edits and ultimately sends a bounded result or a material blocker.

Changes to overall requirements, acceptance criteria or cross-task contracts must be escalated. This semantic distinction remains model judgment, not something a hook can perfectly infer. Direct refinements received during an active review are rejected with a visible message: finish that review first and submit the refinement again. Completed tasks must be explicitly reopened by Orchestrator. This release adds no queue or steering UI. Free-form input in managed Implementer panes is rejected to avoid untracked mutations; use the Lead. User shell commands and independently launched processes remain outside the tool policy.

### Tools

| Tool                                                        | Manager scope                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `repo_agent_list/start/prompt/read/reset/forget`            | Only the caller's directly managed children; role and task restrictions enforced |
| `repo_project create/list/status/candidate/complete/revise` | Orchestrator: overall requirements and Oracle gate                               |
| `repo_work create/revise`                                   | Orchestrator: assign or reopen a task, preserving baseline and review budget     |
| `repo_work list/status`                                     | Orchestrator: tasks; Lead: only its assigned task                                |
| `repo_work candidate/complete`                              | Task Lead: readiness and Reviewer gate                                           |
| `repo_task_document`                                        | Orchestrator: configured task-root metadata allowlist                            |
| `repo_task_note`                                            | Task Lead: its own bounded decisions and handoff notes                           |
| `repo_source`, `repo_research_fetch`                        | Scoped child source/research access according to role                            |
| `repo_review_changes`                                       | Reviewer/Oracle: repository roster and paginated before/after content            |
| `repo_agent_report`                                         | Child: bounded result to its immediate manager                                   |

Oracle can retrieve one task's requirements, notes or review brief with `repo_review_changes evidenceTask=<id> section=requirements|notes|brief`, paginated using `offset`. The roster does not concatenate every task's detailed evidence.

### Context, cost and approval validity

- Reports wake only the immediate manager. Implementer/Reviewer exchanges do not directly wake Orchestrator. Local monitoring invokes no model. End the turn when only waiting; there is no `repo_agent_wait`.
- A child receives the assigned task/context (combined maximum 16,000 characters), requirements and relevant saved decisions, never its parent's full conversation. Structured reports are limited to 6,000 JSON characters and main/Lead response batches to 18,000 characters. These are character limits, not token limits.
- Keep Task Lead reports about outcomes, decisions, blockers and remaining risk. Code, raw logs and diffs stay in worker/review contexts. Missing reports do not fall back to raw transcripts.
- Each task and each project has an initial review plus two re-reviews by default. The user may explicitly extend a budget from the main pane with `/repo-agents extend-review task <task-id>` or `/repo-agents extend-review oracle <project-id>`. No model tool can extend its own budget.
- Reviewer PASS requires inspection of all pages of baseline changes plus evidence references. Unchanged files inspected in the previous review can retain their coverage; changed files require renewed inspection. Incremental `since=previous_review` helps locate changes, but baseline pages establish coverage for changed files. This checks access provenance, not semantic review quality.
- Oracle must inspect real changes in each changed repository and evaluate integration evidence; it need not repeat every local file review. The tool can enforce actual access and current state, not prove that integration reasoning or reported verification is correct.
- Approvals bind to requirements/decision versions, task approval IDs and file fingerprints. Direct pending input, changed artifacts or revised requirements prevent stale completion. Oracle completion rechecks the task approval set.
- Each task has 1–12 repositories; a project has at most 32 tasks. Unfinished tasks sharing a repository are serialized. Implementers keep exclusive checkout reservations; read-only Leads/reviewers/research can coexist. Approved task completion retires idle Implementers so another task can acquire the checkout. Panes/reports remain. Reopened work needs a new Implementer after forgetting the exited one.
- Fingerprints cover whole supported repositories. Later tasks changing the same repository conservatively stale earlier task reviews; those tasks may need to be reopened/reviewed before final Oracle approval. There is no file-level approval dependency graph yet. This can increase review work for sequential shared-repo tasks.
- Context isolation does not guarantee lower total cost: Leads, independent review and fresh implementation contexts add work. This version has no measured savings or quality benchmark.

Snapshots include tracked and non-ignored untracked files for Git/colocated jj. Non-colocated jj uses bounded filesystem enumeration, skipping VCS/dependency/build directories rather than interpreting jj ignore rules. Limits remain 5,000 files, 32 MiB total and 2 MiB per file. Unsupported links/submodules cause refusal, not partial approval. External writers and ignore changes remain observable-scope limitations; snapshots are not a continuous filesystem lock.

### Updating

Finish old work before restarting Pi. v0.4 role-switching bundles and sessions are **not automatically migrated**. Start a fresh main process/conversation with a concise handoff. This installed local checkout is loaded on restart; `/reload` may retain imported modules. `pre-hierarchy-v0.4.0` preserves the previous source revision. Do not hot-reload this change into active work.

Configured TypeScript checking and formatting are the only current checks. The existing unit/live-model harnesses target earlier contracts and have **not been migrated or run for v0.5.0**. Historical lifecycle results do not validate nested parents, direct Lead input or new review gates. No runtime/cost claim follows from compilation.

## Session lifecycle

Process identity still owns each family. Task Leads have separate coordination scopes and immediate child registries; every descendant also observes ancestor identities. Root exit prevents new work throughout the tree. Busy leaves finish accepted jobs and save results; Leads drain accepted children and record interrupted coordination before exiting. Lead exit drains its own subtree. No new process automatically adopts an old family. Nested behavior is implemented but not runtime-verified in v0.5.0.

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

A cleanly exited child can be forgotten with `repo_agent_forget`. Its pane, reports and session files remain. A later parent may reserve that checkout after the old child process is confirmed dead. For interrupted launches or crashes, inspect the child pane and any commands it launched, then use `/repo-agents recover <agent ID or relative repo path>`. Recovery checks parent and child process identities, launch expiry and the Herdr agent list; it refuses a live or unknown child and never kills processes. Recovery releases the reservation and preserves evidence. It does not resume or replay interrupted work. Unregistered background commands must be inspected separately.

`/repo-agents history` lists up to 50 parent runs for the current root, with report directories and retained agent/job IDs. It is read-only and does not adopt agents or wake a new model turn. Each agent directory contains `<jobId>.result.json` reports and session files. Older results remain available even after the parent exits.

State lives under `<Pi agent directory>/pi-herdr-multi-repo-subagents/`: a local SQLite ownership database and `runs/<root hash>/<parent run ID>/` files. It is outside code repositories. The supported storage is a local filesystem on one machine. Different Pi profiles have separate coordination databases; do not run them concurrently against the same checkout. A different Herdr server does not bypass checkout reservations within one profile. Previous v0.2.0 agents are not migrated: exit and forget them using that version before using this version on those checkouts.

This is coordination with model-tool restrictions, not an OS sandbox. Implementers still have ordinary execution privileges; read-only roles and the managed Orchestrator use restricted tools. User-issued shell commands, another extension’s own code, and external programs are outside those restrictions. Repository scope is validated for launching and described in the task; it does not prevent access to other paths or prevent manually launched processes from editing the checkout. The extension never fabricates Herdr caller context. Removing the package does not delete retained reports or session files.

## Development and distribution

```sh
npm ci
npm run typecheck
```

Migrate the existing tests/live harnesses to the v0.5 contract before running them or packaging a release. `npm pack` runs the prepack checks, including those tests.

The package has no runtime dependencies beyond Pi-provided peers. `pi` manifest paths and an npm file allowlist limit the archive to the extension, documentation, license and example generator. Do not publish without selecting your own package ownership and version.

Generate an isolated example (requires Git and jj):

```sh
node scripts/create-demo.mjs /absolute/path/to/new-demo-project
```

The generator refuses an existing project directory. It creates a metadata jj repository plus two independent code repositories with local baseline commits and no remotes. The baseline timeout tests intentionally fail until the delegated agents implement the contract. Start Pi in the generated task directory inside Herdr.

## Design references

[Pi extension lifecycle](https://pi.dev/docs/latest/extensions), [Pi packages](https://pi.dev/docs/latest/packages), and [Herdr agent automation](https://herdr.dev/docs/agent-automation/) define the integration contracts.

[pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents/tree/7180d986a712e7627986a147ca8e5d5a4e0265da) was reviewed for lifecycle separation and asynchronous delivery ideas. This implementation is independent and does not install that package, include its agent bundles, or route to other harnesses.

The scripts under `scripts/test-live.mjs` and `scripts/test-lifecycle-live.mjs` describe historical v0.3/v0.4 scenarios. They require migration to the hierarchy before use. Future verification must use a dedicated named Herdr session and isolated fixture, covering both approval levels, local refinement, same-checkout serialization, re-review, and ancestor shutdown. Do not point such scripts at ongoing work.
