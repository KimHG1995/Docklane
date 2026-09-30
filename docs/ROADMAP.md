# Roadmap

Docklane은 기능 수보다 **안전하게 복구 가능한 하나의 deployment vertical slice**를 먼저 완성한다.

버전 번호는 구현 단계이며, production readiness를 의미하지 않는다.

## v0.0 — Foundation & Security Boundary

- [x] pnpm monorepo
- [x] Next.js web
- [x] NestJS API
- [x] shared contracts
- [ ] database/migration
- [x] authentication
- [x] VIEWER / OPERATOR / ADMIN 기본 RBAC
- [x] resource scope validation
- [x] mutation audit foundation
- [x] Docker Engine API read-only spike
- [x] Go agent module
- [x] OpenAPI agent contract
- [x] Docker Engine Go client read-only spike
- [x] Agent protocol skeleton (HTTPS + JSON)
- [x] systemd service definition
- [x] Control Plane ↔ Go Agent mTLS PoC
- [x] lint / typecheck / test CI
- [ ] supported Docker Engine/API version 명시

Exit criteria:

- Web → API → DB 기본 연결
- 인증되지 않은 사용자와 권한 없는 mutation 거절
- Go Agent 단일 바이너리 빌드/실행
- Agent arbitrary command 실행 불가
- OpenAPI 기반 Control Plane ↔ Agent 요청 검증
- read-only Docker inspect 동작

## v0.1 — Swarm Read Model

- [ ] cluster registration
- [x] manager quorum
- [x] node list/detail
- [x] service list/detail
- [x] task status
- [x] desired/running replicas
- [x] service digest/spec 표시
- [ ] dashboard

Exit criteria:

- 실제 Swarm 상태와 UI 일치
- manager/worker 장애 구분
- Docker service version/spec 확인 가능

## v0.2 — Release & Deployment Target

MVP application 모델을 고정한다.

- [x] logical Application
- [x] DeploymentTarget
- [x] single stateless replicated service binding
- [x] registry adapter
- [x] digest resolution
- [x] digest-required Release
- [x] git commit/build metadata
- [x] release history

Exit criteria:

- Release가 cluster/service에 직접 종속되지 않음
- 운영 Release는 digest 없이는 생성 불가
- 동일 Release를 target과 분리하여 표현 가능

## v0.3 — Safe Deployment Vertical Slice

Docklane의 핵심 단계다.

- [x] operation intent persistence
- [x] service-level mutation lock
- [x] beforeSpec / targetSpec / expected version 저장
- [x] rolling service update
- [x] target digest/spec convergence
- [x] task convergence verification
- [x] application health stability window
- [ ] SSE progress
- [x] deployment timeout
- [x] no-op deployment detection / verification
- [x] deployment history

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

- [x] Swarm rollback ownership detection
- [x] automatic rollback observation
- [x] Docklane-triggered rollback
- [x] ROLLBACK_VERIFYING
- [x] ROLLBACK_FAILED / NEEDS_ATTENTION
- [x] API restart reconciliation
- [x] Agent response-loss reconciliation
- [x] idempotent operationId
- [x] external CLI conflict detection
- [x] historical image redeploy

Exit criteria:

- broken release가 성공으로 오판되지 않음
- rollback 이전 spec/task/health 실제 복구 확인
- Docker update 수락 직후 API 종료 후 정상 재조정
- blind mutation retry 없음

## v0.5 — Coordinated Operations

Deployment와 같은 mutation coordinator에 운영 작업을 연결한다.

- [x] replica scale
- [x] service restart
- [x] node labels
- [x] node drain/activate
- [ ] mutation conflict UX
- [x] capacity pre-check
- [x] ingress routing mesh validation

Exit criteria:

- VERIFYING/rollback 중 scale/restart 충돌 방지
- scale 4 → 8 → 3
- drain 후 Swarm task 이동
- standalone Compose workload는 drain 대상이 아님을 UI/문서에서 구분

## v0.6 — Functional PoC Acceptance

체크박스는 실제 Functional PoC run에서 해당 시나리오가 끝까지 통과한 경우에만 완료 처리한다.
Harness 구현 여부와 acceptance 통과 여부를 구분한다.

2026-09-30 acceptance 완료:

- single-node run #36671264551: **SUCCESS**
  - normal digest deploy
  - same digest/spec no-op redeploy
  - broken release + manual rollback
  - API restart during update
  - Agent response loss
  - Swarm automatic rollback
  - capacity shortage pre-check
  - external CLI conflict
  - authorization rejection
  - audit completeness
- 3-node run #36662265999: **SUCCESS**
  - manager-01 / worker-01 / worker-02 Ready/Active topology
  - node drain/activate task relocation
  - worker failure reschedule 및 Docklane read-model 수렴
  - external HAProxy traffic during rollout
  - Swarm internal ports outer-host 차단

v0.6 Functional PoC acceptance를 완료했다.

Topology:

```text
manager-01
worker-01
worker-02
```

필수 acceptance는 시나리오 특성에 따라 single-node와 3-node 실제 Functional PoC 실행 결과로 체크한다. topology, worker failure, node drain, external LB, network exposure는 3-node run을 근거로 하고 나머지 deployment/reconciliation 시나리오는 single-node run을 근거로 한다.

현재 3-node topology harness:

- [x] manager-01 / worker-01 / worker-02 DinD Swarm bootstrap
- [x] 3-node Ready/Active topology 검증
- [x] manager Docker API host-loopback 접근 검증
- [x] node drain scenario
- [x] worker failure scenario
- [x] actual external LB traffic scenario
- [x] Swarm internal ports network exposure scenario

현재 single-node harness 구현:

- [x] normal digest deploy
- [x] broken release + manual rollback
- [x] external CLI conflict
- [x] API restart during update
- [x] Agent response loss
- [x] authorization rejection
- [x] audit completeness
- [x] same digest/spec no-op redeploy
- [x] broken release + automatic rollback
- [x] capacity shortage

필수:

- [x] normal digest deploy
- [x] broken release rollback
- [x] external CLI conflict
- [x] API restart during update
- [x] Agent response loss
- [x] capacity shortage
- [x] actual external LB traffic during rollout
- [x] worker failure
- [x] node drain
- [x] authorization rejection
- [x] audit completeness
- [x] same digest/spec no-op redeploy
- [x] Swarm internal ports blocked from untrusted/public networks

이 단계까지가 **기능 MVP**다.

## v0.7 — Bootstrap

핵심 deployment path가 검증된 후 자동화한다.

- [x] Docklane one-time bootstrap token
- [x] TTL / scope
- [x] Docker install/validate
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
- [ ] manager별 Go Agent 배포
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
