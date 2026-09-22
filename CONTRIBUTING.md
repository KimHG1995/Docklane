# Contributing

Docklane은 현재 초기 설계 및 구현 단계입니다.

## Development Principles

변경 사항은 다음 원칙을 우선합니다.

1. Docker/Swarm이 이미 제공하는 기능을 재구현하지 않는다.
2. Provider-specific 기능은 core domain에서 분리한다.
3. 인프라 mutation은 명시적이고 감사 가능해야 한다.
4. Security boundary를 편의를 위해 우회하지 않는다.
5. 큰 기능보다 검증 가능한 작은 vertical slice를 우선한다.

## Branch

기능 변경은 별도 branch에서 작업합니다.

예:

```text
feat/swarm-read-model
feat/release-management
fix/deployment-lock
docs/architecture
```

## Commit

간결한 Conventional Commit 형식을 권장합니다.

```text
feat: add service scale operation
fix: block deploy without manager quorum
docs: clarify release model
chore: configure workspace
```

## Pull Request

PR에는 가능한 경우 다음 내용을 포함합니다.

- 변경 목적
- 주요 변경 사항
- 검증 방법
- 보안/운영 영향
- 남은 제약

인프라 mutation이 추가되면 반드시 다음을 확인합니다.

- authorization
- validation
- idempotency 또는 중복 실행 영향
- audit event
- failure/rollback behavior

## Validation

코드가 추가된 이후 기본 검증 명령은 repository scripts로 통일할 예정입니다.

목표:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

PR에서는 변경 범위에 맞는 검증을 수행합니다.

## Documentation

아키텍처 또는 domain boundary를 변경하는 PR은 관련 문서를 함께 수정합니다.

- `docs/SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`

중대한 기술 결정이 누적되면 `docs/decisions/` 아래 ADR을 추가합니다.

## Security

취약점은 공개 Issue가 아니라 [SECURITY.md](SECURITY.md)의 절차를 따릅니다.
