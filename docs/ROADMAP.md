# Roadmap

Docklane은 기능 수보다 **안전하게 끝나는 운영 흐름**을 먼저 완성한다.

버전 번호보다 각 milestone의 exit criteria를 우선한다.

## v0.0 — Foundation & Security Boundary

목표: mutation을 열기 전에 신뢰 경계와 실행 기반을 만든다.

- [ ] pnpm workspace / monorepo
- [ ] Next.js web
- [ ] NestJS API
- [ ] shared contracts
- [ ] database / migration
- [ ] authentication
- [ ] VIEWER / OPERATOR / ADMIN 기본 RBAC
- [ ] resource-scope authorization
- [ ] audit event model
- [ ] Agent mTLS authentication
- [ ] Agent operation/field allow-list
- [ ] Docker Engine API spike
- [ ] supported Docker Engine/API version policy
- [ ] local development compose
- [ ] lint / typecheck / test CI

Exit criteria:

- Web → API → DB 기본 연결
- Control Plane ↔ Agent mutual authentication
- 권한 없는 mutation request가 API와 Agent 양쪽에서 거절
- 개발 환경에서 Swarm manager 정보를 읽는 최소 PoC

## v0.1 — Swarm Read Model

목표: CLI 없이 실제 cluster state를 정확히 읽는다.

- [ ] cluster registration
- [ ] manager quorum
- [ ] node list/detail
- [ ] service list/detail
- [ ] task status
- [ ] service Version.Index
- [ ] normalized spec fingerprint
- [ ] desired/running replicas
- [ ] dashboard
- [ ] cluster mutability state

Exit criteria:

- 3-node functional PoC에서 실제 Swarm state와 UI가 일치
- manager/worker 장애 상태 구분
- quorum 상실 상태에서 read-only/degraded 표시

## v0.2 — Safe Mutation Coordinator

목표: deploy 전에 scale/restart/drain에서 공통 mutation 계약을 검증한다.

- [ ] durable Operation entity
- [ ] idempotency key
- [ ] resource lock
- [ ] expected Docker service version
- [ ] spec conflict detection
- [ ] replica scale
- [ ] service restart
- [ ] node labels
- [ ] node drain / activate
- [ ] convergence timeout
- [ ] mutation audit
- [ ] restart reconciliation

Exit criteria:

- scale 4 → 8 → 3
- drain 후 Swarm task 재배치 확인
- standalone container는 drain 대상이 아님을 검증
- 외부 CLI 변경 시 conflict 감지
- API 재시작 후 non-terminal operation reconcile
- 모든 mutation에 audit event 생성

## v0.3 — Deployment Target & Immutable Release

목표: environment binding과 artifact identity를 명확히 한다.

- [ ] environment-independent Application
- [ ] DeploymentTarget
- [ ] existing replicated service binding
- [ ] registry adapter
- [ ] digest resolution
- [ ] immutable Release
- [ ] git commit / build metadata
- [ ] artifact availability validation
- [ ] release history

MVP 제한:

- application당 target별 single stateless replicated service
- ingress routing mesh only
- service creation은 지원하지 않음

Exit criteria:

- production 가능한 Release는 digest 없이 생성할 수 없음
- tag가 바뀌어도 기존 Release identity가 변하지 않음
- staging/production binding이 Application 자체와 분리됨

## v0.4 — Safe Deployment & Rollback

목표: 성공/실패/복구를 하나의 end-to-end 계약으로 완성한다.

- [ ] deployment ticket
- [ ] deployment state machine
- [ ] target digest update
- [ ] rolling update
- [ ] SSE progress
- [ ] service/task reconciliation
- [ ] target digest verification
- [ ] target spec fingerprint verification
- [ ] application health stable-window
- [ ] Swarm automatic rollback detection
- [ ] duplicate rollback prevention
- [ ] Docklane initiated rollback
- [ ] ROLLBACK_VERIFYING
- [ ] ROLLBACK_FAILED / NEEDS_ATTENTION
- [ ] historical redeploy
- [ ] deployment history

Exit criteria:

~~~text
Release
  -> Deploy
  -> Target digest/spec convergence
  -> Health stable window
  -> SUCCESS
~~~

실패:

~~~text
Deploy
  -> Update or health failure
  -> Rollback
  -> Previous spec convergence
  -> Recovery health
  -> ROLLED_BACK
~~~

broken release가 자동 rollback된 뒤 replica/health가 정상이어도 새 Release를 SUCCESS로 기록하지 않아야 한다.

## v0.5 — Recovery & Fault Injection

목표: Control Plane이 중간에 죽어도 실제 상태와 기록이 다시 일치한다.

- [ ] update accepted 직후 API process kill
- [ ] Agent response loss
- [ ] Docker event stream disconnect
- [ ] event history gap
- [ ] duplicate request
- [ ] stale operation attempt
- [ ] external CLI mutation
- [ ] rollback command response loss
- [ ] reconciliation worker
- [ ] explicit operation timeout

Exit criteria:

- 재시작 후 actual service inspect로 진행 상태 복구
- 안전하지 않은 mutation을 무조건 재실행하지 않음
- late response가 종료된 generation의 상태를 덮어쓰지 않음
- conflict는 operator-visible state로 남음

## v0.6 — Networking, Capacity & HA Validation

목표: 기능 PoC와 실제 운영 도입 검증을 구분한다.

### Networking / capacity

- [ ] ingress routing mesh only policy
- [ ] external LB integration test
- [ ] real traffic rolling update test
- [ ] start-first capacity preflight
- [ ] placement constraint test
- [ ] pending reason / timeout
- [ ] no automatic stop-first downgrade

### HA / recovery

- [ ] 3-manager topology
- [ ] leader 1대 상실
- [ ] quorum 상실
- [ ] network partition
- [ ] Agent/manager endpoint failover
- [ ] manager resource contention
- [ ] Swarm backup
- [ ] Swarm restore drill
- [ ] Docklane DB/encryption key/Agent trust restore drill

Exit criteria:

- 3 managers에서 1대 상실 후 mutation 가능
- quorum 상실 시 mutation 차단
- 기존 task 실행 상태와 management unavailable 상태 구분
- 정한 recovery 절차로 실제 복원 성공

## v0.7 — Node Bootstrap

PoC 단계에서는 수동 Swarm join을 사용한다.

자동화 시 구현:

- [ ] Docklane one-time bootstrap token
- [ ] token TTL/scope
- [ ] native Swarm join token handling
- [ ] worker/manager role validation
- [ ] Docker installation/validation
- [ ] Swarm join
- [ ] post-join identity verification
- [ ] node labels
- [ ] retry/partial failure
- [ ] concurrent join behavior
- [ ] bootstrap audit
- [ ] native token rotation policy

Docklane bootstrap token 만료를 native Swarm join token 무효화와 동일시하지 않는다.

## v0.8 — Governance & Expansion

- [ ] deployment approval
- [ ] deployment diff
- [ ] environment promotion
- [ ] scheduled deployment
- [ ] notification webhook
- [ ] Docker Config / Secret UI
- [ ] multi-service release manifest
- [ ] Stack editor / Swarm validation

## Later

- [ ] capacity trend dashboard
- [ ] NCP provider adapter
- [ ] AWS provider adapter
- [ ] LB registration integration
- [ ] metrics/logging integrations
- [ ] image vulnerability integration
- [ ] multi-cluster overview
- [ ] optional VM provisioning

## Functional PoC Topology

~~~text
manager-01
worker-01
worker-02
~~~

이 프로필은 다음을 검증한다.

- rolling deployment
- worker failure rescheduling
- drain
- replica scale
- rollback/reconciliation

Manager HA를 검증하는 구성이 아니다.

## Production Readiness Topology

최소 3 managers에서 HA acceptance test를 수행한다.

3대 manager가 workload를 겸하는 구성도 가능하지만 manager resource starvation을 방지하는 운영 정책이 필요하다.

## Product Readiness Definition

Docklane v0.x가 "사용 가능"하다는 판단은 버전 번호가 아니라 다음 조건으로 한다.

1. immutable digest deployment
2. target spec convergence verification
3. rollback verification
4. operation serialization
5. restart reconciliation
6. basic RBAC + Agent authorization
7. audit completeness
8. actual LB traffic validation
9. 3-manager HA test
10. backup/restore drill

위 조건 전에는 pre-alpha / experimental 상태를 유지한다.
