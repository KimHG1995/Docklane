# Agent 거절과 불확실한 변경 결과

## 분류 기준

[Agent cluster guard](../agent/internal/httpserver/cluster_precondition.go)는 DockerReader 변경 함수를 호출하기 전에 아래 응답을 반환한다. Control Plane은 **변경 요청 자체에서 받은 AgentRequestError의 HTTP status와 JSON 최상위 code가 함께 일치할 때만** 변경 미실행의 확정 증거로 사용한다.

| HTTP status | JSON code | 변경 실행 여부 |
| --- | --- | --- |
| 412 | CLUSTER_PRECONDITION_FAILED | 실행하지 않음 |
| 428 | CLUSTER_PRECONDITION_REQUIRED | 실행하지 않음 |
| 503 | CLUSTER_IDENTITY_UNAVAILABLE | 실행하지 않음 |

기존 400/409 거절 계약은 유지한다. 일반 503, 다른 status/code 조합, code 누락/중첩/잘못된 타입, 깨진 JSON과 응답 유실은 새 확정 거절로 분류하지 않는다. 원래 HTTP status를 400이나 409로 바꾸지 않으며, 외부 Control Plane API의 오류 매핑도 그대로 둔다. 위 code는 사전 거절 전용이며 실행 후 오류에 재사용해서는 안 된다.

## 작업 상태와 재시도

서비스 scale/restart, 노드 drain/activate/labels, 배포와 과거 릴리스 재배포는 확정 거절 시 operation을 FAILED로 기록한다. 배포 record도 FAILED로 기록하며 기존 intent와 거절 audit은 보존한다. 실패 기록과 audit은 같은 트랜잭션에서 저장한다. 저장 실패 시 확정 실패로 간주하지 않고 기존 보호를 남긴다.

수동 롤백의 사전 거절은 실행 후 복구 실패와 다르다. 사전 거절은 rollback operation을 FAILED로 종료하고 deployment를 요청 전의 FAILED 상태로 돌린다. rollbackOperationId와 거절 audit은 남기며, 같은 ID의 재호출은 결과를 반환할 뿐 변경을 재전송하지 않는다. 이후 새 ID로 명시적인 작업을 요청하면 원래 계획/권한/소유권/version/spec 조건을 다시 검사한다. 반면 롤백 실행 후 수렴 또는 health 검증이 실패하면 기존 NEEDS_ATTENTION / ROLLBACK_FAILED 보호를 유지한다.

일반 503이나 응답 유실에서 target이 관찰되면 기존 convergence 검증으로 진행한다. 적용 여부가 확인되지 않으면 기존 미해결 상태와 충돌 보호를 유지한다. 자동 mutation 재전송, Agent failover 재전송이나 v1 downgrade를 추가하지 않는다.

## 이미 남아 있는 미해결 기록

이 변경은 새로 받은 확정 거절을 정확히 영속화한다. 이전 버전이 status만 남겼거나 원래 거절 응답을 보존하지 않은 NEEDS_ATTENTION 기록을 자동으로 FAILED로 변경하지 않는다. 변경되지 않은 현재 spec이나 후속 조회의 guard 오류만으로 과거 요청의 미실행을 추론할 수 없다. 기존 기록을 처리하려면 원래 응답과 요청 및 대상의 증거를 별도로 확인해야 한다.

## 검증 범위

회귀는 실제 MutationService, NodeMutationService, DeploymentService를 호출하고 Agent, 저장소/트랜잭션, lock, capacity와 health transport를 대역으로 둔다. 확정 거절, 같은 기록을 사용하는 새 coordinator의 bootstrap, 동일 ID 재전송 차단, 다음 작업의 계획 진입, 감사 저장 실패 rollback과 불확실한 응답 후 실제 target 관찰을 다룬다. 분류 단위 테스트는 정확한 status/code와 잘못된 envelope를 구분한다. 실제 MySQL 장애나 Docker cross-cluster 재가입을 주입한 acceptance와는 구분한다.

관련 계약: [Agent mutation 사전조건과 업그레이드](AGENT_MUTATION_PRECONDITION.md).
