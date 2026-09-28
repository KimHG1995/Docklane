# CI/CD Change Scope Policy

Docklane은 변경 파일의 영향 범위에 따라 필요한 검증과 배포만 실행한다.

목표:

- 문서 변경으로 runtime build/deploy가 발생하지 않도록 한다.
- API/Web/Agent를 독립적으로 검증하고 배포할 수 있게 한다.
- Agent 계약처럼 여러 컴포넌트에 영향을 주는 변경은 관련 검증을 모두 실행한다.
- 분류되지 않은 경로는 안전하게 전체 검증한다.

## Validation Scope

| 변경 경로 | API | Web | Agent | Runtime deploy |
| --- | --- | --- | --- | --- |
| `apps/api/**` | yes | no | no | API only |
| `apps/web/**` | no | yes | no | Web only |
| `agent/**` | no | no | yes | Agent only |
| `contracts/**` | yes | no | yes | affected runtime components |
| root Node workspace/config | yes | yes | no | affected runtime components |
| `.github/workflows/**` | yes | yes | yes | no automatic runtime deploy |
| `docs/**`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` | no | no | no | none |
| unclassified path | yes | yes | yes | none until classified |

Root Node workspace/config currently means:

- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`

## PR flow

```text
changed files
  ↓
changes job
  ├─ API affected   → API typecheck / test / build
  ├─ Web affected   → Web typecheck / build
  ├─ Agent affected → gofmt / vet / test / build
  └─ docs only      → heavy runtime validation skipped
  ↓
validation-gate
```

`validation-gate` always runs and is the stable branch-protection target. Individual component jobs may legitimately be skipped.

## Deployment flow

Runtime deployment must not be coupled to every `main` push.

When deployment workflows are added, each component must use the same scope policy:

```text
main push
  ↓
detect affected runtime components
  ├─ api=true   → build/push/deploy API
  ├─ web=true   → build/deploy Web
  ├─ agent=true → build/release/deploy Agent
  └─ all false  → no runtime deployment
```

A docs-only merge must never create a container image, restart a service, or deploy an Agent.

## Contract changes

`contracts/**` is not documentation-only.

The Agent OpenAPI contract is an executable boundary between the TypeScript Control Plane and the Go Agent. A contract change therefore validates both API and Agent even if no implementation file changed.

## Unknown paths

A new top-level directory or unclassified file defaults to full validation.

This is intentional. A new path should first be treated as potentially runtime-relevant and later added to the scope map once its ownership is clear.

## Deployment trigger policy

Recommended CD policy:

- PR: validation only, never production deployment
- `main` merge: component-scoped deployment may run
- production: optionally add GitHub Environment approval
- manual recovery/redeploy: `workflow_dispatch`
- documentation-only change: never runtime deployment

Validation and deployment workflows should remain separate files. CI answers whether the change is valid; CD answers whether an affected runtime component should be released.
