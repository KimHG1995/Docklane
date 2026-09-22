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

Docklane 구현은 최소한 다음 원칙을 따라야 합니다.

- Docker daemon의 unauthenticated TCP endpoint를 노출하지 않는다.
- Control Plane과 Swarm Agent 사이에 상호 인증을 사용한다.
- Agent는 arbitrary shell execution API를 제공하지 않는다.
- Bootstrap token은 짧은 TTL과 one-time semantics를 가진다.
- Secret value는 API response, log, audit event에 기록하지 않는다.
- Registry credential은 암호화하여 저장한다.
- 모든 mutation endpoint는 RBAC 검증을 수행한다.
- Deploy, rollback, scale, drain 등 인프라 변경 작업은 audit event를 남긴다.
- Swarm 내부 통신 포트는 trusted/private network로 제한한다.
- Manager quorum을 잃은 cluster에는 mutation을 수행하지 않는다.

## Dependency Security

구현 단계부터 다음 자동화를 추가할 예정이다.

- dependency update automation
- lockfile 기반 reproducible install
- secret scanning
- dependency vulnerability scanning
- container image scanning
- CI에서 lint, typecheck, test

## Scope

보안 관련 설계 결정은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)와 [docs/SPEC.md](docs/SPEC.md)에서 관리합니다.
