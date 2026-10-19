# Maintenance 상태 전이 — 구현과 인수 상태

> PR #137 / 최신 코드 기준. **제품 로직 및 MySQL 회귀 구현**, 실제 3-Manager Swarm·2 CP 인수 **미완료**. 운영 enforcement 활성화 및 병합 금지.

## 상태 전이

`OPEN → CLOSING → CLOSED → RECONCILING → OPEN`

- **초기화**: Scoped ADMIN `POST /v1/clusters/:clusterId/maintenance/initialize`; 등록 enforce, 실제 Swarm Identity 및 감사 INSERT를 검증. 재요청으로 기존 상태를 OPEN으로 변경하지 않음.
- **CLOSING**: Scoped ADMIN close-request. 새로운 admission과 최종 Agent dispatch를 차단하고 CP 재시작 후에도 복구 경로(관측만)를 유지.
- **CLOSED**: 모든 Manager의 generation 기반 BLOCKED ACK를 확보하고, 미해결 operation/dispatch/admission 0건 및 현재 CP Lease를 하나의 MySQL 트랜잭션에서 검사한 뒤 감사와 함께 확정.
- **RECONCILING**: 관리자가 명시적으로 진입. Manager 차단, 원본 증거 보존, UNCERTAIN·NEEDS_ATTENTION에 대한 수동 관측·감사 경로를 유지.
- **OPEN 재개**: 전체 Manager가 BLOCKED인 것을 다시 확인하고 미정리 작업이 없을 때 감사와 DB OPEN을 커밋. 그 이후에만 각 Agent OPEN으로 전환. 부분 ACK 유실 시 `resume-managers`로 동일 세대를 재확인.

## 복구 계약

- 서비스/노드/DEPLOY/ROLLBACK은 기존 operation과 배포의 연결 관계를 보존한다.
- 미관측 변경은 관리자와 Agent 실시간 관측이 확인된 범위에서만 수동 FAILED로 종료. 원본 UNCERTAIN dispatch와 rollback 이력은 수정·삭제하지 않음.
- 자원 Lock 경합 중 관리자 복구 관측을 시작하지 않는다. 관리자 처리 중 경합이 나면 409, Lock 해제 후 재시도.
- 이미 확정된 수동 종료 결과는 기존 비동기 상태 writer가 덮어쓰지 못한다.
- MySQL Lease token은 재획득할 때마다 증가하며 오래된 실행자의 DB 확정을 거절한다. Docker Engine의 원자적 cluster fencing과는 별개.

## 검증 경계

- CI: API/Go/MySQL PoC/mTLS/validation gate와 11개 상태 writer 보호가 통과한 범위만 인정한다.
- 추가 회귀: 서비스/노드 복구 Lock 경합, 복구 관측 순서, DEPLOY/ROLLBACK 해결 및 감사 rollback을 저장소 테스트로 유지.
- **미실행**: 실제 3 Manager/독립 Agent + 2 CP 동시 구동, Docker mutation 전송 유실, Manager 재시작, 실제 leave/rejoin, 외부 Docker 소켓 권한 통제.

[실제 인수 기준](MAINTENANCE_FEATURE_ACCEPTANCE.md) · [상호배제 위협 모델](SWARM_MUTATION_EXCLUSION.md) · [Roadmap](ROADMAP.md)
