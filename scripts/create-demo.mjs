import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const target = process.argv[2];
if (!target)
  throw new Error(
    "Usage: node scripts/create-demo.mjs /absolute/path/to/new-project",
  );
const project = path.resolve(target);
await fs.mkdir(project, { recursive: false });
const task = path.join(project, "DEMO-001-shared-timeout");
const write = async (p, text) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
};
await write(
  path.join(project, "AGENTS.md"),
  "# Demo project\n\nThe shared API contract is owned by the task reference document. Include the token `PROJECT-SCOPE-OK` in the final report so the integration test can verify project instruction discovery.\n",
);
await write(
  path.join(task, "AGENTS.md"),
  "# Shared timeout task\n\nImplement the contract in `references/timeout-contract.md`. Repository agents own files only in their assigned repo. The coordinator owns todo-tracker.md. Include `TASK-SCOPE-OK` in final reports.\n",
);
await write(path.join(task, ".gitignore"), "/repos/\n");
await write(
  path.join(task, "references/timeout-contract.md"),
  '# Timeout contract\n\nBackend: export timeoutResponse(milliseconds), returning {status: 504, body: {code: "TIMEOUT", retryAfterMs: milliseconds}}. Reject negative or non-finite delays with RangeError.\n\nFrontend: export retryLabel(response), returning `Retry in N ms` for the timeout response, and `Request failed` for other responses. No network access is required.\n',
);
await write(
  path.join(task, "todo-tracker.md"),
  "# 작업 인계\n\n## 목표와 완료 조건\n- backend와 frontend가 공통 timeout 계약을 구현하고 각 테스트/빌드를 통과한다.\n\n## 현재 상태\n- 두 저장소의 기준 커밋 생성 완료.\n\n## 다음 작업\n1. 각 repo의 Pi agent에게 구현 위임.\n2. 결과를 모아 API 계약 연결 검증.\n",
);
await write(
  path.join(task, "demo-fixture.json"),
  JSON.stringify({ type: "pi-herdr-multi-repo-subagents-demo", version: 1 }) +
    "\n",
);
const repos = [];
for (const name of ["backend", "frontend"]) {
  const repo = path.join(task, "repos", name);
  await write(
    path.join(repo, "AGENTS.md"),
    `# ${name} repository\n\nUse Node's built-in test runner. Run npm test and npm run build after changes. Include \`${name.toUpperCase()}-SCOPE-OK\` in final reports.\n`,
  );
  await write(
    path.join(repo, "package.json"),
    JSON.stringify(
      {
        name: `demo-${name}`,
        private: true,
        type: "module",
        scripts: { test: "node --test", build: "node --check index.mjs" },
      },
      null,
      2,
    ) + "\n",
  );
  await write(
    path.join(repo, "index.mjs"),
    name === "backend"
      ? 'export function timeoutResponse(milliseconds) {\n  return { status: 500, body: { code: "ERROR" } };\n}\n'
      : 'export function retryLabel(response) {\n  return "Request failed";\n}\n',
  );
  await write(
    path.join(repo, "index.test.mjs"),
    name === "backend"
      ? `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { timeoutResponse } from './index.mjs';\ntest('timeout contract',()=>assert.deepEqual(timeoutResponse(1250),{status:504,body:{code:'TIMEOUT',retryAfterMs:1250}}));\ntest('invalid delay',()=>{for(const n of [-1,NaN,Infinity]) assert.throws(()=>timeoutResponse(n),RangeError);});\n`
      : `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { retryLabel } from './index.mjs';\ntest('timeout label',()=>assert.equal(retryLabel({status:504,body:{code:'TIMEOUT',retryAfterMs:1250}}),'Retry in 1250 ms'));\ntest('fallback',()=>assert.equal(retryLabel({status:500,body:{code:'ERROR'}}),'Request failed'));\n`,
  );
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Demo Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Initial local fixture",
  ]);
  const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  execFileSync("jj", ["git", "init", "--colocate", repo]);
  repos.push({
    repo: `repos/${name}`,
    origin: "generated local fixture; no remote",
    baseBranch: "main",
    baseCommit: commit,
  });
}
await write(
  path.join(task, "repositories.json"),
  JSON.stringify(repos, null, 2) + "\n",
);
execFileSync("jj", ["git", "init", task]);
console.log(task);
