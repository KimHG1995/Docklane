# Security Policy

Docklane은 Docker Swarm과 운영 인프라를 변경할 수 있는 control plane을 목표로 합니다. 따라서 모든 mutation 기능은 보안 경계가 구현된 이후에만 노출합니다.

## Project Status

Docklane은 현재 **pre-alpha / specification 단계**이며 production 사용을 지원하지 않습니다.

| Version | Supported |
| --- | --- |
| main / pre-alpha | Security fixes on best-effort basis |
| Production release | Not available yet |

## Reporting a Vulnerability

민감한 취약점은 공개 Issue에 상세 내용을 작성하지 마세요.

GitHub의 **Private vulnerability reporting** 기능이 활성화되어 있다면 이를 우선 사용합니다. 사용할 수 없는 경우 maintainer에게 비공개 연락 경로를 요청하되 exploit, credential, 개인정보를 공개 Issue에 포함하지 마세요.

## Security Baseline

최초 mutation release 전에 다음이 필수다.

- authentication
- 기본 RBAC
- cluster/resource scope validation
- 모든 mutation audit
- Docker daemon unauthenticated TCP endpoint 금지
- Swarm control/data-path 통신은 허가된 cluster node의 trusted/private network로 제한
- TCP 2377, TCP/UDP 7946, UDP 4789 또는 설정된 data-path port의 untrusted/public 접근 차단
- Control Plane ↔ Agent mTLS
- Agent arbitrary shell execution 금지
- Agent operation별 field/target allow-list
- registry credential encrypted at rest
- secret value API/log/audit 출력 금지
- manager quorum 상실 시 mutation 차단
- service version/spec precondition 검증

## Swarm Network Boundary

Swarm node 간 control/data-path 포트는 인터넷 또는 비신뢰 네트워크에 노출하지 않는다.

기본 포트:

- `2377/TCP`: manager control plane
- `7946/TCP/UDP`: node discovery / communication
- `4789/UDP`: overlay/VXLAN data path

`--data-path-port`로 4789를 변경한 경우에도 동일하게 해당 UDP 포트를 허가된 cluster node 사이에서만 허용한다.

특히 VXLAN data-path는 자체 인증을 제공하지 않으므로 public/perimeter firewall에서 접근 가능하게 구성하지 않는다. Swarm traffic이 통과하는 네트워크를 완전히 신뢰할 수 없다면 encrypted overlay network 적용을 별도로 검토한다.

## Agent Boundary

Agent는 Docker API를 범용 프록시하지 않는다.

허용된 high-level operation만 제공하고 각 요청에서 다음을 다시 검증한다.

- authenticated control-plane identity
- cluster binding
- target service/node
- allowed fields
- expected resource/version precondition

클라이언트가 제공한 shell command, Docker CLI argument 또는 임의 service spec을 그대로 실행해서는 안 된다.

## mTLS Lifecycle

설계/구현 시 다음 lifecycle을 포함한다.

- certificate issuance
- expiration
- rotation
- revocation
- compromised credential replacement

인증서를 한번 발급하고 영구 사용하는 구조는 허용하지 않는다.

## Bootstrap Credentials

Docklane bootstrap token과 Docker native Swarm join token은 별개다.

Docklane token의 one-time/TTL 특성이 native join token까지 자동 무효화한다고 가정하지 않는다.

Bootstrap 구현 시 native token 전달, rotation, 동시 join, partial failure, post-join identity verification을 별도 threat model로 검토한다.

## Mutation Safety as Security

인증된 운영자라도 stale state를 기반으로 다른 운영자의 변경을 덮어써서는 안 된다.

따라서 mutation은:

- current Docker service version/spec 확인
- expected precondition 검증
- service-level serialization
- external change conflict detection

을 수행한다.

## Dependency Security

구현 단계부터 다음 자동화를 목표로 한다.

- lockfile reproducible install
- dependency update automation
- secret scanning
- dependency vulnerability scanning
- container image scanning
- lint / typecheck / test CI

## Scope

보안/복구 계약은 [docs/SPEC.md](docs/SPEC.md)와 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)를 함께 따른다.
