# Docklane Product & Technical Specification

Version: **0.2**  
Status: **Draft / pre-alpha**

## 1. Summary

Docklane은 비용 제약 환경에서 기존 Linux VM과 Docker Swarm을 활용해 컨테이너 배포와 운영에 필요한 핵심 기능을 제공하는 경량 self-hosted deployment control plane이다.

목표는 Kubernetes나 관리형 오케스트레이션 서비스를 복제하는 것이 아니라, Docker Swarm이 제공하는 실행·스케줄링 기능 위에 release, deployment, rollback verification, mutation coordination, audit workflow를 제공하는 것이다.

"저비용"은 현재 제품 목표와 검증 가설이다. VM 재사용만으로 총비용 우위를 주장하지 않으며, 운영 도입 전 인프라 비용과 플랫폼 유지보수·백업·인증서·장애 대응 비용을 함께 측정한다.

## 2. MVP Scope

첫 구현은 의도적으로 다음 범위로 제한한다.

- single Swarm cluster
- application당 single stateless replicated service
- 기존 OCI registry
- 기존 external load balancer
- Swarm ingress routing mesh
- 기존 Swarm service를 DeploymentTarget으로 등록
- production deployment는 immutable image digest 필수
- 수동 Swarm join
- Docker Engine / API 지원 버전 명시

MVP에서 service 생성, multi-service Stack, host publish mode, environment promotion, bootstrap 자동화는 지원하지 않는다.

## 3. Goals

### P0

- Authentication / 기본 RBAC / resource scope
- Control Plane ↔ Agent mTLS
- Swarm cluster/node/service/task 조회
- Manager quorum 상태 표시
- DeploymentTarget 등록
- Service replica scale / restart
- Node active/drain
- immutable Release 등록
- digest 기반 rolling deployment
- 목표 digest / service spec 수렴 검증
- application health stable-window 검증
- automatic rollback 관찰 및 Docklane rollback 조정
- rollback verification
- mutation serialization
- API/Agent 재시작 후 reconciliation
- Deployment ticket/history
- Audit log

### P1

- Bootstrap automation
- Docker Config / Secret 관리
- Registry browser
- Environment promotion
- Approval / scheduled deployment
- Deployment diff
- Capacity dashboard
- Swarm backup/restore guide and status
- 3-manager HA validation

### P2

- Multi-service application / Stack
- Cloud VM provisioning adapter
- Load balancer registration adapter
- Horizontal auto scaling
- Metrics/logging integrations
- Vulnerability scanner integration
- Multi-cluster dashboard

## 4. Non-goals

- Kubernetes API/CRD 호환
- 자체 scheduler/service discovery/overlay network/container runtime
- CI/build server
- container registry
- Terraform 대체
- database orchestration
- service mesh
- GitOps engine
- multi-region scheduler

## 5. System Boundary

~~~text
Source Code
   ↓
Existing CI
   ↓ build/test/push
OCI Registry
   ↓ immutable digest
Docklane Release
   ↓
DeploymentTarget
   ↓
Docker Swarm Service
~~~

Docklane의 책임은 image가 registry에 push되고 digest가 확정된 이후부터 시작한다.

## 6. Core Domain

### Cluster

하나의 Docker Swarm cluster.

~~~text
id
name
status
managerCount
workerCount
supportedDockerApiVersion
createdAt
updatedAt
~~~

### Node

~~~text
id
clusterId
dockerNodeId
hostname
address
role
availability
status
labels
cpu
memory
createdAt
updatedAt
~~~

Role: MANAGER | WORKER  
Availability: ACTIVE | PAUSE | DRAIN

### Application

환경과 cluster에 종속되지 않는 논리적 애플리케이션이다.

MVP에서는 Application 하나가 DeploymentTarget별로 하나의 stateless replicated service와 연결된다.

~~~text
id
name
description
createdAt
updatedAt
~~~

### DeploymentTarget

Application을 실제 Swarm service와 연결하는 환경별 binding이다.

~~~text
id
applicationId
clusterId
environment
dockerServiceId
serviceName
publishMode
healthCheck
createdAt
updatedAt
~~~

MVP의 publishMode는 INGRESS만 허용한다.

### Release

환경에 종속되지 않는 immutable application version이다.

~~~text
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
~~~

운영 가능한 Release는 imageDigest가 반드시 존재해야 한다. imageTag는 표시용 metadata이며 배포 시 다시 resolve하지 않는다.

### Deployment

특정 immutable Release를 특정 DeploymentTarget에 적용하는 행위다.

~~~text
id
operationId
releaseId
targetId
previousReleaseId
beforeServiceVersion
beforeSpecFingerprint
targetSpecFingerprint
status
reason
startedAt
finishedAt
createdBy
createdAt
~~~

Status:

~~~text
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
~~~

### Operation

모든 인프라 mutation의 durable execution intent다.

Kind 예:

- DEPLOY
- ROLLBACK
- SCALE
- RESTART
- NODE_DRAIN
- NODE_ACTIVATE

~~~text
id
kind
resourceKey
idempotencyKey
status
intent
expectedResourceVersion
attempt
leaseOwner
leaseExpiresAt
lastReconciledAt
createdBy
createdAt
updatedAt
~~~

Docker event stream은 보조 신호로만 사용한다. Operation의 최종 상태는 실제 Docker state를 inspect하여 reconcile한다.

### AuditEvent

~~~text
id
actorId
clusterId
resourceType
resourceId
action
before
after
sourceIp
operationId
createdAt
~~~

## 7. Service Mutation Coordination

deploy, rollback, scale, restart는 동일 service mutation path를 사용하고 반드시 직렬화한다.

Logical resource key:

~~~text
service:{clusterId}:{dockerServiceId}
~~~

Node drain은 node-level lock을 사용하며, 영향을 받는 service에 진행 중 mutation이 있으면 기본적으로 거절한다.

DB lock만으로 외부 CLI 변경을 방지할 수 있다고 가정하지 않는다. Mutation 직전 Docker service의 Version.Index와 normalized spec fingerprint를 읽고, 실행 시 expected version을 조건으로 사용한다.

외부 변경이 감지되면:

- mutation 중단
- CONFLICT로 기록
- 다른 운영자의 변경을 덮어쓰지 않음
- 최신 state를 다시 읽은 뒤 사용자가 재시도

## 8. Release Rules

Production Deployment 규칙:

1. image digest 필수
2. Release 생성 시 digest 고정
3. 배포 시 tag 재해석 금지
4. registry에서 artifact 접근 가능 여부는 별도 검증
5. historical redeploy도 저장된 digest 사용

MVP의 Historical Redeploy 의미는 다음과 같다.

> 과거 Release의 immutable image digest를 **현재 DeploymentTarget의 runtime configuration**에 다시 배포한다.

과거 env/secret/network/config 전체를 자동 복원하지 않는다. 전체 service spec 복원은 별도 기능으로 취급한다.

Image rollback은 DB schema/data를 되돌리지 않는다. 운영 서비스는 backward-compatible migration 또는 별도 DB rollback 절차를 가져야 한다.

## 9. Deployment Preflight

배포 시작 전 확인:

- 사용자 authorization / resource scope
- manager quorum
- Agent availability
- DeploymentTarget 존재 및 replicated service 여부
- release digest 존재
- registry artifact 접근 가능
- 현재 service Version.Index
- current spec fingerprint
- running service operation 없음
- placement / resource reservation의 명백한 capacity 문제
- ingress publish mode

start-first를 사용할 자원이 부족하다고 판단되어도 자동으로 stop-first로 변경하지 않는다. 정책을 변경하려면 명시적 사용자 선택이 필요하다.

## 10. Rolling Deployment

기본 정책:

~~~yaml
deploy:
  update_config:
    parallelism: 1
    order: start-first
    failure_action: rollback
  rollback_config:
    parallelism: 1
    order: stop-first
    failure_action: pause
~~~

Docklane은 Swarm의 update/rollback 기능을 사용하되 명령 수락을 성공으로 보지 않는다.

## 11. Deployment Success Contract

Deployment SUCCESS는 최소 다음을 모두 만족해야 한다.

1. 관찰된 service spec image가 Release의 target digest와 일치
2. 관찰된 service spec fingerprint가 target fingerprint와 일치
3. Swarm update가 target spec 기준 terminal successful state로 수렴
4. desired replica와 running task가 수렴
5. rollback이 시작되거나 완료된 상태가 아님
6. application health probe가 설정된 stable window 동안 성공

단순히 replica 수와 LB health가 정상이라는 이유만으로 SUCCESS로 기록하지 않는다.

LB health는 서비스 가용성 신호이지 개별 새 task가 target version이라는 증거로 사용하지 않는다.

## 12. Health Verification

MVP는 두 계층을 사용한다.

### Swarm convergence

- service image digest
- service spec fingerprint
- update status
- desired/running task convergence
- timeout
- pending/error reason

### Application availability

기존 LB 또는 명시된 application endpoint를 통해 stable-window health를 검증한다.

~~~text
path
interval
timeout
successThreshold
failureThreshold
stableWindow
expectedStatus
~~~

## 13. Rollback Contract

Rollback 주체를 구분한다.

### Swarm automatic rollback

Swarm이 이미 rollback을 시작한 경우 Docklane은 동일 rollback 명령을 중복 실행하지 않고 상태를 관찰한다.

### Docklane initiated rollback

Swarm update가 성공했지만 application verification에서 실패하는 등 Docklane이 rollback을 시작해야 하는 경우에만 명시적으로 rollback을 요청한다.

Rollback 완료 조건:

1. 이전 spec/image로 수렴
2. expected replica 수 수렴
3. rollback update state가 terminal
4. recovery health stable-window 성공

흐름:

~~~text
FAILED
  ↓
ROLLING_BACK
  ↓
ROLLBACK_VERIFYING
  ├─ success → ROLLED_BACK
  └─ failure/timeout → ROLLBACK_FAILED
                       ↓
                 NEEDS_ATTENTION
~~~

명령이 수락되었다는 사실은 rollback 완료가 아니다.

## 14. Reconciliation & Crash Recovery

Control Plane 또는 Agent가 재시작되어도 진행 중 Operation의 의미가 사라지지 않아야 한다.

Mutation 시작 전 짧은 DB transaction으로 다음을 먼저 기록한다.

- operation ID
- actor
- target resource
- intended state
- before version/spec
- target version/spec
- idempotency key
- audit start event

실행 중에는 event stream과 polling을 함께 사용한다.

재시작 시:

1. non-terminal Operation 조회
2. 현재 service inspect
3. expected version/spec와 비교
4. 이미 목표 상태면 verification 재개
5. 이전 상태로 복구 중이면 rollback 관찰
6. 예상 외 변경이면 CONFLICT / NEEDS_ATTENTION
7. 필요할 때만 안전한 mutation 재시도

Docker events의 유실 또는 제한된 history에 의존해 복구하지 않는다.

Agent mutation 요청에는 operation ID, attempt/generation, expected Docker service version, target resource scope를 포함한다. 늦은 응답은 현재 generation과 맞지 않으면 무시한다.

## 15. Service Operations

### Scale

- service mutation lock 필요
- expected service version 필요
- operation/audit 기록
- 수렴 timeout 필요

### Restart

Swarm service force update를 사용한다.

- service mutation lock 필요
- expected version 필요
- deployment VERIFYING/ROLLING_BACK 중 실행 금지

### Node Drain

Drain은 Swarm service task에만 영향을 준다. docker run 또는 docker compose로 생성한 standalone container의 이동 기능으로 설명하지 않는다.

Drain 전:

- affected service 확인
- 진행 중 service mutation 확인
- placement/capacity preflight
- node mutation lock

## 16. Networking & Load Balancer

MVP는 **Swarm ingress routing mesh만 지원**한다.

Existing external LB → Swarm node published port → routing mesh → active task

MVP에서는 host publish mode와 dnsrr 직접 연동을 지원하지 않는다.

LB 경유 실제 traffic 검증은 별도 acceptance test로 수행한다. start-first는 신·구 task가 동시에 존재할 수 있는 여유 자원을 전제로 한다.

## 17. Node Bootstrap

Bootstrap automation은 P1 이후로 이동한다. MVP PoC는 수동 Swarm join을 사용한다.

향후 Docklane bootstrap token과 native Swarm join token은 별개의 credential로 취급한다.

Docklane token:

- one-time
- short TTL
- cluster/role/label scope

Native Swarm token:

- worker/manager별 cluster credential
- Docklane token 만료와 독립적
- 노출 의심 시 rotation 필요

Bootstrap 프로토콜은 동시 가입, retry, 부분 실패, role 검증, label 적용, token rotation 정책을 별도로 정의한 뒤 구현한다.

## 18. RBAC

기본 RBAC는 **최초 mutation 이전**에 구현한다.

### VIEWER

- read-only cluster/node/service/release/deployment/audit

### OPERATOR

VIEWER +

- deploy / rollback
- scale / restart
- node drain/activate

### ADMIN

OPERATOR +

- cluster/target 등록
- credentials
- secret/config
- user/role
- system settings

모든 mutation은 API와 Agent 양쪽에서 resource scope를 검증한다.

Agent는 전체 Docker spec 또는 임의 Docker 옵션을 그대로 전달받아 실행하지 않는다. 허용 operation별로 수정 가능한 field를 명시적으로 제한한다.

## 19. Agent Security

- Docker TCP 2375 외부 노출 금지
- Control Plane ↔ Agent mTLS
- private network 우선
- arbitrary shell endpoint 금지
- operation allow-list + field allow-list
- cluster/service resource scope 검증
- request expiry / replay protection
- certificate 발급·갱신·폐기·만료 정책 정의

## 20. API Draft

Prefix: /api/v1

핵심 endpoint:

~~~text
GET  /clusters
GET  /clusters/:clusterId/nodes
POST /clusters/:clusterId/nodes/:nodeId/drain
POST /clusters/:clusterId/nodes/:nodeId/activate

GET  /applications
POST /applications
GET  /applications/:applicationId/targets
POST /applications/:applicationId/targets

GET  /targets/:targetId
POST /targets/:targetId/scale
POST /targets/:targetId/restart

GET  /applications/:applicationId/releases
POST /applications/:applicationId/releases

GET  /deployments
POST /deployments
GET  /deployments/:deploymentId
GET  /deployments/:deploymentId/events
POST /deployments/:deploymentId/rollback

GET  /operations/:operationId
GET  /audit-events
~~~

## 21. Functional PoC vs Production Readiness

### Functional PoC

최소 구성:

~~~text
manager-01
worker-01
worker-02
~~~

이 구성은 배포, worker 장애, drain, rollback 같은 기능 검증용이다. manager 장애 허용을 검증하는 HA 구성으로 보지 않는다.

### Production readiness validation

최소 3 managers에서 다음을 별도로 검증한다.

- leader 1대 상실
- quorum 유지 상태의 mutation
- quorum 상실 시 mutation 차단
- network partition
- Agent/manager endpoint failover
- manager resource starvation 방지
- Swarm backup/restore
- Docklane DB / encryption key / agent trust 복구

Manager와 workload를 동일 VM에서 겸할 경우 manager 자원을 reservation/운영 정책으로 보호해야 한다.

## 22. Acceptance Criteria

기능 검증:

1. 정상 digest deployment는 target digest/spec/health가 모두 일치할 때만 SUCCESS
2. broken release의 Swarm automatic rollback을 새 Release 성공으로 오판하지 않음
3. VERIFYING 중 scale/restart/동시 deployment 거절
4. 외부 CLI 변경 시 version/spec conflict 감지
5. Docker update 수락 직후 Control Plane 종료 후 reconcile
6. Agent 응답 유실/event gap에서 actual state로 복구
7. rollback 실패/timeout을 ROLLBACK_FAILED 또는 NEEDS_ATTENTION으로 표시
8. start-first capacity 부족과 placement 제약에 timeout/원인 표시
9. LB 경유 실제 traffic에서 rolling update 오류율/연결 종료 관찰
10. 권한 없는 mutation을 API/Agent 양쪽에서 거절
11. 모든 mutation에 secret 없는 audit event 생성

Production readiness는 별도 3-manager HA/backup/restore validation을 통과해야 한다.

## 23. References

- https://docs.docker.com/engine/swarm/
- https://docs.docker.com/engine/swarm/services/
- https://docs.docker.com/engine/swarm/ingress/
- https://docs.docker.com/engine/swarm/admin_guide/
- https://docs.docker.com/reference/cli/docker/service/update/
- https://docs.docker.com/reference/cli/docker/system/events/
- https://docs.docker.com/reference/cli/docker/swarm/join-token/
