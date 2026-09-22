# Docklane

**Lightweight, self-hosted deployment control plane for cost-constrained VM infrastructure.**

Docklane은 관리형 컨테이너 플랫폼 도입이 부담스러운 환경에서 기존 Linux VM과 Docker Swarm을 활용해 배포, 확장, 롤백, 노드 운영, 릴리스 이력과 감사 로그를 하나의 UI에서 관리하기 위한 오픈소스 프로젝트입니다.

> Status: **Specification / pre-alpha**  
> 현재 저장소는 설계 단계이며 운영 환경 사용을 권장하지 않습니다.

## Why Docklane?

기존 VM을 직접 운영하면 관리형 서비스 비용을 줄일 수 있는 여지가 있지만, 서버별 런타임 구성, 배포 스크립트, 장애 대응, 롤백, 변경 이력을 직접 관리해야 합니다.

Docklane은 이 구조의 **총비용 우위가 아직 검증되지 않았음**을 전제로 합니다. VM 비용뿐 아니라 DB, 백업, 인증서, 플랫폼 유지보수와 장애 대응 시간까지 실제 PoC에서 비교합니다.

Docklane은 Docker Swarm이 이미 제공하는 오케스트레이션 기능을 재구현하지 않습니다.

- **Docker Swarm**: desired state, scheduling, replica, service discovery, rolling update, rollback
- **Docklane**: release, safe mutation, deployment verification, rollback verification, reconciliation, audit, operational UI
- **Existing CI**: source build, test, container image build/push
- **Existing Registry**: OCI image storage
- **Existing Load Balancer**: external traffic entry point

## MVP Scope

첫 구현은 범위를 작게 유지합니다.

- single Swarm cluster
- application당 single stateless replicated service
- existing OCI registry
- existing external load balancer
- Swarm ingress routing mesh
- existing service binding
- immutable image digest deployment
- manual Swarm join

초기 MVP에서는 multi-service Stack, host publish mode, VM provisioning, bootstrap automation, environment promotion을 지원하지 않습니다.

## Goals

- 기존 VM을 재사용할 수 있는 경량 구조
- 여러 호스트의 Docker workload를 하나의 화면에서 관리
- immutable image digest 기반 release 추적
- Rolling deployment와 target spec 검증
- rollback 완료와 복구 health 검증
- deploy/scale/restart/rollback 동시 변경 직렬화
- API/Agent 재시작 후 실제 Docker state reconciliation
- Node drain, replica scale 등 반복 운영 작업 단순화
- Deployment ticket과 audit log를 통한 변경 추적
- 특정 Cloud Provider에 강하게 종속되지 않는 core architecture

## Non-goals

Docklane은 다음을 목표로 하지 않습니다.

- Kubernetes 대체 구현
- 자체 container runtime / scheduler / overlay network
- VM provisioning 플랫폼
- CI 또는 container registry 대체
- Stateful database orchestration
- Service mesh 또는 범용 observability 플랫폼

## Architecture

~~~mermaid
flowchart LR
    Git["Git / GitHub"] --> CI["Existing CI"]
    CI --> Registry["OCI Registry"]
    Registry --> CP["Docklane Control Plane"]

    User["Operator"] --> Web["Docklane Web"]
    Web --> CP

    CP --> DB["Docklane DB"]
    CP --> Agent["Swarm Agent"]
    Agent --> Manager["Docker Swarm Manager"]

    Manager --> W1["Worker 1"]
    Manager --> W2["Worker 2"]
    Manager --> W3["Worker 3"]

    LB["Existing Load Balancer"] --> W1
    LB --> W2
    LB --> W3
~~~

Docklane은 Docker Engine API를 외부에 직접 노출하지 않고, Swarm manager 내부의 제한된 Agent를 통해 허용된 작업만 수행합니다.

자세한 내용은 [Architecture](docs/ARCHITECTURE.md)를 참고하세요.

## Safe Deployment Contract

배포 성공은 단순히 "replica 수가 맞고 /health가 200"인 것으로 판단하지 않습니다.

최소 다음을 확인합니다.

1. Service image가 Release의 target digest와 일치
2. Service spec이 배포 목표 spec에 수렴
3. Swarm update가 정상 종료
4. Desired/running replica가 수렴
5. Automatic rollback이 발생하지 않음
6. Application health가 stable window 동안 정상

Rollback 역시 명령 수락이 아니라 **이전 spec으로 실제 수렴하고 recovery health가 정상일 때** 완료로 기록합니다.

## MVP Delivery Flow

~~~text
Existing CI
  -> Push immutable image
  -> Create Release
  -> Select DeploymentTarget
  -> Persist Operation intent
  -> Rolling Update
  -> Reconcile target digest/spec
  -> Verify health
  -> SUCCESS

Failure
  -> Observe or initiate rollback
  -> Verify previous spec
  -> Verify recovery health
  -> ROLLED_BACK / NEEDS_ATTENTION
~~~

전체 요구사항은 [Specification](docs/SPEC.md), 개발 순서는 [Roadmap](docs/ROADMAP.md)을 참고하세요.

## Concept Mapping

| Docklane | Docker |
| --- | --- |
| Cluster | Swarm |
| Node | Swarm node |
| DeploymentTarget | Existing Swarm service binding |
| Service | Swarm service |
| Instance | Task / container |
| Scale | Service replicas |
| Deploy | Service update |
| Immediate rollback | Service rollback |
| Config | Docker config |
| Secret | Docker secret |

Multi-service Stack support는 MVP 이후 범위입니다.

## Planned Stack

- **Web**: Next.js, TypeScript
- **API**: NestJS, TypeScript, Zod
- **Database**: MySQL / MariaDB
- **Agent**: TypeScript/Node.js first, Go 검토 가능
- **Runtime**: Docker Engine + Swarm
- **Repository**: Monorepo

예상 구조:

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

## Design Principles

1. **Reuse before rebuild** — Docker가 제공하는 기능을 다시 만들지 않습니다.
2. **Build and deploy are separate** — Docklane은 image build server가 아닙니다.
3. **Immutable releases** — production Release는 image digest를 필수로 합니다.
4. **Actual state wins** — event만 믿지 않고 Docker inspect 기반으로 reconcile합니다.
5. **Serialize mutations** — deploy, rollback, scale, restart는 동일 service 기준으로 직렬화합니다.
6. **Safe by default** — Docker socket/TCP daemon을 외부에 직접 노출하지 않습니다.
7. **Audit operational changes** — 모든 mutation의 실행 의도와 결과를 기록합니다.
8. **Provider adapters** — NCP, AWS 등 provider-specific 기능은 core domain과 분리합니다.

## Security

Docklane은 인프라 변경 권한을 가지는 control plane이므로 최초 mutation 이전에 인증·기본 RBAC·Agent authorization을 갖추는 것을 요구합니다.

초기 보안 원칙:

- Docker TCP 2375 외부 노출 금지
- Control Plane ↔ Agent mTLS
- Agent arbitrary shell execution 금지
- Operation / field allow-list
- API와 Agent 양쪽에서 resource scope 검증
- Secret 값 조회/로그 출력 금지
- Registry credential 암호화 저장
- Mutation audit
- Manager quorum 상실 시 mutation 차단

보안 취약점 제보 정책은 [SECURITY.md](SECURITY.md)를 참고하세요.

## Validation Profiles

### Functional PoC

~~~text
manager-01
worker-01
worker-02
~~~

배포, worker 장애, drain, scale, rollback/reconciliation 검증용입니다. Manager HA를 검증하는 구성은 아닙니다.

### Production readiness

최소 3 managers에서 leader loss, quorum loss, network partition, backup/restore를 별도로 검증합니다.

## Documentation

- [Product & Technical Specification](docs/SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## References

Docklane 설계는 Docker의 공식 Swarm 기능을 기반으로 합니다.

- [Swarm mode](https://docs.docker.com/engine/swarm/)
- [Deploy services to a swarm](https://docs.docker.com/engine/swarm/services/)
- [Routing mesh](https://docs.docker.com/engine/swarm/ingress/)
- [Swarm administration](https://docs.docker.com/engine/swarm/admin_guide/)
- [Service update / rollback](https://docs.docker.com/reference/cli/docker/service/update/)
- [Docker events](https://docs.docker.com/reference/cli/docker/system/events/)

> Multi-service Stack을 지원하는 경우에도 `docker stack deploy`의 legacy Compose v3 호환 범위를 기준으로 검증합니다.

## License

[MIT License](LICENSE)
