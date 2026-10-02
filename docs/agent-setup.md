# Agent 설치·설정 가이드

이 문서는 다른 coding agent가 사용자의 환경에 `pi-herdr-multi-repo-subagents`를 설치하거나 설정할 때 사용하는 작업 절차입니다. 사용자 계정명, 회사명, 디렉터리 명명 규칙, 특정 모델을 전제하지 않습니다.

## 1. 먼저 파악할 것

사용자가 요청한 범위 안에서 진행합니다. 이미 허용된 설치·설정 작업은 반복 승인받지 않습니다. 선택이 필요하고 기존 환경에서 판단할 수 없을 때만 질문합니다.

1. **대상 환경:** OS, 실제 셸, Node/Pi/Herdr 실행 파일 경로와 버전.
2. **설치 범위:** 기존 Pi profile을 유지할지, 사용자가 별도 profile/project 설치를 요청했는지.
3. **대상 task root:** 실제 작업 repo가 하나 이상 하위에 있는 디렉터리. 참조용 clone은 작업 repo로 세지 않습니다.
4. **현재 설치본:** `pi list`, 해당 profile의 package 설정, 로컬 checkout의 `package.json`과 revision.
5. **모델:** 기존 provider·인증·등록 모델과 사용자의 제약. 별도 요청이 없으면 현재 모델을 상속합니다.
6. **진행 중 작업:** 이번 변경이 활성 Pi/자식에 영향을 주는지. 설치 완료와 실행 중 프로세스 반영을 구분합니다.

현재 셸에서 다음을 확인합니다. 읽기 전용 명령이며 모델 작업을 제출하지 않습니다.

```sh
command -v node pi herdr
node --version
pi --version
herdr --version
pi list
```

명령이 없으면 나머지 확인을 계속하고 해당 구성요소만 설치합니다. 환경변수 전체나 인증 파일을 출력하지 않습니다. API key/bearer token을 출력하는 `pi auth` 하위 명령은 준비 상태 확인용으로 사용하지 않습니다.

이 문서는 **v0.10.4 소스**를 기준으로 작성되었습니다. `package.json`의 버전이 있다고 같은 Git 태그나 npm 버전이 배포되어 있는 것은 아닙니다. 설치할 원격 ref의 존재와 내용을 먼저 확인합니다. 로컬 전용 기능을 이전 원격 설치본에서 사용할 수 있다고 설명하지 않습니다.

## 2. 필수 환경 설치

현재 소스의 요구 사항:

| 구성요소  | 요구 사항                                                  |
| --------- | ---------------------------------------------------------- |
| Node.js   | 22.18 이상                                                 |
| Pi        | 0.87.1 이상, `agent_settled` 지원                          |
| Herdr     | 0.9.1 이상, Pi integration 설치                            |
| Git/jj    | task root 하위 작업 repo; 공개 소스 참조 수집에는 Git 필요 |
| 실행 환경 | 로컬 Herdr pane 안에서 Pi 실행                             |

이 최소 버전은 모든 미래 버전과의 호환성을 보장하지 않습니다. Windows 지원은 Herdr 자체 지원과 이 extension의 실제 검증 범위를 구분합니다. 아래 셸 명령은 POSIX 셸 예시입니다.

기존 Node version manager와 설치 방식을 유지합니다. 이미 충족한 구성요소를 재설치하거나 시스템 전체를 업그레이드하지 않습니다.

Pi가 없다면 공식 설치 방법 중 환경에 맞는 하나를 사용합니다. npm 설치 예시:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

[Pi 공식 설치 안내](https://pi.dev/)의 현재 배포 정보를 확인합니다. 재현 가능한 버전 고정이 필요하면 존재를 확인한 버전을 지정합니다.

Herdr가 없다면 기존에 Homebrew를 사용하는 환경에서는:

```sh
brew install herdr
```

Homebrew를 사용하지 않는 Linux/macOS 환경의 공식 설치 방법:

```sh
curl -fsSL https://herdr.dev/install.sh | sh
```

두 방법을 중복 적용하지 않습니다. 다른 플랫폼과 업데이트 방법은 [Herdr 공식 설치 문서](https://herdr.dev/docs/install/)를 따릅니다. 설치 후 셸과 Herdr pane 양쪽에서 PATH가 정상인지 확인합니다.

Pi integration이 없거나 설치 절차상 필요할 때:

```sh
herdr integration install pi
```

커스텀 Pi profile에서는 integration의 실제 설치 위치도 확인합니다. 기본 profile에 설치되었다고 다른 profile에도 적용되었다고 가정하지 않습니다. 실행 중 Herdr 서버나 사용자 pane을 종료하지 않습니다.

## 3. 우리 extension 설치

사용자 기본 workflow를 위한 설치는 기존 **개인 Pi profile**을 사용하는 것이 기본입니다. 명시적인 project-only 요청이 있을 때만 `--local`을 선택합니다. 자식의 cwd는 다른 repo이므로 task root의 project-local package가 모든 자식에게 자동으로 로드된다고 가정하지 않습니다.

### 로컬 checkout

`/absolute/path/...`는 실제 확인한 경로로 교체합니다.

```sh
pi install /absolute/path/to/pi-herdr-multi-repo-subagents
```

로컬 소스는 복사본이 아니라 해당 경로에서 로드됩니다. 임시 checkout을 설치 경로로 등록한 뒤 삭제하지 않습니다. 소스 경로 변경 시 이전 경로와 revision을 복구 정보로 기록합니다.

### Git 배포본

원격에 실제 존재하는 검토된 tag/commit을 선택합니다. 다음 명령은 자리표시자가 있는 형식 예시이며 그대로 실행하지 않습니다.

```text
pi install git:github.com/coolofficials/pi-herdr-multi-repo-subagents@<verified-ref>
```

npm 배포 여부도 별도로 확인합니다. 이 저장소의 package 이름만 보고 존재하지 않는 npm 패키지를 설치하지 않습니다.

### 기존 설치를 업데이트할 때

- 변경할 Pi settings 파일과 이전 package source/ref를 백업합니다. 복구용 백업 파일에 포함된 인증 정보가 있다면 공유하지 않습니다.
- 기존 package 배열과 다른 설정은 보존합니다. 동일 extension의 서로 다른 설치 선언이 중복 로드되지 않도록 확인합니다.
- 설치에는 `pi install`, 제거에는 설치된 source와 같은 범위의 `pi remove`를 우선 사용합니다. 사용자 설정 전체를 예시 JSON으로 덮어쓰지 않습니다.
- 기본 profile 설정은 `~/.pi/agent/settings.json`입니다. `PI_CODING_AGENT_DIR`가 설정되어 있으면 실제 profile 경로를 사용합니다.
- 설치 후 `pi list`로 대상 source를 확인합니다. 이것만으로 extension 실행이나 모델 인증 성공을 판정하지 않습니다.

## 4. 설정의 소유 범위

| 파일/설정                           | 넣을 내용                                                         |
| ----------------------------------- | ----------------------------------------------------------------- |
| Pi profile의 `settings.json`        | package 설치 선언, Pi 자체 설정                                   |
| Pi profile의 `pi-herdr-models.json` | 개인 공통 기본 모델·thinking·역할별 설정                          |
| task root의 `pi-herdr.json`         | repo 탐색, 화면 구성, 문서 권한, task 모델 override, 선택 웹 연결 |
| 계층별 `AGENTS.md`                  | 응답 언어, 작업 정책, 프로젝트 요구사항                           |
| 선택 확장 자체 설정                 | 검색 provider, API 인증, 해당 확장의 기능 제한                    |

프로젝트 전용 내용을 개인 공통 지침에 넣지 않습니다. 런타임 설정을 AGENTS.md 프롬프트로 대체하지 않습니다. `pi-herdr.json`에는 API key를 넣지 않습니다.

### 기본 task 설정

설정 파일이 없어도 repo 자동 발견과 기본 화면 구성이 동작합니다. 필요하면 아래 항목만 기존 JSON에 병합합니다.

```json
{
  "layout": "tasks",
  "board": true,
  "research": { "webAccess": false }
}
```

| 키                  | 허용 값 / 의미                                                 |
| ------------------- | -------------------------------------------------------------- |
| `include`           | root 상대 repo 경로 배열. 지정하면 자동 탐색을 대체. glob 아님 |
| `exclude`           | root 상대 제외 경로 배열                                       |
| `maxDepth`          | 1–32, 기본 8                                                   |
| `layout`            | `tasks`(기본), `tabs`, `split`                                 |
| `direction`         | `right`, `down`; split 방향                                    |
| `board`             | boolean, 기본 활성화                                           |
| `documents`         | 최대 30개의 정확한 상대 `.md`/`.txt` 메타데이터 경로           |
| `model`, `thinking` | task 공통 기본값                                               |
| `roles`             | 역할별 `model`/`thinking` override                             |
| `research`          | 현재는 `webAccess: boolean`만 지원                             |

등록되지 않은 키는 오류입니다. `documents` 기본값은 `AGENTS.md`, `todo-tracker.md`이며 배열을 지정하면 기본값을 대체합니다. 추가 문서를 넣을 때 필요한 기존 경로를 유지합니다. 코드 repo 안의 파일을 문서 권한에 넣어 Orchestrator의 수정 제한을 우회하지 않습니다.

기존 디렉터리 이름을 강제로 바꿀 필요는 없습니다. 별도 task metadata repo를 사용하는 환경에서는 clone과 대용량 참조 데이터의 ignore 정책을 유지합니다.

### 역할별 모델

대화형 메인 Pi에서 `/repo-agents models`를 실행하면 **User profile / This task**를 선택하여 수정할 수 있습니다. headless 설치 agent는 필요한 JSON 필드만 병합할 수 있습니다.

- 역할 키: `task_lead`, `implementer`, `reviewer`, `oracle`, `scout`, `researcher`.
- Orchestrator 모델은 Pi 자체 모델 선택을 사용합니다. `roles.orchestrator`는 없습니다.
- `model`은 실제 등록된 정확한 `provider/model` ID를 사용합니다. `pi --list-models`와 Pi 모델 선택기를 참고하고 인증 상태를 별도로 확인합니다.
- `thinking` 스키마: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. **선택 모델이 실제 지원하는 값**만 지정합니다.
- 두 필드는 각각 **task 역할 → task 공통 → profile 역할 → profile 공통 → 요청 부모의 현재 값** 순서로 결정됩니다.
- profile의 역할별 모델을 활용하려면 불필요한 task 공통 `model`을 추가하지 않습니다.
- 미지정 필드는 상속하며 `null`을 사용하지 않습니다. 기존 provider를 다른 provider로 임의 대체하지 않습니다.

OAuth 로그인이 필요하면 사용자에게 `/login` 등 해당 provider의 정상 인증 흐름을 안내합니다. custom endpoint/provider 등록은 Pi의 provider 설정에 속합니다. 모델 목록에 보인다는 사실만으로 인증·쿼터·요청 성공을 보장하지 않습니다.

## 5. 선택적인 pi-web-access 연결

**필수 dependency가 아닙니다.** 기본 참조 자료 기능은 설치하지 않아도 동작합니다. 사용자가 웹 검색 연결을 요청하거나 이미 해당 범위를 승인한 경우에만 추가합니다.

[패키지 안내](https://pi.dev/packages/pi-web-access)에서 버전을 확인한 후, 자식들도 사용하는 Pi profile에 별도로 설치합니다. 검토한 인터페이스 버전의 예시는:

```sh
pi install npm:pi-web-access@0.32.0
```

이 버전 표시는 인터페이스 검토 기준이며 실제 병행 동작이 검증되었다는 뜻이 아닙니다. 다른 버전을 선택하면 도구명과 인자를 다시 확인합니다.

그다음 task root 설정에 병합합니다.

```json
{
  "research": { "webAccess": true }
}
```

활성 작업이 있는 Researcher에게만 기본 이름 `web_enable`, `web_search`, `fetch_content`, `get_search_content`가 허용됩니다. 이름을 바꾼 도구나 `source_check`는 현재 연결 대상이 아닙니다. 패키지가 없으면 웹 도구만 없고 기본 자료 수집은 유지됩니다.

검색 provider·인증은 pi-web-access의 설정에서 관리합니다. 기본 위치는 해당 확장 문서의 `~/.pi/agent/web-search.json`을 확인하고 커스텀 profile의 실제 해석도 확인합니다. 회사에서는 승인된 provider를 명시하고, 일반 검색은 `workflow: "none"`과 제한된 결과량을 사용합니다. 자동 요약이나 모델 기반 검색은 추가 비용이 생길 수 있습니다.

Researcher의 `fetch_content`는 HTTPS URL만 허용합니다. 임의 로컬 파일 업로드를 위해 권한을 넓히지 않습니다. 웹 결과 캐시와 임시 clone은 영속 참조가 아니므로 중요한 자료는 다음 절차로 등록합니다.

MCP adapter 등 다른 확장의 설치는 별도 범위입니다. 현재 이 가이드의 웹 연결을 MCP 권한 연결로 해석하거나 `mcp` 전체를 읽기 전용 역할에 허용하지 않습니다.

## 6. 참조 자료 사용 흐름

1. Researcher가 `repo_reference_list`로 기존 자료를 확인합니다.
2. 필요할 때만 `repo_reference_add`로 수집합니다.
3. 보고에는 짧은 결론, reference ID, 버전·파일·근거 위치를 담습니다.
4. Scout/Implementer/Reviewer/Oracle은 `repo_reference_read/search`로 직접 필요한 구간을 확인합니다. Managers는 요약을 받습니다.

등록 예시(도구 인자):

```json
{
  "kind": "file",
  "file": "references/api-contract.md",
  "reason": "구현과 리뷰에서 동일한 계약 문서를 참조"
}
```

문서가 실제로 존재할 때 사용합니다. 다른 종류는:

- `document`: 공개 HTTPS 텍스트 URL, 최대 512 kB 수신 본문. HTML은 원문 보존.
- `repository`: 공개 github.com/gitlab.com URL과 명시적 `ref`. 실제 commit SHA를 기록한 소스 snapshot.
- `artifact`: 해당 Researcher의 웹 응답 artifact ID. upstream 전체를 확보했다고 간주하지 않음.

데이터는 task root의 `references/.pi-herdr-references/`에 남습니다. 작은 `manifests/`는 정책에 따라 버전 관리할 수 있고, `objects/`와 `.staging/`은 생성된 ignore 규칙으로 제외됩니다. 자동 commit/push는 없습니다.

자료는 세션 교체 후에도 유지됩니다. manifest만 다른 컴퓨터로 가져오면 원본은 별도로 재수집해야 합니다. private/self-hosted repo clone, 자동 GC, PDF 바이너리 원본 import는 현재 지원하지 않습니다. 참조 repo를 작업 repo로 등록하거나, 자료 속 AGENTS.md를 현재 작업 지침으로 적용하지 않습니다.

## 7. 시작·적용·확인

Herdr pane의 셸에서 실제 task root로 이동한 뒤 `pi`를 실행합니다. 사용자 인증이나 비용이 발생하는 작업 제출 없이도 설치 선언·설정·시작 화면을 구분하여 확인할 수 있습니다.

- 하위 repo가 발견되면 메인은 Orchestrator가 됩니다. 역할 내부 플래그나 Herdr 환경변수를 수동으로 위조하지 않습니다.
- 기본 `tasks` 구성에서는 메인 오른쪽 보드가 열리고, 요청에 필요한 자식만 나중에 열립니다. `/repo-agents`는 활성화 명령이 아닙니다.
- 실제 요구사항을 입력하면 필요한 Task Lead와 자식에게 위임합니다. 연결 확인만을 위해 업무 repo에 수정 작업을 제출하지 않습니다.
- 부모 프로세스 종료 시 idle 자식은 종료하고, busy 자식은 수락한 작업을 마친 후 결과를 저장하고 종료합니다. 새 부모가 이전 자식을 자동 인수하지 않습니다.

**적용 시점:** package의 공유 `.mjs` 변경은 `/reload`만으로 적용되지 않을 수 있습니다. 진행 중 작업을 정리한 뒤 새 메인 프로세스를 사용합니다. 실행 중 세션을 허락 없이 종료하지 않습니다. 단순 설치 요청은 파괴적인 lifecycle 테스트 허가가 아닙니다.

역할 모델 변경은 새 자식 launch 또는 idle 자식의 새 대화에서 적용됩니다. 작업 중 모델을 바꾸지 않습니다. checkpoint/compaction은 모델 전환이 아닙니다.

### 확인 수준을 구분해서 보고

| 수준      | 확인 내용                                   | 보장하지 않는 것           |
| --------- | ------------------------------------------- | -------------------------- |
| 설정 확인 | package source, 버전, JSON, 경로            | 로딩·인증·자식 실행        |
| 시작 확인 | 새 Pi의 오류 없음, Orchestrator/보드/roster | 실제 모델 요청 성공        |
| 동작 확인 | 사용자가 요청한 격리 시나리오의 실제 결과   | 모든 규모·플랫폼·장애 상황 |

자동/live 테스트는 요청된 경우에만 실행합니다. 실제 모델 호출은 비용이 발생할 수 있으므로 테스트 범위에 포함되었는지 확인합니다. `npm pack`은 `prepack`을 통해 테스트를 실행하므로 단순 패키지 파일 확인이라면 `npm pack --dry-run --ignore-scripts`를 사용합니다.

v0.9.0 참조 자료 및 선택 웹 연결의 기존 근거는 타입·포맷 등 정적 검사입니다. 이전 버전의 live 결과로 이 기능까지 검증되었다고 보고하지 않습니다.

## 8. 문제 해결·복구

| 증상                        | 확인할 순서                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Orchestrator가 아님         | 실제 Herdr pane인지, 하위 repo가 있는지, Pi package/tool이 활성화되었는지, include/exclude/depth 경고  |
| 웹 도구가 없음              | 활성 Researcher job인지, root의 webAccess 설정, 자식 profile 설치, 기본 도구명과 해당 확장 기능 활성화 |
| Tool not allowed            | 현재 역할과 계약 확인. 프롬프트나 allowlist 확대로 제한을 우회하지 않고 적합한 자식에게 위임           |
| Unknown config key          | 실제 설치된 extension 버전과 `src/core.mjs`, `src/model-settings.mjs`, `src/references.mjs`의 스키마   |
| 모델 선택 실패              | 정확한 provider/model, 인증, 지원 thinking, profile/task 우선순위                                      |
| 기존 agent/reservation 충돌 | 현재 소유 프로세스·Herdr pane·작업 상태 확인. 단순 lock 파일 삭제 금지                                 |
| reference 원본 없음         | manifest만 이동했는지 확인하고 기록된 버전을 다시 확보                                                 |
| reference 무결성 오류       | 원본 snapshot을 덮어쓰지 말고 새 자료 등록                                                             |

복구에는 `/repo-agents history`, 필요할 때 `/repo-agents recover <agent-id>`를 사용합니다. recovery는 죽은 자식의 소유권 정리를 위한 것이며 성공 보고나 승인 결과를 만들어내지 않습니다. 살아 있거나 정체를 확인하지 못한 프로세스를 강제 종료하지 않습니다.

버전 되돌리기는 기록해 둔 package source/ref로 복귀시키고, 변경한 설정 항목만 복원한 뒤 새 세션에서 적용합니다. 백업 이후의 사용자 변경을 통째로 덮어쓰지 않습니다. 참조 자료·보고서·세션 기록을 삭제하지 않습니다.

## 9. 완료 보고 형식

설치 agent는 최종 답변에 다음을 짧게 남깁니다.

- 설치 source/ref와 확인한 실제 버전
- 수정한 설정 파일·범위와 적용 값(비밀값 제외)
- 필수 기능과 선택 연결의 활성화 여부
- 확인한 수준, 실제 수행한 검사, 미검증 범위
- 새 세션 필요 여부와 아직 사용자가 해야 하는 인증 단계
- 기존 설정 복구 방법

권장 인계 요청 예시:

> 이 저장소의 AGENTS.md와 docs/agent-setup.md를 읽고, 현재 환경과 기존 Pi 설정을 확인한 뒤 우리 extension을 설치·설정해줘. 기존 package와 실행 중 세션은 보존하고 모델은 현재 설정을 상속해줘. 선택 확장은 내가 요청한 것만 연결하고, 완료 후 적용 상태와 미검증 항목을 알려줘.

## 자동 실행 경로 확인

새 세션에서 Orchestrator가 요구사항과 알려진 정보로 `single`/`reviewed`를 선택합니다. 단일 실행에는 실행 에이전트 하나만 사용하며, 판정 전용 agent나 필수 조사/리뷰 단계를 추가하지 않습니다. 중요한 동작·계약·보안·데이터 변경 또는 독립 검토를 요구하는 scoped 지침은 reviewed 경로를 사용합니다. 파일 수나 repo 수만으로 선택하지 않습니다.

선택은 `repo_work create`의 `executionMode`와 짧은 `executionReason`에 저장됩니다. 기존 호출과 작업은 reviewed로 유지됩니다. 단일 작업은 반환된 `executionRepo`에서 Implementer를 직접 시작하고, 보고가 settled 상태이며 실제 확인 결과·근거가 있을 때 `repo_work complete`로 완료합니다. project를 생략해서 자동 생성한 독립 프로젝트는 단일 작업과 함께 완료됩니다. 명시적으로 묶은 모든 작업이 single인 프로젝트도 Oracle 없이 완료할 수 있습니다.

실행 중 위험이 발견되면 Implementer의 `repo_execution`이 해당 job의 추가 실행·완료를 차단합니다. 기존 repo 작업은 `repo_work promote`로 baseline을 유지한 채 Reviewer를 붙일 수 있습니다. 완료한 구현·검증은 반복하지 않습니다. repo가 없는 루트 관리 작업은 코드 baseline이 없으므로, 코드 변경 전에 별도 범위가 있는 reviewed 작업을 만들어야 합니다.

보드의 실행 모드·사유를 확인합니다. 설치했다고 난이도 판단 정확도나 비용 절감률이 입증된 것은 아닙니다. 테스트는 격리 fixture에서만 실행하고 사용자의 실제 세션을 재시작하지 않습니다.

## 이미지 참고 자료 (v0.10.2)

Scout·Researcher의 active job에는 `repo_image`가 제공됩니다. 이미지를 읽을 역할의 현재 모델이 image input을 지원하는지 확인합니다. `repo_agent_list/read`의 `capabilities.localImages`와 `capabilities.modelImageInput`을 구분합니다. 모델 metadata의 지원 여부는 실제 provider 동작 검증을 대체하지 않습니다.

- root 기준 이미지: `scope: "task"`, `file: "references/screenshot.png"`. repo 내부는 해당 child 기준 상대 경로를 사용합니다.
- 지원: PNG/JPEG/GIF/WebP/BMP, regular file 최대 8 MiB. scope 밖 경로·symlink·unassigned repo 접근을 우회하지 않습니다. SVG/PDF는 이 도구의 raster 입력이 아닙니다.
- Pi resize로 글자가 작아질 수 있습니다. 보고에는 관찰 내용·판독 불가 부분·파일 경로를 남기고, 원본 이미지 대신 요약을 부모에게 전달합니다.
- `repo_image`는 모델/설정을 자동 교체하지 않습니다. text-only 모델이면 역할만 바꾸어도 해결되지 않습니다. 부모가 사용자 제약 안에서 허용된 image-capable 역할 모델을 선택하거나 필요한 입력을 요청해야 합니다.
- Orchestrator/Task Lead는 원본 이미지를 읽지 않고 Scout/Researcher에 위임합니다. Researcher는 자신이 처리할 수 있는 이미지 자료를 Scout에 재위임할 필요가 없습니다.

## 검증 로그 소유자 조회 (v0.10.3)

Reviewer/Oracle은 `repo_artifact`에 `id`만 전달해도 할당된 작업의 구성원 안에서 소유자를 찾습니다. 후보가 여러 개면 로그 대신 후보 정보를 반환하며, 원래 보고서의 `agent`를 지정해 다시 요청합니다. 명시한 소유자에게 없을 때 다른 agent로 자동 전환하지 않습니다. 다른 역할은 자기 로그만 읽습니다.

새 로그는 소유 agent·task 출처를 기록하고, 기존 로그는 작업 구성원 기록으로 연결합니다. 반환된 원래 `jobId`·실행 시각·명령을 검토합니다. `sourceVersion: null`은 검증 당시 코드 버전을 기록하지 않았다는 뜻이며, 출력 hash를 코드 버전으로 해석하거나 현재 코드의 테스트 통과로 자동 인정하지 않습니다. 기존 코드 fingerprint 및 승인 조건은 유지합니다.

활성 세션은 자동 갱신하지 않습니다. 별도 snapshot을 설치한 환경은 원본 checkout 변경만으로 갱신되지 않으므로 실제 Pi package source를 먼저 확인합니다.

## Pane 생성 후 셸 준비 확인 (v0.10.4)

자식 시작은 `waiting-shell` → `starting` → `ready` 순서로 진행합니다. 생성 응답의 pane·terminal·tab 식별자를 유지하며, 최대 10초 동안 셸만 foreground에 있는 상태가 500 ms 이상 유지되는지 확인합니다. 셸 초기화 중인 프로세스나 알 수 없는 상태에서는 기다리고, agent 점유·복원 오류·식별자 변경은 시작을 중단합니다. 이 관찰만으로 실제 프롬프트 준비를 보장하지는 않으며 최종 실행 가능 여부는 Herdr의 `agent start` 검사를 따릅니다.

시작 요청은 한 번만 보냅니다. 실패 시 pane과 기록을 보존하며 `startup-error.json`의 `stage`로 준비 대기와 실행 단계 오류를 구분합니다. `shell-ready.json`은 셸 관찰 근거이며 Pi 준비 완료나 작업 실행 성공 기록이 아닙니다. 오류 후 시작 요청 자동 재전송·Enter/Ctrl+C 주입·pane 종료·기존 실패 작업 자동 복구는 하지 않습니다.
