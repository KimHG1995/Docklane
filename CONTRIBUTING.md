# Contributing

Docklane은 현재 pre-alpha 단계입니다. 기능 수보다 **작고 검증 가능하며 복구 가능한 변경**을 우선합니다.

## Development Principles

1. Docker/Swarm이 제공하는 기능을 재구현하지 않는다.
2. Provider-specific 기능은 core domain과 분리한다.
3. 모든 infrastructure mutation은 명시적이고 감사 가능해야 한다.
4. Security boundary를 편의를 위해 우회하지 않는다.
5. 큰 기능보다 하나의 검증 가능한 vertical slice를 우선한다.
6. CI를 formatter나 반복 디버거로 사용하지 않는다.
7. 새 Functional/Operational acceptance harness는 제품 구현 PR과 기본적으로 분리한다.
8. 로컬/정적 preflight로 발견 가능한 오류를 GitHub Actions까지 올리지 않는다.
9. 모든 작업은 `docs/ROADMAP.md` 확인과 동기화를 Definition of Done에 포함한다.

## Work Unit

기본 작업 단위는 다음과 같다.

```text
1 task
  -> 1 branch
  -> 1 pull request
  -> squash merge
```

하나의 PR에 독립적인 기능 여러 개를 섞지 않는다.

브랜치는 항상 최신 `main`에서 시작한다.

예:

```text
feat/swarm-read-model
feat/node-labels
fix/mutation-lock
docs/development-workflow
```

## Commit Policy

Conventional Commit 형식을 사용한다.

```text
feat: add service scale operation
fix: block deploy without manager quorum
docs: clarify release model
chore: tighten validation workflow
```

한 작업의 파일을 **파일별 커밋으로 쪼개지 않는다.**

권장:

- 일반 작업: 1개의 완성된 커밋
- 논리적으로 분리할 이유가 있는 경우: 최대한 적은 수의 커밋
- formatting/type fix를 파일마다 별도 커밋으로 만들지 않는다.

자동화 도구는 가능하면 여러 파일을 하나의 Git tree/commit으로 묶는다.

## Before Opening a PR

PR은 구현 중간에 먼저 만들지 않는다.

다음 상태까지 정리한 뒤 PR을 생성한다.

- 변경 범위가 완료됨
- formatting 완료
- 타입/계약 정합성 검토 완료
- 테스트 추가 또는 기존 테스트 영향 검토 완료
- 문서 영향 검토 완료
- secret/credential 포함 여부 확인
- `docs/ROADMAP.md` 상태와 실제 구현/검증/acceptance 결과 일치 여부 확인

현재 repository validation 기준:

### TypeScript

```bash
corepack enable
pnpm install --no-frozen-lockfile
pnpm typecheck
pnpm --filter @docklane/api test
pnpm build
```

### Go Agent

```bash
cd agent
go mod tidy
gofmt -w .
go vet ./...
go test ./...
go build -o bin/docklane-agent ./cmd/docklane-agent
```

`go mod tidy` 또는 `gofmt` 이후 변경 사항이 생겼다면 **PR을 열기 전에** 반영한다.

## Pull Request Lifecycle

PR에는 다음을 포함한다.

- 변경 목적
- 주요 변경 사항
- 검증 방법
- 보안/운영 영향
- 실패/복구 의미
- 남은 제약

PR 생성 후에는 다음 규칙을 따른다.

1. 최신 head의 CI만 merge 판단 기준으로 사용한다.
2. 이전 commit의 failed/cancelled run은 최신 head가 green이면 merge blocker가 아니다.
3. CI 실패 시 먼저 전체 로그를 확인한다.
4. 같은 원인의 formatting/type/test 수정은 가능한 한 **한 follow-up commit**으로 묶는다.
5. 한 파일씩 수정하며 CI를 반복 실행하지 않는다.
6. latest head의 required validation이 모두 성공한 후에만 merge한다.
7. merge는 기본적으로 **squash merge**를 사용한다.

`main` push 후 validation이 한 번 더 실행되는 것은 정상이다.

## Mutation Change Checklist

Infrastructure mutation을 추가/변경하면 반드시 확인한다.

- authentication / authorization
- resource scope
- canonical resource identity
- serialization / conflict coordination
- optimistic precondition
- operationId idempotency
- persisted intent
- audit event
- ambiguous response-loss handling
- process restart reconciliation
- external mutation conflict
- convergence verification
- failure / rollback semantics

명령 수락만으로 `SUCCESS`를 기록하지 않는다.

## Documentation

모든 작업은 시작 시와 merge 전 `docs/ROADMAP.md`를 확인한다.

- 구현 또는 검증 상태가 바뀌면 같은 PR에서 ROADMAP 상태를 갱신한다.
- acceptance 완료는 실제 성공 run 또는 동등한 evidence가 있을 때만 체크한다.
- heavy acceptance 결과가 `main` merge 후에만 확인되는 경우, 다음 작업은 새 범위를 시작하기 전에 해당 결과를 ROADMAP에 먼저 동기화하고 같은 PR에 포함한다.
- routine ROADMAP 동기화만을 위한 별도 docs-only PR은 가능한 한 만들지 않는다.
- ROADMAP 상태 변화가 없는 작업도 merge 전에 변경이 필요 없는지 확인한다.

Architecture 또는 domain boundary를 변경하면 관련 문서를 함께 갱신한다.

- `docs/SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`

개발/PR 프로세스는 [Development Workflow](docs/DEVELOPMENT_WORKFLOW.md)를 따른다.

중대한 기술 결정이 누적되면 `docs/decisions/` 아래 ADR을 추가한다.

## Security

취약점은 공개 Issue가 아니라 [SECURITY.md](SECURITY.md)의 절차를 따른다.
