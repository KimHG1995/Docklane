# Maintenance 상태 전이 구현 단계

이 문서는 PR #135의 영속 조회 경계 이후 단계의 **DB primitive** 계약이다. 아직 HTTP 관리 API나 Docklane 서비스/노드 mutation 경로에 연결되지 않았다.

## 초기화
- 등록된 논리 cluster에만 operator가 명시적으로 OPEN row를 생성한다.
- row 부재는 OPEN이 아니며 읽기/시작/마이그레이션 중 자동 초기화하지 않는다.
- 중복 초기화는 기존 CLOSING/CLOSED/RECONCILING 상태를 절대 OPEN으로 돌리지 않는다.
- 현재 repository primitive에는 ADMIN authorization 경계가 없다. 향후 서비스/컨트롤러가 scoped ADMIN, 등록된 실제 Swarm identity 및 감사 기록을 강제하기 전 운영용 엔드포인트에 노출하지 않는다.

## 상태 전이
`OPEN → CLOSING → CLOSED → RECONCILING → OPEN`만 허용한다.
세대 번호를 비교하는 CAS로 오래된 실행자의 상태 변경을 거절한다. 이것만으로 Docker API 호출을 fence할 수 없으며, DB 체크 직후 외부 writer/다중 Agent 재가입 경쟁은 남는다.

- OPEN → CLOSING: 신규 mutation admission 및 대기 중 dispatch가 **모든 CP에서 차단됨을 증명**해야 한다.
- CLOSING → CLOSED: in-flight 전송 상태가 모두 확인되고 모든 manager Agent barrier를 확인해야 한다.
- CLOSED → RECONCILING: 유지보수 후 운영자 동의, 클러스터 identity 재등록과 소유권 검증이 필요하다.
- RECONCILING → OPEN: 미확정 작업 재조정, 전체 manager 확인, 관리자의 명시적 재개 승인 필요.

**현 PR은 위 선행조건을 검사하지 않는다.** 단순 CAS를 운영용으로 직접 사용하면 위험하다. 다음 PR에서 domain service, authorization, 감사 및 dispatch gate가 선행조건을 강제해야 한다.

## 인수 기준
- 기존 등록이 없는 cluster는 초기화 실패.
- 중복 초기화가 상태/세대/소유자를 바꾸지 않음.
- 잘못된 상태 전이, 0 generation, stale generation 거절.
- DB outage/missing row에서도 mutation 허용으로 fallback하지 않음.
- 다중 CP, Agent barrier, in-flight 확인은 별도 제품 구현과 real MySQL 통합 검증 필요.

참조: [Swarm 상호배제 정책](SWARM_MUTATION_EXCLUSION.md), [ROADMAP](ROADMAP.md).
