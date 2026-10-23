# Swarm 재가입과 Docker mutation 상호배제 정책 (설계)

상태: **PR #137에서 admission/dispatch/Manager barrier/관리자 recovery 구현됨, 실제 3-Manager + 2 CP 인수 미완료**. 과거 설계 시점의 baseline은 기록 목적으로만 남긴다.

## 목적과 현재 증거

Agent는 v1/v2 mutation 입장 시 manager cluster identity를 검사하고, 실제 7종 `ServiceUpdate`/`NodeUpdate` 직전 같은 Docker client로 `SwarmInspect`를 다시 검사한다. 변경 전 cluster 불일치는 `412/CLUSTER_PRECONDITION_FAILED`, identity 확인 불능은 `503/CLUSTER_IDENTITY_UNAVAILABLE`로 거절한다. Docker mutation은 전송 이후 재시도하지 않는다.

PR #129 이후 disposable single-node Functional PoC #38345202621은 **서비스 inspect 응답 보류 → 실제 Swarm A leave/init으로 B 생성 → 응답 해제 → 최종 검사 412 / ServiceUpdate 0건** 및 cleanup을 확인했다. **마지막 SwarmInspect와 Docker update 사이의 재가입은 실험하거나 해결하지 않았다.**

## 위협 모델과 보장 수준

- **내부 경합**: 정상 Docklane Control Plane 인스턴스, Agent 및 Docklane이 운영하는 lifecycle 작업. DB lock/lease와 admission gate로 조정 가능하나, `check lease`와 Docker API 호출 사이에도 경쟁이 있다.
- **외부 경합**: root/daemon socket 권한을 가진 운영자 CLI, 타 자동화, 직접 Docker Engine API 호출. Docklane DB lock, Agent mutex, 임의 fencing token은 Docker daemon에 의해 검증되지 않는다. **외부 writer를 무제한 허용하면 원자적 안전성을 보장할 수 없다.**
- **신뢰 경계**: Docker daemon/socket 통제와 Swarm lifecycle 재구성 권한은 Docklane 밖이다. 지원 운영 모드는 socket/CLI 직접 쓰기 주체를 관리하고, 재가입을 별도 유지보수 절차로 제한하는 **운영상 상호배제**를 요구한다.
- **금지 표현**: 마지막 SwarmInspect 추가, 락 또는 `Version.Index` CAS만으로 cross-cluster 원자적 fencing 완료라고 주장하지 않는다. 같은 service ID/version의 교차 클러스터 재사용 가능성도 안전성 가정으로 두지 않는다.

## 운영 정책: maintenance admission

1. 대상 **실제 Swarm ID**와 논리 cluster 등록, 등록 enforce 모드 및 모든 대상 manager Agent identity 일치를 확인한다. DB/identity unavailable 또는 일부 관리자와 불일치하면 fail closed.
2. 관리자가 재구성을 승인하면 해당 논리 cluster에 대해 **신규 mutation 접수를 닫고** 감사 가능한 maintenance intent를 영속화한다. 신규 API 요청뿐 아니라 이미 접수되어 대기 중인 작업의 dispatch도 중단한다.
3. 기존 in-flight 작업의 전송 여부를 확인한다. **전송 여부가 불명확하거나 Docker 수렴 검증이 끝나지 않은 작업이 하나라도 있으면 자동 재가입을 시작하지 않는다**. 억지로 lease를 만료시키거나 서비스 업데이트를 재전송하지 않는다.
4. 모든 manager에서 Agent mutation dispatch를 차단한 상태를 확인한 뒤, 통제된 관리자 절차에서만 Swarm leave/init/join을 수행한다. Docker daemon/socket 직접 접근 권한을 가진 외부 자동화 및 운영자도 동기간 쓰기를 중지해야 한다.
5. 재가입 후 실제 Swarm ID, manager quorum, Agent identities, 등록된 대상의 소유권을 재검증한다. **새 Swarm ID는 기존 등록의 자동 변경이 아니다.** 등록/바인딩 이전, 재승인, 감사가 필요하고 기존 service ID는 묵시적으로 재사용하지 않는다.
6. 불확실한 operation은 inspect/reconciliation과 관리자 결정을 거쳐 닫는다. 모든 조건이 통과한 뒤 maintenance를 해제하고 신규 mutation을 재개한다. 해제 실패 시 차단 상태를 유지한다.

이 정책은 외부 socket writer 권한을 기술적으로 제거하거나 운영 절차를 강제하지 않는 한 **운영 계약**이지 Docker API 수준 원자적 보장이 아니다. Agent 자체가 Docker Engine에 원자적 cluster compare-and-update를 요구하는 API는 현재 사용하지 않는다.

## 구현된 제품 경계와 미완료 운영 인수

| 구성 | 기대 불변식 |
| --- | --- |
| 영속 maintenance state + audit | cluster 별 OPEN/CLOSING/CLOSED/RECONCILING; 재시작 후 기본 OPEN으로 복원 금지 |
| 전체 mutation admission/dispatch gate | service/rollback/node 7종의 신규/대기 요청과 재시작 복구 경로 모두 gate 적용 |
| in-flight 추적 | 잠금 및 durable intent를 기준으로 전송 전/후/불확실 상태 분리, 소유권 상실 시 후속 dispatch 금지 |
| multi-CP coordination | 동일 DB에 공유된 상태, 원자적 소유권 획득, lease 세대/heartbeat; stale actor 차단. 단, Docker native fencing 아님 |
| manager Agent barrier | 다중 manager가 mutation을 전달하지 않음을 확인; 응답 유실 시 안전하게 fail closed |
| 재가입 후 확인 | 새 ID 암묵적 수용/등록 재작성 금지, binding과 기존 operation 자동 사용 금지 |
| operator recovery | 수동 재조정, 사유 기록, maintenance 해제 전 감사 및 명시적 승인 |

구현 방향은 기존 `registered-operation-lock.ts`, `operation-lock.ts`, 등록 enforce 정책 및 operation state machine과 호환해야 한다. 새 구조가 기존 락을 우회하거나 재전송 정책을 바꾸면 안 된다. DB 트랜잭션/락을 Docker 요청 중 무기한 붙잡는 설계는 연결 고갈과 교착 가능성 때문에 피하고, dispatch fencing 및 실행자 소유권 검증을 별도로 정의한다.

## 실패 처리 계약

| 사건 | 동작 |
| --- | --- |
| admission / 최종 cluster precondition 412 | 전송 전 확정 거절, 기존 FAILED/audit 계약 유지 |
| cluster identity 확인 불가 503 | 전송 전 확정 거절일 때만 해당 코드로 처리 |
| Docker update 전송 여부 불명/timeout/connection loss | mutation 재전송 금지; NEEDS_ATTENTION 및 독립적인 현재 클러스터 확인 후 reconciliation |
| mutation 진행 중 maintenance 요청 | admission 중단 후 in-flight 종료/불확실성 해결까지 재가입 보류 |
| maintenance 도중 CP 또는 Agent 재시작 | 영속 차단 유지, 자동 OPEN 금지 |
| CP 간 설정/등록 실제 Swarm ID 불일치 | 해당 대상의 dispatch 거절 및 감사 |
| 외부에서 허가 없이 leave/join | 발견한 시점부터 fail closed; 이미 전송된 Docker 요청의 무효화는 주장하지 않음 |
| 재가입 후 과거 service ID 조회 404 | 새 Swarm에서 서비스 재생성이나 cleanup 삭제를 자동 실행하지 않음 |

## 검증/인수 기준

1. **기존 증거 유지**: #38345202621의 검사 *이전* rejoin 412, Docker update 0회, cleanup PASS.
2. **정확한 잔여 창 실험**: disposable 소유 Swarm A의 **마지막 `SwarmInspect` 응답 자체를 보류**, 응답을 풀어 검사 성공 처리한 *직후* 외부 실제 leave/init을 동기화하여 ServiceUpdate/NodeUpdate가 요청된 대상과 결과를 trace. 서비스/노드 ID, 원본/신규 Swarm ID, Docker update attempt, 응답/상태/cleanup 증거를 수집. 이 실험은 **현재 코드 취약 구간 재현**이며 결과가 안전하지 않더라도 PASS로 둔갑시키지 않는다.
3. **제품 정책 테스트**: maintenance CLOSING 이후 신규 및 이미 대기 중인 service/rollback/node mutation 모두 Docker update 0회; in-flight 불확실성에선 CLOSED 진입/재가입 금지; 프로세스 재시작과 DB 장애에서 차단 유지.
4. **다중 CP/Agent**: 서로 다른 설정 pin, stale lease 소유자, CP crash 및 Agent failover 시 mutation 재전송 없음; 실제 manager 전체가 barrier를 준수.
5. **운영 인수**: 직접 Docker writer 접근 통제가 강제되거나 명시적으로 운영 정책으로 관리되는지 확인. 그렇지 않으면 cross-cluster 원자적 차단은 **미보장**으로 표시.

### 비범위

- Docker Engine의 compare-cluster-and-service-update 원자 트랜잭션 구현
- 통제 불가능한 외부 Docker socket writer의 안전한 자동 차단
- Stack/multi-cluster 확장, UI 및 metrics
- 외부 Docker 소켓 직접 쓰기 및 Engine compare-cluster-and-update 원자화

## 초기 계획 이력 (현재는 PR #137에서 통합 구현)

1. **실험 PR**: 마지막 `SwarmInspect` 이후의 실제 Docker update 경쟁 구간을 소유권이 확인된 disposable 환경에서 재현하고 관찰한다. 제품 정책과 구분한다.
2. **maintenance admission PR**: DB 영속 state 및 service/node/rollback 공통 admission과 CP 재시작 fail closed, 테스트.
3. **multi-manager barrier PR**: Agent dispatch 차단 및 manager별 ack/미확인 처리, 운영 절차.
4. **통합 acceptance PR**: multi-CP/Agent, restart, in-flight 불확실성, 실제 rejoin과 cleanup. 결과와 위협 모델을 ROADMAP에 동기화.

참조: [Agent mutation 사전조건](AGENT_MUTATION_PRECONDITION.md), [등록 정책](CLUSTER_REGISTRATION.md), [아키텍처](ARCHITECTURE.md), [ROADMAP](ROADMAP.md), [Docker Swarm 관리자 가이드](https://docs.docker.com/engine/swarm/admin_guide/).
