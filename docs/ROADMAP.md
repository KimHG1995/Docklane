# Roadmap

Docklane은 기능 수보다 **안전하게 복구 가능한 하나의 deployment vertical slice**를 먼저 완성한다.

버전 번호는 구현 단계이며, production readiness를 의미하지 않는다.

## v0.0 — Foundation & Security Boundary

- [ ] pnpm monorepo
- [ ] Next.js web
- [ ] NestJS API
- [ ] shared contracts
- [ ] database/migration
- [ ] authentication
- [ ] VIEWER / OPERATOR / ADMIN 기본 RBAC
- [ ] resource scope validation
- [ ] mutation audit foundation
- [ ] Docker Engine API read-only spike
- [ ] Agent protocol skeleton
- [ ] Control Plane ↔ Agent mTLS PoC
- [ ] lint / typecheck / test CI
- [ ] supported Docker Engine/API version 명시

Exit criteria:

- Web → API → DB 기본 연결
- 인증되지 않은 사용자와 권한 없는 mutation 거절
- Agent arbitrary command 실행 불가
- read-only Docker inspect 동작

## v0.1 — Swarm Read Model

- [ ] cluster registration
- [ ] manager quorum
- [ ] node list/detail
- [ ] service list/detail
- [ ] task status
- [ ] desired/running replicas
- [ ] service digest/spec 표시
- [ ] dashboard

Exit criteria:

- 실제 Swarm 상태와 UI 일치
- manager/worker 장애 구분
- Docker service version/spec 확인 가능

## v0.2 — Release & Deployment Target

MVP application 모델을 고정한다.

- [ ] logical Application
- [ ] DeploymentTarget
- [ ] single stateless replicated service binding
- [ ] registry adapter
- [ ] digest resolution
- [ ] digest-required Release
- [ ] git commit/build metadata
- [ ] release history

Exit criteria:

- Release가 cluster/service에 직접 종속되지 않음
- 운영 Release는 digest 없이는 생성 불가
- 동일 Release를 target과 분리하여 표현 가능

## v0.3 — Safe Deployment Vertical Slice

Docklane의 핵심 단계다.

- [ ] operation intent persistence
- [ ] service-level mutation lock
- [ ] beforeSpec / targetSpec / expected version 저장
- [ ] rolling service update
- [ ] target digest/spec convergence
- [ ] task convergence verification
- [ ] application health stability window
- [ ] SSE progress
- [ ] deployment timeout
- [ ] no-op deployment detection / verification
- [ ] deployment history

Exit criteria:

```text
Release
 -> Deploy
 -> Target convergence
 -> Health stability
 -> SUCCESS
```

단순 replica count/health 200만으로 성공하지 않는다.

## v0.4 — Rollback & Reconciliation

- [ ] Swarm rollback ownership detection
- [ ] automatic rollback observation
- [ ] Docklane-triggered rollback
- [ ] ROLLBACK_VERIFYING
- [ ] ROLLBACK_FAILED / NEEDS_ATTENTION
- [ ] API restart reconciliation
- [ ] Agent response-loss reconciliation
- [ ] idempotent operationId
- [ ] external CLI conflict detection
- [ ] historical image redeploy

Exit criteria:

- broken release가 성공으로 오판되지 않음
- rollback 이전 spec/task/health 실제 복구 확인
- Docker update 수락 직후 API 종료 후 정상 재조정
- blind mutation retry 없음

## v0.5 — Coordinated Operations

Deployment와 같은 mutation coordinator에 운영 작업을 연결한다.

- [ ] replica scale
- [ ] service restart
- [ ] node labels
- [ ] node drain/activate
- [ ] mutation conflict UX
- [ ] capacity pre-check
- [ ] ingress routing mesh validation

Exit criteria:

- VERIFYING/rollback 중 scale/restart 충돌 방지
- scale 4 → 8 → 3
- drain 후 Swarm task 이동
- standalone Compose workload는 drain 대상이 아님을 UI/문서에서 구분

## v0.6 — Functional PoC Acceptance

Topology:

```text
manager-01
worker-01
worker-02
```

필수:

- [ ] normal digest deploy
- [ ] broken release rollback
- [ ] external CLI conflict
- [ ] API restart during update
- [ ] Agent response loss
- [ ] capacity shortage
- [ ] actual external LB traffic during rollout
- [ ] worker failure
- [ ] node drain
- [ ] authorization rejection
- [ ] audit completeness
- [ ] same digest/spec no-op redeploy
- [ ] Swarm internal ports blocked from untrusted/public networks

이 단계까지가 **기능 MVP**다.

## v0.7 — Bootstrap

핵심 deployment path가 검증된 후 자동화한다.

- [ ] Docklane one-time bootstrap token
- [ ] TTL / scope
- [ ] Docker install/validate
- [ ] native Swarm join token handling
- [ ] retry/partial failure protocol
- [ ] post-join node/role verification
- [ ] label application
- [ ] bootstrap audit

Docklane token과 native Swarm join token의 lifetime을 구분한다.

## v0.8 — Operational Readiness

최소 3 managers에서 별도 검증한다.

- [ ] leader loss
- [ ] manager loss
- [ ] quorum loss
- [ ] network partition
- [ ] Agent reconnect/failover
- [ ] manager resource contention
- [ ] Swarm backup/restore drill
- [ ] Docklane DB restore
- [ ] encryption/trust key restore
- [ ] recovery runbook

이 단계 통과 전 production adoption을 권장하지 않는다.

## Later

- [ ] approval workflow
- [ ] scheduled deployment
- [ ] environment promotion
- [ ] Docker Config / Secret UI
- [ ] runtime configuration snapshot
- [ ] Stack / multi-service deployment
- [ ] Swarm-compatible Stack validator
- [ ] capacity dashboard
- [ ] notifications
- [ ] NCP/AWS provider adapter
- [ ] LB registration integration
- [ ] metrics/logging integrations
- [ ] image vulnerability integration
- [ ] multi-cluster overview
