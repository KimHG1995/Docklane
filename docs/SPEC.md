# Docklane Product & Technical Specification

Version: **0.2-draft**  
Status: **Pre-alpha / design hardening**

## 1. Summary

Docklane은 비용 제약 환경에서 기존 Linux VM과 Docker Swarm을 활용해 컨테이너 배포와 운영에 필요한 핵심 기능을 제공하는 경량 self-hosted deployment control plane이다.

Docker Swarm이 제공하는 scheduling, replica management, service discovery, rolling update를 재구현하지 않고, 그 위에 release, deployment, rollback verification, reconciliation, audit, operational UX를 제공한다.

## 2. MVP Boundary

MVP는 다음 조건으로 제한한다.

- single Swarm cluster
- application당 단일 stateless replicated service
- existing OCI registry
- existing external load balancer
- Swarm ingress routing mesh
- production release는 digest 고정 필수
- service mutation은 Docklane에서 직렬화
- 모든 mutation에 RBAC / resource scope / audit 적용
- API/Agent 재시작 후 실제 Swarm 상태와 reconciliation 수행

MVP 이후 확장:

- multi-service application / Stack
- environment promotion
- node bootstrap automation
- cloud provider adapters
- scheduled deployment / approval

## 3. Goals

### P0

- cluster/node/service/task read model
- manager quorum 표시
- authentication / RBAC / resource scope
- agent mTLS
- mutation audit
- service-level mutation lock
- service scale / restart
- node active / drain
- digest-pinned release
- rolling deployment
- target convergence verification
- application health stability verification
- automatic/manual rollback
- rollback verification
- historical redeploy
- crash/restart reconciliation
- external change conflict detection

### P1

- registry browser
- config / secret management
- deployment approval
- scheduled deployment
- environment promotion
- deployment diff
- Stack editor / validator
- capacity dashboard
- notification integration
- Swarm backup status

## 4. Non-goals

- Kubernetes compatibility
- 자체 scheduler / service discovery / overlay network
- VM provisioning
- CI/build server
- container registry
- DB schema/data rollback
- stateful database orchestration
- service mesh
- GitOps engine
- multi-region scheduler

## 5. Core Domain

### Application

논리적 서비스 단위다. MVP에서는 하나의 DeploymentTarget에 하나의 Swarm replicated service를 바인딩한다.

```text
id
name
description
createdAt
updatedAt
```

### DeploymentTarget

환경/cluster별 실제 배포 대상을 표현한다.

```text
id
applicationId
clusterId
environment
dockerServiceId
serviceName
routingMode
createdAt
updatedAt
```

MVP routingMode는 `INGRESS`만 지원한다.

### Release

환경에 종속되지 않는 immutable artifact metadata.

```text
id
applicationId
version
imageRepository
imageTag
imageDigest
gitCommit
buildNumber
createdBy
createdAt
```

운영 Release 생성 시 `imageDigest`는 필수다. Tag는 표시용 metadata이며 배포 시 재해석하지 않는다.

### Deployment

특정 Release를 특정 DeploymentTarget에 반영하는 실행 단위.

```text
id
releaseId
deploymentTargetId
previousReleaseId
operationId
status
reason
beforeSpec
targetSpec
expectedServiceVersion
startedAt
finishedAt
createdBy
createdAt
```

### Deployment Status

```text
PENDING
READY
DEPLOYING
VERIFYING
SUCCESS
FAILED
ROLLING_BACK
ROLLBACK_VERIFYING
ROLLED_BACK
ROLLBACK_FAILED
NEEDS_ATTENTION
CANCELLED
```

`NEEDS_ATTENTION`은 실행 결과를 자동으로 확정할 수 없거나 외부 변경 충돌/복구 실패 등 운영자 판단이 필요한 상태다.

## 6. Service Mutation Contract

동일 service의 다음 작업은 하나의 lock으로 직렬화한다.

- deploy
- rollback
- historical redeploy
- scale
- restart

Logical lock:

```text
mutation:{clusterId}:{dockerServiceId}
```

Node drain은 여러 service에 영향을 줄 수 있으므로 대상 node의 running task를 기준으로 관련 service lock을 확보하거나 명시적으로 충돌 검사를 수행한다.

DB lock만으로 외부 CLI 변경을 막을 수 있다고 가정하지 않는다.

Mutation 시작 전 저장:

- current service version
- beforeSpec
- targetSpec
- operationId

실행 직전과 완료 전 Docker service version/spec을 다시 비교한다. 기대하지 않은 외부 변경을 발견하면 덮어쓰지 않고 `NEEDS_ATTENTION`으로 처리한다.

## 7. Release Contract

운영 배포 조건:

```text
imageDigest != null
AND
registry artifact is accessible
```

Release가 생성된 이후 해당 digest는 변경하지 않는다.

Historical redeploy의 MVP 의미:

> 과거 image digest를 **현재 DeploymentTarget의 runtime configuration에 적용**하는 새 Deployment를 생성한다.

즉 MVP historical redeploy는 당시 env/network/config/secret 전체 snapshot 복원을 의미하지 않는다.

완전한 runtime snapshot 복원은 P1 이후 별도 기능으로 정의한다.

DB schema/data migration은 image rollback 대상이 아니며 애플리케이션은 backward/forward compatibility를 별도로 보장해야 한다.

## 8. Deployment Success Contract

배포 시작 전에 `beforeSpec`과 `targetSpec`을 비교하여 실제 service spec 변경 여부를 구분한다.

### No-op Deployment

`beforeSpec == targetSpec`이면 Docker service update를 호출하지 않는다.

동일 Release 재배포를 오류로 취급하지 않고 명시적인 **no-op deployment**로 기록한다. 이 경우 Swarm `UpdateStatus == completed`는 요구하지 않는다.

다음 조건을 모두 만족하면 `SUCCESS`로 기록한다.

```text
1. current service spec image == target digest
2. current service spec == target spec
3. desired replicas == expected running replicas
4. expected running tasks use target digest/spec
5. application health succeeds during a stability window
6. no conflicting external service version/spec change is detected
```

Deployment/Event에는 실제 mutation이 발생하지 않았음을 구분할 수 있도록 `NO_OP` 또는 이에 준하는 결과 metadata를 남긴다.

### Mutating Deployment

`beforeSpec != targetSpec`이면 Docker service update를 실행하며 다음 조건을 모두 만족할 때만 `SUCCESS`로 기록한다.

```text
1. service spec image == target digest
2. expected Docker service update reached terminal success
3. desired replicas == expected running replicas
4. expected running tasks use target digest/spec
5. application health succeeds during a stability window
6. no conflicting external service version/spec change is detected
```

단순히 `running == desired`와 LB health 200만으로 성공을 판정하지 않는다.

Rolling update 동안 신/구 task가 공존할 수 있으므로 task별 target version convergence를 확인한다.

### Health Verification

MVP:

```text
path
interval
timeout
retries
stabilityWindow
expectedStatus
```

LB 경유 health는 사용자 경로 검증용으로 사용하되, 모든 새 task가 검증되었다고 해석하지 않는다. Swarm task/container health 및 target convergence를 별도로 확인한다.

## 9. Rollback Contract

### Automatic Swarm Rollback

Swarm이 이미 rollback을 시작한 경우 Docklane은 동일 rollback 명령을 중복 실행하지 않고 상태를 관찰한다.

### Docklane-triggered Rollback

Docklane이 rollback을 시작할 경우:

```text
FAILED
 -> ROLLING_BACK
 -> ROLLBACK_VERIFYING
 -> ROLLED_BACK
```

복구 검증 실패:

```text
ROLLBACK_VERIFYING
 -> ROLLBACK_FAILED
 -> NEEDS_ATTENTION
```

Rollback 성공 조건:

- service spec이 expected previous spec으로 수렴
- expected task set이 복구 version으로 수렴
- application recovery health 안정 기간 통과
- external conflict 없음

rollback command가 수락되었다는 사실만으로 완료 처리하지 않는다.

## 10. Durable Execution / Reconciliation

Docker mutation을 호출하기 전에 짧은 DB transaction으로 다음을 영속화한다.

- operationId
- intent
- target
- expected precondition
- beforeSpec
- targetSpec
- actor
- audit start event

API/Agent 프로세스가 종료되더라도 Swarm mutation은 계속 진행될 수 있다.

따라서 재시작 시 모든 non-terminal deployment를 조회하고 다음 순서로 reconciliation한다.

```text
Load persisted intent
 -> Inspect current Docker service
 -> Compare service version/spec with before/target spec
 -> Inspect update/task state
 -> Determine current phase
 -> Resume verification or rollback
 -> Never blindly replay mutation
```

Docker events는 보조 신호로 사용하고 source of truth로 사용하지 않는다. Event stream 단절 시 inspect/polling으로 복구한다.

동일 `operationId`에 대한 중복 요청은 idempotent하게 처리한다.

## 11. Basic Operations

### Scale / Restart

Scale과 restart도 deployment와 동일한 mutation coordinator를 사용한다.

특히 `docker service update`가 rollback 기준점을 변경할 수 있으므로 deployment `VERIFYING` 또는 rollback 진행 중에는 병행 실행하지 않는다.

### Node Drain

Drain은 Swarm service task에 대해서만 relocation을 기대한다.

Standalone `docker run` 또는 일반 `docker compose` workload를 자동 이전하는 기능으로 표현하지 않는다.

로컬 volume/state에 의존하는 workload는 MVP 지원 대상에서 제외한다.

## 12. Routing / Load Balancer

MVP는 Swarm ingress routing mesh를 지원한다.

External LB:

```text
Existing LB
 -> Swarm node published port
 -> ingress routing mesh
 -> target task
```

host publishing mode는 MVP에서 제외한다.

PoC에서 반드시 실제 LB를 경유해 rolling update 중 요청 오류율, connection drain, application startup delay를 검증한다.

## 13. Capacity Contract

`start-first` update는 old/new task가 겹쳐 실행될 여유 자원이 필요하다.

배포 전에 가능한 범위에서 resource reservation 및 target placement를 검사한다.

배치할 노드가 없으면 자동으로 `stop-first`로 변경하지 않는다. 명확한 capacity failure reason과 timeout을 노출하고 운영자가 정책을 선택하도록 한다.

배포/rollback에는 phase timeout을 둔다. 무한 PENDING 상태를 성공 대기로 취급하지 않는다.

## 14. Authentication / Authorization

Mutation 기능 공개 전에 반드시 구현한다.

Roles:

### VIEWER

- read-only

### OPERATOR

- deploy
- rollback
- scale
- restart
- node drain/activate

### ADMIN

- cluster
- agent trust
- user/role
- secret/config
- system settings

모든 mutation에서:

- authenticated actor
- role
- cluster/resource scope
- target ownership/binding
- request validation
- audit

를 검증한다.

## 15. Agent Implementation & Security Contract

Agent 구현 언어는 **Go**로 고정한다.

초기 구현 기준:

```text
runtime        Go native binary
transport      HTTPS + JSON
authentication mTLS
contract       OpenAPI
docker access  local Unix socket
process        systemd managed daemon
```

Go 선택의 주된 목적은 CPU benchmark가 아니라 manager host의 runtime 의존성 최소화, 단일 바이너리 배포, 작은 agent footprint와 운영 단순성이다.

Control Plane은 TypeScript/NestJS를 유지하며 Agent와 내부 코드를 공유하지 않는다. 언어 경계는 OpenAPI 계약으로 관리한다.

Agent는 high-level allow-listed operations만 제공한다.

예:

```text
inspectCluster
inspectService
scaleService
restartService
updateServiceImage
rollbackService
drainNode
activateNode
```

클라이언트가 전달한 arbitrary Docker service spec, CLI arguments, shell command를 그대로 실행하지 않는다.

각 operation은 허용 가능한 field, cluster, service target을 다시 검증한다.

Control Plane ↔ Agent는 HTTPS + mTLS를 사용하고 요청/응답 schema는 OpenAPI로 검증한다.

gRPC는 MVP 범위에서 제외하고, streaming 또는 protocol 성능 요구가 확인될 경우 후속 검토한다.

Control Plane ↔ Agent 인증서는 다음 lifecycle을 정의한다.

- certificate issuance
- rotation
- expiration
- revocation
- compromised credential replacement

## 16. Bootstrap

Bootstrap automation은 MVP 핵심 배포 검증 이후 구현한다.

Docklane bootstrap token과 Docker native Swarm join token은 별도 credential이다.

Docklane token:

- one-time
- short TTL
- target cluster/role/labels 제한

Native join token:

- Docker Swarm credential lifecycle을 따름
- Docklane bootstrap token 만료가 native token 폐기를 의미하지 않음
- 필요 시 rotate

초기 PoC는 manual Swarm join을 허용한다.

## 17. HA / Operational Readiness

### Functional PoC Profile

```text
manager-01
worker-01
worker-02
```

검증:

- deploy/rollback
- worker loss
- drain
- scaling
- reconciliation

Manager HA 검증용이 아니다.

### Operational Readiness Profile

최소 3 managers로 다음을 검증한다.

- leader loss
- one manager loss
- quorum loss
- network partition
- Agent reconnect/failover
- manager resource contention
- Swarm backup/restore
- Docklane DB/crypto key restore

Production adoption은 위 복구 실험이 통과하기 전까지 권장하지 않는다.

## 18. Failure Handling

대표 code/status:

- `AGENT_UNAVAILABLE`
- `IMAGE_RESOLVE_FAILED`
- `TARGET_VERSION_MISMATCH`
- `EXTERNAL_SERVICE_CONFLICT`
- `INSUFFICIENT_CLUSTER_CAPACITY`
- `DEPLOYMENT_TIMEOUT`
- `HEALTH_VERIFICATION_FAILED`
- `ROLLBACK_FAILED`
- `QUORUM_UNAVAILABLE`

Manager quorum 상실 시 기존 workload 실행 여부와 control-plane mutability를 분리해서 표시하고 mutation을 차단한다.

## 19. Acceptance Tests

최소 필수 시나리오:

1. 정상 digest 배포 → target spec/task/health 모두 일치할 때만 SUCCESS
2. broken release → Swarm/Docklane rollback 후 실제 복구 검증
3. VERIFYING 중 scale/restart 요청 → 직렬화 또는 명시적 거절
4. 외부 CLI service update → version/spec conflict 감지
5. Docker update 수락 직후 API 종료 → 재시작 후 reconciliation
6. Agent 응답 유실 → blind retry 없이 inspect 후 판단
7. rollback 중 image pull/health 실패 → ROLLBACK_FAILED/NEEDS_ATTENTION
8. start-first capacity 부족 → 원인과 timeout 표시
9. 실제 external LB 경유 rolling update traffic 검증
10. worker failure/drain → Swarm task rescheduling 확인
11. unauthorized mutation → API와 Agent 경계 모두 거절
12. 3 managers에서 leader loss와 quorum loss 검증
13. DB/Swarm state/key restore drill
14. 동일 digest/spec 재배포 → Docker update 없이 no-op SUCCESS, task/health 검증 수행

## 20. References

- https://docs.docker.com/engine/swarm/
- https://docs.docker.com/engine/swarm/services/
- https://docs.docker.com/engine/swarm/swarm-tutorial/rolling-update/
- https://docs.docker.com/reference/cli/docker/service/update/
- https://docs.docker.com/reference/cli/docker/system/events/
- https://docs.docker.com/engine/swarm/ingress/
- https://docs.docker.com/engine/swarm/admin_guide/
- https://docs.docker.com/engine/security/
- https://docs.docker.com/engine/swarm/swarm-tutorial/
