# Security Policy

Docklane은 Docker Swarm과 운영 인프라를 변경할 수 있는 control plane을 목표로 합니다. 따라서 보안 문제는 일반적인 UI 결함보다 큰 영향을 줄 수 있습니다.

## Project Status

Docklane은 현재 **pre-alpha / specification 단계**입니다.

아직 안정화된 production release가 없으며, 현재 버전은 운영 환경 사용을 지원하지 않습니다.

| Version | Supported |
| --- | --- |
| main / pre-alpha | Security fixes on best-effort basis |
| Production release | Not available yet |

## Reporting a Vulnerability

민감한 보안 취약점은 공개 Issue에 상세 내용을 작성하지 마세요.

1. 저장소에서 GitHub의 **Report a vulnerability / Private vulnerability reporting** 기능을 사용할 수 있다면 해당 경로를 우선 사용합니다.
2. 해당 기능이 보이지 않는 경우, 저장소 maintainer의 GitHub 프로필을 통해 비공개 연락 경로를 요청하되 취약점 세부 정보나 exploit을 공개 Issue에 포함하지 마세요.

다음 정보를 포함하면 확인에 도움이 됩니다.

- 영향을 받는 component
- 재현 조건
- 예상 영향
- 가능한 최소 재현 방법
- 제안하는 완화 방법이 있다면 해당 내용

비밀키, 실제 운영 credential, 개인정보 또는 제3자의 민감 데이터를 재현 자료에 포함하지 마세요.

## Security Baseline

다음 항목은 **최초 infrastructure mutation을 제공하기 전** 구현되어야 합니다.

- 사용자 authentication
- 최소 VIEWER / OPERATOR / ADMIN RBAC
- cluster/service resource-scope authorization
- mutation audit
- Control Plane ↔ Agent mTLS
- Agent operation allow-list
- Agent field allow-list
- expected Docker resource version 확인
- Docker daemon의 unauthenticated TCP endpoint 노출 금지

추가 필수 원칙:

- Agent는 arbitrary shell execution API를 제공하지 않는다.
- caller가 전달한 raw Docker service spec을 무검증으로 적용하지 않는다.
- Secret value는 API response, log, audit event에 기록하지 않는다.
- Registry credential은 암호화하여 저장한다.
- Swarm 내부 통신 포트는 trusted/private network로 제한한다.
- Manager quorum을 잃은 cluster에는 mutation을 수행하지 않는다.
- 요청에는 expiry/replay 방지 수단을 둔다.

## Agent mTLS Lifecycle

mTLS는 단순히 인증서를 사용한다는 의미로 끝내지 않는다.

구현 전 다음 수명주기를 정의한다.

- certificate issuance
- agent identity와 cluster binding
- renewal
- expiration behavior
- revocation
- compromised credential replacement
- trust root rotation

만료/폐기된 Agent는 mutation 요청을 수행할 수 없어야 한다.

## Mutation Authorization

API authorization과 Agent authorization을 분리한다.

API:

- actor role
- target cluster
- target service/node
- requested operation

Agent:

- authenticated Control Plane identity
- target cluster
- target Docker resource
- allowed operation
- allowed mutable fields
- expected Docker Version.Index
- request expiry/generation

두 경계 중 하나라도 검증에 실패하면 mutation을 실행하지 않는다.

## Bootstrap Credentials

Node bootstrap 자동화는 초기 MVP 이후 범위다.

향후 구현 시 Docklane one-time bootstrap token과 Docker Swarm native join token을 별도 credential로 취급한다.

Docklane token의 만료가 native join token의 무효화를 의미하지 않는다.

Native token 노출 시에는 Docker의 token rotation 정책을 적용해야 한다.

## Recovery Security

Control Plane/API 재시작 후 non-terminal operation을 reconcile할 때 다음을 보장한다.

- 오래된 operation lease가 새 실행을 덮어쓰지 않음
- stale/late Agent response가 최신 generation을 변경하지 않음
- 재시도 전에 실제 Docker state를 확인
- 외부 CLI 변경을 conflict로 처리
- secret/credential을 operation intent나 audit snapshot에 포함하지 않음

## Dependency Security

구현 단계부터 다음 자동화를 추가할 예정이다.

- dependency update automation
- lockfile 기반 reproducible install
- secret scanning
- dependency vulnerability scanning
- container image scanning
- CI에서 lint, typecheck, test

## Production Readiness

운영 도입 전 최소한 다음을 실제로 검증한다.

- 3-manager quorum behavior
- leader loss / quorum loss
- Swarm backup and restore
- Docklane DB restore
- encryption key/trust restore
- unauthorized mutation rejection
- Agent certificate expiry/revocation
- rollback failure behavior

## Scope

보안 관련 설계 결정은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)와 [docs/SPEC.md](docs/SPEC.md)에서 관리합니다.
