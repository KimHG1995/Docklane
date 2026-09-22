# Architecture

## Overview

Docklane은 Docker Swarm 위에서 동작하는 deployment control plane이다. Scheduler나 container runtime을 직접 구현하지 않고 Docker Engine/Swarm의 desired state를 사용하며, Docklane은 release, safe mutation, rollback verification, recovery, audit를 담당한다.

MVP는 다음 범위로 제한한다.

- single Swarm cluster
- application당 single stateless replicated service
- existing OCI registry
- existing external load balancer
- ingress routing mesh
- existing service binding
- immutable image digest deployment

## Components

~~~mermaid
flowchart TB
    Operator["Operator"] --> Web["Docklane Web"]
    Web --> API["Control Plane API"]

    API --> DB["Docklane DB"]
    API --> Registry["Registry Adapter"]
    API --> Agent["Swarm Agent"]

    Agent --> Socket["Docker Unix Socket"]
    Socket --> Manager["Swarm Manager"]

    Manager --> W1["Worker 1"]
    Manager --> W2["Worker 2"]
    Manager --> W3["Worker 3"]

    LB["Existing Load Balancer"] --> W1
    LB --> W2
    LB --> W3
~~~

### Web

- dashboard
- cluster/node/service read model
- application/target/release UI
- deployment/rollback progress
- operations and audit
- settings

Initial candidate: Next.js + TypeScript.

### Control Plane API

- authentication / RBAC
- resource-scope authorization
- domain validation
- release/deployment state machine
- mutation coordinator
- operation lease/reconciliation
- audit
- registry adapter
- agent communication
- health verification

Initial candidate: NestJS + TypeScript + Zod.

### Database

Docker는 runtime state의 source of truth다. Docklane DB는 운영 의도와 이력의 source of record다.

DB에 저장:

- logical applications
- deployment targets
- immutable releases
- deployments
- durable operations
- deployment events
- users/roles
- audit events
- registry configuration
- agent identity/certificate metadata

Docker runtime state 전체를 DB에 복제해 authoritative state로 사용하지 않는다.

### Swarm Agent

Agent는 Swarm manager의 Docker Engine API에 접근하는 좁은 execution boundary다.

허용 역할:

- cluster/node/service/task inspect
- precondition 확인
- service image update
- service scale / force restart
- service rollback
- node drain / activate
- Docker event forwarding

금지:

- arbitrary shell execution
- caller가 전달한 raw Docker spec의 무검증 적용
- caller가 임의 field를 수정하는 generic update endpoint

Agent operation은 operation type, target resource, allowed field를 기준으로 allow-list한다.

## Trust Boundaries

~~~mermaid
flowchart LR
    Browser["Browser"] -->|HTTPS| Control["Control Plane"]
    Control -->|mTLS| Agent["Swarm Agent"]
    Agent -->|Unix Socket| Docker["Docker Engine"]
    Docker --> Swarm["Swarm Network"]
    Control -->|TLS| Registry["OCI Registry"]
~~~

Required rules:

- Docker daemon TCP 2375 외부 노출 금지
- Agent는 private network 우선
- Control Plane ↔ Agent mTLS
- request expiry / replay protection
- certificate issuance / renewal / revocation lifecycle
- secret value를 API/event/audit/log에 기록하지 않음
- 모든 mutation은 API와 Agent에서 resource scope 검증

## Domain Boundary

~~~text
Application
  ├─ Release (environment independent, immutable digest)
  └─ DeploymentTarget
       ├─ Cluster
       └─ Existing Swarm Service
            └─ Deployment
~~~

Application은 cluster에 종속되지 않는다.

DeploymentTarget이 application과 실제 environment/service를 연결한다.

MVP에서는 하나의 target이 하나의 stateless replicated service에 연결된다. Multi-service release manifest는 후속 범위다.

## Durable Operation Model

deploy, rollback, scale, restart, node drain 같은 mutation은 durable Operation을 생성한다.

~~~text
Operation
  id
  kind
  resourceKey
  idempotencyKey
  intendedState
  expectedResourceVersion
  attempt
  leaseOwner
  leaseExpiresAt
  lastReconciledAt
~~~

Mutation은 명령을 보내기 전에 DB transaction으로 operation intent와 audit start를 기록한다.

Docker event stream은 progress signal로 사용할 수 있지만 recovery source of truth로 사용하지 않는다. 실제 상태는 service/node inspect와 polling으로 reconcile한다.

## Mutation Coordination

동일 service에 영향을 주는 다음 작업은 하나의 resource lock을 공유한다.

- deploy
- rollback
- scale
- restart

Resource key:

~~~text
service:{clusterId}:{dockerServiceId}
~~~

Node drain은 node-level operation이지만 영향을 받는 service를 preflight한다. 진행 중 service mutation이 있으면 기본적으로 drain을 거절한다.

DB lock은 Docklane 내부 동시성만 제어한다. 외부 CLI나 다른 관리 도구의 변경은 Docker resource version과 normalized spec fingerprint로 감지한다.

Mutation request에는 expected Docker service Version.Index를 포함한다. Version/spec이 예상과 다르면 충돌로 종료하고 최신 상태를 덮어쓰지 않는다.

## Safe Deployment Flow

~~~mermaid
sequenceDiagram
    participant CI as Existing CI
    participant R as Registry
    participant C as Docklane
    participant A as Agent
    participant S as Swarm
    participant H as Health Endpoint

    CI->>R: Push image
    C->>R: Resolve immutable digest
    C->>C: Create Release
    C->>S: Inspect target service
    C->>C: Persist Operation + before/target spec
    C->>A: Update with expected service version
    A->>S: Update service to target digest

    loop Reconcile
        C->>A: Inspect service/tasks
        A-->>C: Actual state
    end

    alt Swarm rolls back
        C->>C: Detect rollback state
        C->>C: Do not send duplicate rollback
        C->>C: Verify previous spec convergence
        C->>H: Recovery health stable window
        C->>C: ROLLED_BACK or ROLLBACK_FAILED
    else Target converged
        C->>H: Application health stable window
        alt Healthy
            C->>C: SUCCESS
        else Unhealthy
            C->>A: Roll back once
            A->>S: Rollback
            C->>C: Verify previous spec + health
        end
    end
~~~

## Deployment Success Contract

SUCCESS는 다음을 모두 만족해야 한다.

1. service image == target immutable digest
2. normalized service spec == target fingerprint
3. update가 target spec으로 terminal convergence
4. desired/running tasks 수렴
5. automatic rollback이 시작/완료된 상태가 아님
6. application health stable-window 성공

단순히 running replica 수와 LB health가 정상인 것만으로 성공 처리하지 않는다.

## Rollback Arbitration

Swarm automatic rollback과 Docklane initiated rollback을 구분한다.

- Swarm이 이미 rollback 중이면 Docklane은 관찰만 한다.
- Swarm target update가 완료된 뒤 Docklane application verification이 실패한 경우 등 필요한 때만 Docklane이 rollback을 시작한다.
- rollback command accepted와 rollback complete를 분리한다.

~~~mermaid
stateDiagram-v2
    [*] --> PENDING
    PENDING --> READY
    READY --> DEPLOYING
    DEPLOYING --> VERIFYING
    VERIFYING --> SUCCESS

    DEPLOYING --> FAILED
    VERIFYING --> FAILED
    FAILED --> ROLLING_BACK
    ROLLING_BACK --> ROLLBACK_VERIFYING
    ROLLBACK_VERIFYING --> ROLLED_BACK
    ROLLBACK_VERIFYING --> ROLLBACK_FAILED
    ROLLBACK_FAILED --> NEEDS_ATTENTION

    PENDING --> CANCELLED
    READY --> CANCELLED
~~~

Rollback verification은 이전 image/spec convergence와 recovery health를 모두 확인한다.

## Crash Recovery & Reconciliation

Control Plane/API가 Docker update 요청 직후 종료될 수 있다는 전제로 설계한다.

재시작 시:

1. non-terminal Operation 조회
2. actual Docker service inspect
3. before/target spec과 Version.Index 비교
4. target이 이미 반영되었으면 verification 재개
5. rollback 상태면 recovery verification 재개
6. 예상하지 않은 spec이면 CONFLICT / NEEDS_ATTENTION
7. 안전성이 확인되는 경우에만 retry

Event history가 부족하거나 연결이 끊겨도 현재 Docker state만으로 복구할 수 있어야 한다.

늦은 응답은 operation generation/attempt가 현재 execution과 맞지 않으면 무시한다.

## Release Semantics

Production Release는 digest가 필수다.

~~~text
repository: example/api
tag: 1.4.2
digest: sha256:...
~~~

Tag는 display metadata다. 배포 시 tag를 다시 resolve하지 않는다.

Historical Redeploy는 과거 digest를 현재 DeploymentTarget configuration에 적용하는 새 Deployment다.

과거 secret/env/network 전체를 자동 복원하지 않는다.

DB migration/data rollback은 Docklane image rollback 범위가 아니다.

## Networking

MVP는 Swarm ingress routing mesh만 지원한다.

~~~text
External LB
   ↓
Published port on Swarm nodes
   ↓
Ingress routing mesh
   ↓
Active service task
~~~

Host publish mode와 dnsrr external LB integration은 후속 범위다.

LB health는 availability signal로 사용하며 task가 target digest라는 증거로 사용하지 않는다.

## Capacity & Start-first

start-first는 old/new task가 동시에 실행될 여유 자원을 요구한다.

Preflight에서 다음을 가능한 범위에서 확인한다.

- resource reservation
- placement constraints
- active node availability

실제 scheduler가 task를 pending으로 둘 수 있으므로 deployment에는 explicit convergence timeout과 pending reason이 필요하다.

자원 부족 시 자동으로 stop-first로 downgrade하지 않는다.

## Node Drain Boundary

Swarm drain은 Swarm service task에만 적용된다.

Standalone docker run 또는 docker compose container를 다른 node로 이동시키는 기능이 아니다.

Node-local state나 local volume에 의존하는 workload는 MVP 지원 범위 밖이다.

## Manager Quorum

운영 UI에서 manager quorum을 명시적으로 표시한다.

~~~text
Managers: 3 / 3 healthy
Quorum required: 2
Fault tolerance: 1
~~~

Quorum 상실 시 기존 task 실행 여부와 cluster mutation 가능 여부를 별도로 표현하고 mutation을 차단한다.

## Validation Profiles

### Functional PoC

~~~text
manager-01
worker-01
worker-02
~~~

목적:

- rolling deployment
- worker failure
- drain
- scale
- rollback/recovery

이 구성은 manager HA를 검증하지 않는다.

### Production Readiness

3 managers에서 별도 검증:

- leader loss
- quorum loss
- network partition
- Agent manager endpoint failover
- manager resource contention
- Swarm backup/restore
- Docklane DB/key/trust restore

3 managers가 workload도 겸할 수 있으나 manager의 CPU/memory/disk starvation을 방지해야 한다.

## Stack Compatibility

Multi-service Stack은 MVP 이후 기능이다.

지원 시 docker stack deploy의 legacy Compose v3 compatibility 범위만 허용하고 최신 Compose Specification 전체를 지원한다고 표현하지 않는다.

Validation pipeline:

~~~text
YAML Parse
  -> Schema Validation
  -> Swarm Compatibility Validation
  -> docker stack config
  -> Deployment
~~~

Production Stack은 build에 의존하지 않고 registry의 immutable image를 사용한다.

## Repository Direction

~~~text
.
├── apps/
│   ├── web/
│   ├── api/
│   └── agent/
├── packages/
│   ├── contracts/
│   ├── docker/
│   ├── config/
│   └── ui/
├── deploy/
├── docs/
└── scripts/
~~~

Docker-specific operation은 business service에서 command string으로 직접 조립하지 않고 adapter 뒤에 둔다.

## References

- https://docs.docker.com/engine/swarm/
- https://docs.docker.com/engine/swarm/services/
- https://docs.docker.com/engine/swarm/ingress/
- https://docs.docker.com/engine/swarm/admin_guide/
- https://docs.docker.com/reference/cli/docker/service/update/
- https://docs.docker.com/reference/cli/docker/system/events/
