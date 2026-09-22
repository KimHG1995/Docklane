# Docklane Product & Technical Specification

Version: **0.1**  
Status: **Draft / pre-alpha**

## 1. Summary

Docklane은 비용 제약 환경에서 기존 Linux VM과 Docker Swarm을 활용해 컨테이너 배포와 운영에 필요한 핵심 기능을 제공하는 경량 self-hosted deployment control plane이다.

목표는 Kubernetes나 관리형 오케스트레이션 서비스를 복제하는 것이 아니라, Docker Swarm이 제공하는 실행 엔진 위에 운영자가 실제로 필요한 release, deployment, rollback, node lifecycle, audit workflow를 제공하는 것이다.

## 2. Problem

기존 VM 중심 운영은 다음 반복 비용을 만든다.

- 신규 서버마다 Docker/runtime/configuration 구성
- 여러 서버에 동일 버전을 수동 또는 스크립트로 배포
- 서버 장애 시 workload 상태 확인과 재배치 판단
- 배포 실패 시 수동 rollback
- 어느 image/commit이 언제 배포되었는지 추적 어려움
- 서버 점검 시 workload 이동 절차 반복
- 운영 변경 이력과 담당자 추적 분산

관리형 플랫폼은 이를 줄여주지만 비용, 네트워크 제약, 폐쇄망 또는 서비스 제약 때문에 도입하기 어려운 환경이 존재한다.

## 3. Goals

### P0

- Swarm cluster/node/service/task 상태 조회
- Manager quorum 상태 표시
- Node label 관리
- Node active/drain 전환
- Service replica scale
- Service restart
- Release 등록
- Image tag/digest 추적
- Rolling deployment
- Application-level health verification
- Automatic rollback
- Manual rollback
- Historical redeploy
- Deployment ticket/history
- Audit log
- One-time bootstrap token과 node join script
- 기본 RBAC

### P1

- Docker Config / Secret 관리
- Registry browser
- Environment promotion
- Scheduled deployment
- Approval workflow
- Deployment diff
- Stack YAML editor/validator
- Capacity dashboard
- Notification integration
- Swarm backup status

### P2

- Cloud VM provisioning adapter
- Load balancer registration adapter
- Horizontal auto scaling
- Metrics/logging integrations
- Vulnerability scanner integration
- Multi-cluster global dashboard

## 4. Non-goals

- Kubernetes API/CRD 호환
- 자체 scheduler
- 자체 service discovery
- 자체 overlay network
- 자체 container runtime
- CI/build server
- container registry
- Terraform 대체
- database orchestration
- service mesh
- GitOps engine
- multi-region scheduler

## 5. System Boundary

```text
Source Code
   │
   ▼
Existing CI
   │ build/test/push
   ▼
OCI Registry
   │
   ▼
Docklane Release
   │
   ▼
Deployment
   │
   ▼
Docker Swarm
```

Docklane의 기본 책임은 image가 registry에 push된 이후부터 시작한다.

## 6. Core Domain

### Cluster

하나의 Docker Swarm cluster.

Fields:

```text
id
name
environment
status
managerCount
workerCount
createdAt
updatedAt
```

### Node

Swarm node의 Docklane projection.

```text
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
```

Role:

- MANAGER
- WORKER

Availability:

- ACTIVE
- PAUSE
- DRAIN

### Application

운영자가 인식하는 애플리케이션 단위. 하나 이상의 Swarm service를 포함할 수 있다.

```text
id
clusterId
name
description
stackName
createdAt
updatedAt
```

### Service

```text
id
applicationId
dockerServiceId
name
image
replicas
cpuLimit
memoryLimit
healthCheck
updatePolicy
rollbackPolicy
placement
createdAt
updatedAt
```

### Release

배포 가능한 immutable application version.

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

Release와 Deployment는 분리한다. 동일 Release를 staging과 production에 각각 배포할 수 있어야 한다.

### Deployment

특정 Release를 특정 cluster/environment에 반영하는 행위.

```text
id
releaseId
clusterId
previousReleaseId
status
reason
startedAt
finishedAt
createdBy
createdAt
```

Status:

```text
PENDING
READY
DEPLOYING
VERIFYING
SUCCESS
FAILED
ROLLING_BACK
ROLLED_BACK
CANCELLED
```

### DeploymentEvent

```text
id
deploymentId
type
message
metadata
createdAt
```

### AuditEvent

```text
id
actorId
clusterId
resourceType
resourceId
action
before
after
sourceIp
createdAt
```

## 7. Functional Requirements

### 7.1 Dashboard

표시 항목:

- cluster health
- node healthy/total
- manager quorum
- services count
- running/desired tasks
- degraded services
- recent deployments
- recent failures/rollbacks

### 7.2 Node Management

- node list/detail
- labels 조회/변경
- Active → Drain
- Drain → Active
- running task 확인
- role/status 표시

Drain은 Docker Swarm의 scheduler 동작을 사용한다. Docklane이 task migration 로직을 직접 구현하지 않는다.

### 7.3 Node Bootstrap

VM 생성은 MVP 범위 밖이다.

흐름:

```text
Create VM
  -> Generate one-time bootstrap token
  -> Run bootstrap script
  -> Install/validate Docker
  -> Join Swarm
  -> Apply labels
  -> Report health
```

Bootstrap token 조건:

- one-time
- short TTL
- target cluster 고정
- role 고정
- allowed labels 고정
- 사용 후 폐기

### 7.4 Service Management

조회:

- image
- replicas
- task status
- ports
- networks
- CPU/memory limits
- placement
- health
- update/rollback policy

Mutation:

- scale
- force restart
- image update through deployment only

운영 image 변경은 Service 화면의 임의 수정이 아니라 Release → Deployment 흐름을 기본으로 한다.

### 7.5 Release

Release 생성 시 가능한 경우 registry에서 digest를 resolve한다.

저장:

- repository
- tag
- digest
- git commit
- build number

운영 배포의 canonical identifier는 가능하면 digest를 사용한다.

### 7.6 Deployment Ticket

최소 필드:

- requester
- reason
- release
- environment
- current version
- target version
- created/started/finished time
- result

MVP에서는 복잡한 전자결재 시스템을 구현하지 않는다.

### 7.7 Rolling Deployment

기본 권장 설정:

```yaml
deploy:
  update_config:
    parallelism: 1
    order: start-first
    failure_action: rollback
  rollback_config:
    parallelism: 1
    order: stop-first
```

사용자가 정책을 변경할 수 있더라도 unsafe 값에 대한 validation과 경고를 제공한다.

### 7.8 Health Verification

배포 성공 조건은 Docker task 상태만으로 판단하지 않는다.

```text
desired replicas == running replicas
AND
application health verification == success
```

Application health configuration:

```text
path
interval
timeout
retries
expectedStatus
```

### 7.9 Rollback

두 종류를 구분한다.

**Immediate rollback**

Docker Swarm의 직전 service configuration rollback을 사용한다.

**Historical redeploy**

Docklane Release History에서 과거 Release를 선택하고 새로운 Deployment를 생성한다.

과거 deployment row를 수정하거나 current state를 덮어쓰지 않는다.

### 7.10 Deployment Progress

MVP는 SSE를 사용한다.

표시:

- deployment state
- service
- task
- node
- previous/current image
- update progress
- health result
- rollback progress
- error reason

### 7.11 Deployment Lock

동일 cluster/service에서 동시에 두 개의 mutation deployment를 실행하지 않는다.

Logical key:

```text
deployment:{clusterId}:{serviceId}
```

### 7.12 Stack

Docklane은 필요 시 application을 Docker Stack으로 배포할 수 있다.

주의:

- `docker stack deploy`는 Swarm manager에서 수행
- Stack file의 `build:`를 production deployment source로 사용하지 않음
- registry에 이미 존재하는 image 사용
- 최신 Compose Specification 전체가 아니라 Docker Stack이 지원하는 Compose v3 호환 범위로 validation

## 8. RBAC

### VIEWER

- dashboard
- cluster/node/service 조회
- release/deployment/audit 조회

### OPERATOR

VIEWER +

- deploy
- rollback
- scale
- restart
- node drain/activate

### ADMIN

OPERATOR +

- cluster 등록
- bootstrap token
- secret/config
- user/role
- system settings

## 9. API Draft

Prefix:

```text
/api/v1
```

Cluster:

```http
GET  /clusters
POST /clusters
GET  /clusters/:clusterId
GET  /clusters/:clusterId/health
```

Node:

```http
GET  /clusters/:clusterId/nodes
GET  /clusters/:clusterId/nodes/:nodeId
POST /clusters/:clusterId/nodes/:nodeId/drain
POST /clusters/:clusterId/nodes/:nodeId/activate
POST /clusters/:clusterId/join-tokens
```

Application/Service:

```http
GET  /applications
POST /applications
GET  /applications/:applicationId

GET  /services/:serviceId
POST /services/:serviceId/scale
POST /services/:serviceId/restart
```

Release:

```http
GET  /applications/:applicationId/releases
POST /applications/:applicationId/releases
GET  /releases/:releaseId
```

Deployment:

```http
GET  /deployments
POST /deployments
GET  /deployments/:deploymentId
GET  /deployments/:deploymentId/events
POST /deployments/:deploymentId/rollback
POST /deployments/:deploymentId/cancel
```

Audit:

```http
GET /audit-events
```

## 10. Failure Handling

### Agent unavailable

- mutation 차단
- `AGENT_UNAVAILABLE` 표시

### Registry resolve failure

- deployment 시작 전 실패
- `IMAGE_RESOLVE_FAILED`

### Insufficient capacity

- task가 scheduling되지 못하면 cluster capacity 문제로 분류
- pending reason 표시

### Application health failure

```text
VERIFYING
  -> FAILED
  -> ROLLING_BACK
  -> ROLLED_BACK
```

### Lost manager quorum

- cluster를 DEGRADED 또는 READ_ONLY로 표시
- deploy/scale/drain 등 mutation 차단
- 기존 running workload와 control-plane mutability를 구분해서 보여줌

## 11. Security Requirements

- Docker daemon TCP 2375 외부 노출 금지
- Control Plane ↔ Agent mTLS
- Agent는 allow-listed operation만 제공
- arbitrary shell endpoint 금지
- bootstrap token one-time + TTL
- secret 값 API 응답 금지
- secret 값 audit/log 금지
- registry credential encrypted at rest
- RBAC
- mutation audit
- session/access token expiration
- CSRF/authorization validation
- Swarm network ports는 trusted private network에서만 허용

## 12. MVP Acceptance Criteria

최소 3개 VM에서 검증한다.

```text
manager-01
worker-01
worker-02
```

Required cases:

1. 정상 release를 rolling deployment
2. broken release 배포 후 automatic rollback
3. worker 장애 시 task 재스케줄 확인
4. worker drain 후 task 이동 확인
5. replica 4 → 8 → 3 변경
6. 과거 release로 historical redeploy
7. 모든 mutation의 audit event 생성
8. manager quorum degraded 상태에서 mutation 차단

CLI 없이 Web UI에서 다음 흐름이 완료되어야 v0.1의 핵심 기능이 충족된 것으로 본다.

```text
Select Application
  -> Select Release
  -> Create Deployment
  -> Rolling Update
  -> Verify Health
  -> Success
```

실패 시:

```text
Deploy
  -> Health Failure
  -> Automatic Rollback
  -> Verify Rollback
```

## 13. Official References

- https://docs.docker.com/engine/swarm/
- https://docs.docker.com/engine/swarm/services/
- https://docs.docker.com/engine/swarm/stack-deploy/
- https://docs.docker.com/engine/swarm/secrets/
- https://docs.docker.com/engine/swarm/configs/
