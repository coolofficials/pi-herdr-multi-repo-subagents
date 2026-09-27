# pi-herdr-multi-repo-subagents

Delegate repository work from a task-root Pi session to independent Pi sessions in visible Herdr tabs. Child reports automatically return to the coordinator. Each child starts in its repository and loads the applicable AGENTS.md files normally.

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

Start Herdr, change to your task root, and start Pi. Repositories are discovered automatically, with a small readiness indicator in the footer. Just describe the work you want done: the coordinator receives the repository roster, selects the relevant repositories, and delegates as needed. Starting Pi alone does not open child tabs or invoke a model. `/repo-agents` is an optional inspection command, never an activation step.

For example: “Check the timeout contract against the implementations, improve missing tests, and summarize the results.” No tool names or delegation commands are required in your request.

The roster refreshes before each task turn, so repositories cloned after startup are recognized. Automatic coordination stays inactive when there are no descendant repositories, outside Herdr, inside child sessions, or when delegation tools are disabled. Discovery failures appear in the footer and do not prevent ordinary Pi work.

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
  "layout": "tabs"
}
```

Paths are literal paths relative to the root, not globs. `include` replaces automatic traversal and can select nested repositories. Resolved paths must remain below the root. Optional settings: `maxDepth` (1–32), `layout` (`tabs` or `split`), `direction` (`right` or `down` for splits), `model` (`provider/model`), and `thinking`. By default children inherit the coordinator's model and thinking level. These settings contain execution preferences, not AGENTS.md policies.

## Interaction

- A delegated repository gets its own tab by default; focus stays with the user. Split layout is optional.
- One managed child per repository, shared across coordinator sessions in the same task root and Herdr server. Independent repositories can work concurrently. Concurrent launch operations are serialized briefly while the panes start.
- The coordinator passes a bounded task and relevant context, not its full conversation. AGENTS.md supplies language, project policies and conventions. Instructions that existed only in the parent conversation must be explicitly passed.
- Completion reports automatically wake the owning coordinator. There is no model invocation for periodic local status inspection. Finishing several children may still cause multiple coordinator turns; context isolation does not guarantee lower total cost.
- The child remains open for direct inspection and follow-up work. The coordinator normally reuses its session. If a completed task has accumulated irrelevant context or the objective changes, the coordinator explains why and can start a fresh session in the same tab with a concise handoff. Previous session files remain available.
- No agent bundles, alternative harnesses, automatic commits, pushes, or code-review publication are provided.

| Tool                | Purpose                                                      |
| ------------------- | ------------------------------------------------------------ |
| `repo_agent_list`   | Discover repositories and registry entries                   |
| `repo_agent_start`  | Open a Pi child and delegate a task                          |
| `repo_agent_prompt` | Follow up in an idle existing child                          |
| `repo_agent_read`   | Inspect current job report; optional bounded pane snapshot   |
| `repo_agent_wait`   | Explicit bounded wait, up to 60 seconds                      |
| `repo_agent_reset`  | Start fresh context in the same tab, with reason and handoff |
| `repo_agent_forget` | Forget a child only after it exits; retain pane and reports  |

Reports are captured at Pi's `agent_settled` event, after automatic retries and continuations. `settled` means the turn ended; the coordinator must inspect the answer and actual checks before claiming the task succeeded. Reports have job IDs, final text, token usage, error/outcome, and the original session path. Model-facing summaries are capped at 12,000 characters with a path to the full report. Tool logs and hidden reasoning are not copied into the report.

## Recovery and scope

A timeout or failed prompt submission may occur after text was delivered. The extension retains the registry entry and pane and does not resubmit automatically. Inspect with `repo_agent_read` and `logs: true`. Resolve an interactive trust/login question directly in the child tab. If startup failed before the child initialized, exit any partial child, forget the entry, and start again. If a pane was closed, forgetting the entry allows a new child to start.

State and child sessions live below `<Pi agent directory>/pi-herdr-multi-repo-subagents/`, partitioned by task root and Herdr socket. They are not placed inside the code repositories. Parent reload/resume can recover registry entries and reports. Automatic notifications belong to the parent session that submitted the task; another parent can inspect existing agents and take ownership by sending the next task. Completed reports and old sessions are retained; removing the package does not delete them.

This is coordination, not an OS sandbox. Every child has normal Pi filesystem, credential and tool access. Repository scope is validated for launching and described in the task; it does not prevent a child from accessing other paths. The extension never fabricates Herdr caller context and never controls another user's focused pane implicitly.

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

This invokes your authenticated Pi model and uses its allowance/billing. It leaves the demo tabs open. `PI_TEST_MODEL` optionally selects a model; `PI_TEST_TIMEOUT` changes the per-stage timeout (default 300,000 ms).
