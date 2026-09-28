# Agent entry point

This repository implements `pi-herdr-multi-repo-subagents`.

- For a user-requested installation, configuration, update, or troubleshooting task,
  read `docs/agent-setup.md`. Reading this file alone is not a request to install
  packages or change the user's environment.
- `README.md` describes runtime behavior; `package.json` identifies this checkout's
  version. Inspect the checked-out configuration schema before assuming an older
  installed version supports current options.
- Preserve existing Pi packages, model/provider settings, scoped instructions,
  live sessions and unrelated changes. Apply the smallest requested change.
- Keep this package scope-neutral. User language, organization rules, credentials
  and model assignments belong in the user's scoped configuration/instructions.
- For implementation work, preserve tool-enforced role boundaries and lifecycle
  ownership. Record actual checks and distinguish static checks from runtime
  verification. Run/add tests only when requested; live scenarios must use an
  isolated fixture and explicitly owned Herdr processes.
- Do not publish, push, restart user sessions or replace an existing checkout
  merely because an installation guide contains an example command. Follow the
  user's requested scope and existing authorization.
