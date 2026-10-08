# Roadmap

Docklane은 기능 수보다 **안전하게 복구 가능한 하나의 deployment vertical slice**를 먼저 완성한다.

버전 번호는 구현 단계이며, production readiness를 의미하지 않는다.

## v0.0 — Foundation & Security Boundary

- [x] pnpm monorepo
- [x] Next.js web
- [x] NestJS API
- [x] shared contracts
- [x] database/migration — ordered schema_migrations + MySQL migration PoC
- [x] authentication
- [x] VIEWER / OPERATOR / ADMIN 기본 RBAC
- [x] resource scope validation
- [x] mutation audit foundation
- [x] Docker Engine API read-only spike
- [x] Go agent module
- [x] OpenAPI agent contract
- [x] Docker Engine Go client read-only spike
- [x] Agent protocol skeleton (HTTPS + JSON)
- [x] systemd service definition
- [x] Control Plane ↔ Go Agent mTLS PoC
- [x] lint / typecheck / test CI
- [x] supported Docker Engine/API version 명시 — Docker Engine 27.5 / API 1.47 이상

Exit criteria:

- Web → API → DB 기본 연결
- 인증되지 않은 사용자와 권한 없는 mutation 거절
- Go Agent 단일 바이너리 빌드/실행
- Agent arbitrary command 실행 불가
- OpenAPI 기반 Control Plane ↔ Agent 요청 검증
- read-only Docker inspect 동작

## v0.1 — Swarm Read Model

- [ ] cluster registration
  - [x] immutable ADMIN registration/read API, configured/live identity check, DB mapping and atomic audit — [1단계 범위](CLUSTER_REGISTRATION.md)
  - [x] opt-in registered binding enforcement at HTTP, Agent, operation-lock and bootstrap boundaries (PR #116)
  - [ ] operator activation, legacy-data scope review and new end-to-end acceptance
- [x] manager quorum
- [x] node list/detail
- [x] service list/detail
- [x] task status
- [x] desired/running replicas
- [x] service digest/spec 표시
- [ ] dashboard

Exit criteria:

- 실제 Swarm 상태와 UI 일치
- manager/worker 장애 구분
- Docker service version/spec 확인 가능

## v0.2 — Release & Deployment Target

MVP application 모델을 고정한다.

- [x] logical Application
- [x] DeploymentTarget
- [x] single stateless replicated service binding
- [x] registry adapter
- [x] digest resolution
- [x] digest-required Release
- [x] git commit/build metadata
- [x] release history

Exit criteria:

- Release가 cluster/service에 직접 종속되지 않음
- 운영 Release는 digest 없이는 생성 불가
- 동일 Release를 target과 분리하여 표현 가능

## v0.3 — Safe Deployment Vertical Slice

Docklane의 핵심 단계다.

- [x] operation intent persistence
- [x] service-level mutation lock
- [x] beforeSpec / targetSpec / expected version 저장
- [x] rolling service update
- [x] target digest/spec convergence
- [x] task convergence verification
- [x] application health stability window
- [ ] SSE progress
- [x] deployment timeout
- [x] no-op deployment detection / verification
- [x] deployment history

Exit criteria:

```text
Release
 -> Deploy
 -> Target convergence
 -> Health stability
 -> SUCCESS
```

단순 replica count/health 200만으로 성공하지 않는다.

## v0.4 — Rollback & Reconciliation

- [x] Swarm rollback ownership detection
- [x] automatic rollback observation
- [x] Docklane-triggered rollback
- [x] ROLLBACK_VERIFYING
- [x] ROLLBACK_FAILED / NEEDS_ATTENTION
- [x] API restart reconciliation
- [x] Agent response-loss reconciliation
- [x] idempotent operationId
- [x] external CLI conflict detection
- [x] historical image redeploy

Exit criteria:

- broken release가 성공으로 오판되지 않음
- rollback 이전 spec/task/health 실제 복구 확인
- Docker update 수락 직후 API 종료 후 정상 재조정
- blind mutation retry 없음

## v0.5 — Coordinated Operations

Deployment와 같은 mutation coordinator에 운영 작업을 연결한다.

- [x] replica scale
- [x] service restart
- [x] node labels
- [x] node drain/activate
- [ ] mutation conflict UX
- [x] capacity pre-check
- [x] ingress routing mesh validation

Exit criteria:

- VERIFYING/rollback 중 scale/restart 충돌 방지
- scale 4 → 8 → 3
- drain 후 Swarm task 이동
- standalone Compose workload는 drain 대상이 아님을 UI/문서에서 구분

## v0.6 — Functional PoC Acceptance

체크박스는 실제 Functional PoC run에서 해당 시나리오가 끝까지 통과한 경우에만 완료 처리한다.
Harness 구현 여부와 acceptance 통과 여부를 구분한다.

2026-09-30 acceptance 완료:

- single-node run #36671264551: **SUCCESS**
  - normal digest deploy
  - same digest/spec no-op redeploy
  - broken release + manual rollback
  - API restart during update
  - Agent response loss
  - Swarm automatic rollback
  - capacity shortage pre-check
  - external CLI conflict
  - authorization rejection
  - audit completeness
- 3-node run #36662265999: **SUCCESS**
  - manager-01 / worker-01 / worker-02 Ready/Active topology
  - node drain/activate task relocation
  - worker failure reschedule 및 Docklane read-model 수렴
  - external HAProxy traffic during rollout
  - Swarm internal ports outer-host 차단

v0.6 Functional PoC acceptance를 완료했다.

Topology:

```text
manager-01
worker-01
worker-02
```

필수 acceptance는 시나리오 특성에 따라 single-node와 3-node 실제 Functional PoC 실행 결과로 체크한다. topology, worker failure, node drain, external LB, network exposure는 3-node run을 근거로 하고 나머지 deployment/reconciliation 시나리오는 single-node run을 근거로 한다.

현재 3-node topology harness:

- [x] manager-01 / worker-01 / worker-02 DinD Swarm bootstrap
- [x] 3-node Ready/Active topology 검증
- [x] manager Docker API host-loopback 접근 검증
- [x] node drain scenario
- [x] worker failure scenario
- [x] actual external LB traffic scenario
- [x] Swarm internal ports network exposure scenario

현재 single-node harness 구현:

- [x] normal digest deploy
- [x] broken release + manual rollback
- [x] external CLI conflict
- [x] API restart during update
- [x] Agent response loss
- [x] authorization rejection
- [x] audit completeness
- [x] same digest/spec no-op redeploy
- [x] broken release + automatic rollback
- [x] capacity shortage

필수:

- [x] normal digest deploy
- [x] broken release rollback
- [x] external conflict
- [x] API restart during update
- [x] Agent response loss
- [x] capacity shortage
- [x] actual external LB traffic during rollout
- [x] worker failure
- [x] node drain
- [x] authorization rejection
- [x] audit completeness
- [x] same digest/spec no-op redeploy
- [x] Swarm internal ports blocked from untrusted/public networks

이 단계까지가 **기능 MVP**다.

## v0.7 — Bootstrap

핵심 deployment path가 검증된 후 자동화한다.

- [x] Docklane one-time bootstrap token
- [x] TTL / scope
- [x] Docker install/validate
- [x] native Swarm join token handling
- [x] retry/partial failure protocol
- [x] post-join node/role verification
- [x] label application
- [x] bootstrap audit

Docklane token과 native Swarm join token의 lifetime을 구분한다.

## v0.8 — Operational Readiness

최소 3 managers에서 별도 검증한다.

- [x] leader loss — run #36680739108
- [x] manager loss — run #36681425236
- [x] quorum loss — run #36682067172
- [x] network partition — run #36682848436
- [x] manager별 Go Agent 배포 — run #37716190531 (PR #114 이후 재검증)
- [x] Agent reconnect/failover — run #36941789676
- [x] manager resource contention — run #37560542015 (PR #112 이후 재검증)
- [x] Swarm backup/restore drill — run #37414123569 (PR #102 이후 재검증)
- [x] Docklane DB restore — run #37414123562 (PR #102 이후 재검증)
- [x] encryption/trust key restore — run #37542402155 SUCCESS, Engine 28.5.2 / disposable Linux-DinD 단일 암호화 cold-backup 신뢰 복구 ([성공 근거](https://github.com/KimHG1995/Docklane/pull/109#issuecomment-6026899132))
- [x] recovery runbook — [버전 한정 복구 절차](COLD_BACKUP_RECOVERY.md), run #37542402155에서 신뢰 복구 검증. 범용 운영/애플리케이션 볼륨 복구는 범위 밖

2026-10-06 Agent identity 보완: 무기한 endpoint 검증 캐시를 제거하고 모든 보호된 조회와 mutation 대상 선택에서 현재 identity를 확인한다. `/v1/cluster` 응답도 기준 cluster와 대조한다. 최초 정상 identity로 정한 기준 cluster와 전송 후 mutation 재시도 금지를 유지한다. HTTP 회귀 6개를 포함한 API 테스트 130개, 타입 검사, 빌드와 mTLS는 PR #101 validate run #37412630341에서 통과했다. Identity 확인과 후속 요청은 원자적이지 않으므로 요청 도중의 재가입까지 차단하려면 별도 Agent 측 사전조건이 필요하다.

2026-10-06 recovery cleanup 보완: DB/Swarm/trust-key 정리는 inspect 통신 오류, 권한 오류, ID 불일치와 삭제 실패에서 ownership을 보존하고 실패를 반환한다. 기록된 리소스의 명시적인 부재만 idempotent 성공으로 처리한다. 실제 세 cleanup 스크립트를 사용하는 회귀 8개와 legacy workflow 회귀 1개를 추가했다. PR #102 validate run #37413669601과 main validate run #37414123474가 통과했고 DB/Swarm 복구는 위 main 실행에서 재검증했다. Cleanup 변경이 오래된 v1 복구를 자동 재실행하지 않도록 v1은 수동 실행만 유지하며 현재 recovery-v2 및 PR validation은 유지한다. 이는 암호화 복구 성공을 뜻하지 않는다.

2026-10-06 resource contention 준비 대기 보완: 초기/복구 준비 대기는 반환값 기반 확인 함수를 사용하고 부하 샘플의 엄격한 assertion은 유지한다. 실패한 topology 조회는 정상처럼 보이는 출력이 있어도 준비 완료로 인정하지 않는다. 실제 Bash 함수와 Docker/sleep 대역으로 실행하는 회귀 8개를 추가했다. 원본에서는 12개 세부 검증 실패가 재현되고 수정 후 8개가 통과했다. 기존 120회 관찰 한도와 부하 조건은 변경하지 않으며, 이는 Docker 명령 실행시간까지 포함한 120초 제한이라는 뜻은 아니다. PR #103 이후 main validate #37414696776과 실제 부하 시험 #37414696823이 성공했고 evidence 업로드와 cleanup까지 완료했다.

2026-10-06 unlock/quorum 원인 분리: Engine 28.5.2의 UnlockSwarm과 Init이 공유하는 제어 잠금 및 노드 준비 대기를 실제 진단과 대조했다. 백업 복사 없이 동일 follower의 quorum 유무를 비교하는 [대조 실험](UNLOCK_QUORUM_PROBE.md)을 추가했다. 살아 있는 30초 제한 unlock 한 건에서만 기존 peer를 재개하며, timeout 이후 재전송이나 force-new-cluster는 없다. 이 실험의 성공은 기존 peer 복귀 조건에만 해당하며 단일 암호화 백업 재해 복구 및 recovery runbook 완료 근거로 사용하지 않는다. 새 실환경 결과는 병합 후 PR 체크포인트에 기록하고 다음 작업에서 동기화한다.

2026-10-06 대조 실험 workflow 보완: PR #104의 첫 main 실행 #37418741530은 job이 생성되기 전에 실패해 실제 Swarm 실험을 수행하지 못했다. job 수준 env에서 허용되지 않는 runner.temp 참조를 probe/cleanup step 수준 env로 이동하고 표현식 범위 및 artifact 경로 일치 회귀 2개를 추가했다. 원래 암호화 복구의 실패와 구분하며 후속 대조 실험 결과도 확인 전 성공으로 처리하지 않는다.

2026-10-06 대조 실험 진단 분리: [PR #105 체크포인트](https://github.com/KimHG1995/Docklane/pull/105#issuecomment-6010113874)의 실제 run #37419223384는 quorum이 있는 unlock에 성공했지만, 격리 조건의 진단용 info가 3초 제한에서 exit 137로 실패해 스택 수집에 도달하지 못했다. Cleanup과 artifact 업로드는 성공했다. 이 실패는 원래 recovery-v2의 30초 restore-unlock 실패와 별개다. 이번 수정은 상태 조회 실패/잘못된 응답에서도 독립적인 스택을 수집하고, 엄격한 재개 판정 전에 정규화한 partial 증거를 저장한다. 진단 명령은 ownership 확인부터 공유 10초 예산을 사용한다. 상태가 unknown이면 스택이 있어도 peer를 재개하지 않으며 기존 30초 unlock, 재전송 금지와 단일 백업 acceptance는 유지한다. 새 회귀 10개와 기존 probe 회귀 21개가 Docker 대역 로컬 검증에서 통과했다. 전체 실환경 대조 실험 및 암호화 복구 완료를 뜻하지 않는다. 병합 후 결과는 해당 PR 체크포인트에 기록한다.

2026-10-06 PR #106 이후 결과 동기화: main validate #37422751838과 운영 회귀 80개가 통과했다. 실제 대조 실험 #37422751815는 state=unknown으로 실패했지만 정규화한 스택 요약 62개와 별도 UnlockSwarm/WaitForLeader/Manager.Run 대기를 보존했고 cleanup과 artifact 업로드도 성공했다. 따라서 진단 유실은 해결됐지만 info에 의존하는 준비 판정은 여전히 실험을 막았다. 새 snapshot은 info의 정확한 종료 코드를 저장하지 않았으므로 이전 run의 137을 새 실행의 확정값으로 인용하지 않는다. [PR #106 체크포인트](https://github.com/KimHG1995/Docklane/pull/106#issuecomment-6010604667)를 근거로 한다.

2026-10-06 로컬 Swarm 상태 조회 보완: quorum 조회를 수행하는 info 대신 owned DinD의 Unix socket에 HEAD /_ping을 한 번 보내 Swarm 헤더를 읽는 정적 Go helper를 사용한다. 헤더 누락/중복/비정상 응답은 unknown으로 거절하며 info로 fallback하지 않는다. 로컬 pending과 분리된 chan receive UnlockSwarm, select WaitForLeader + Manager.Run 스택, 동일 live unlock과 남은 시간을 모두 요구한다. ControlAvailable은 조회하지 않았으므로 null로 보존한다. Unix HTTP 회귀 13개와 probe/snapshot 회귀 38개가 로컬에서 통과했다. 기존 30초 unlock과 10초 진단 예산, 재전송 금지 및 단일 백업 acceptance는 유지한다. 새 실환경 결과는 병합 후 체크포인트와 다음 작업에서 동기화한다.

2026-10-06 PR #107 이후 결과 동기화: main validate #37428339641과 운영 회귀 100개가 통과했다. 실제 quorum 대조 실험 #37428339620도 성공했다. 실제 로컬 pending과 별도 대기 스택을 확인하고, 원래 peer 복귀 후 동일 unlock 한 건이 완료됐으며 cluster ID와 unlock key를 보존했다. 3.148초는 사전 대기 3초를 포함한 해당 요청의 전체 시간이다. 이 결과는 단일 cold backup 복구가 아니며 single_backup_acceptance=false다. [PR #107 체크포인트](https://github.com/KimHG1995/Docklane/pull/107#issuecomment-6011371612)를 근거로 한다.

2026-10-06 대조 실험 소유권 보완: 생성 전에 실행별 nonce와 리소스 intent를 영속화하고 같은 식별 label을 Docker 리소스에 부여한다. 생성 응답을 잃으면 label 조회 후 전체 ID, 이름과 label을 inspect로 검증해 정리한다. 아직 관찰되지 않은 생성은 완료/부재로 단정하지 않고 intent를 유지한다. 삭제 응답 유실 후 정확한 ID의 명시적인 not-found는 정리 완료로 인정하며 연결/권한/timeout/불일치는 기록을 보존한다. 신규 subprocess 회귀 17개와 기존 probe 회귀 23개를 로컬에서 통과했다. [소유권 및 재시도 계약](QUORUM_PROBE_CLEANUP.md)을 참조한다. 복구 경로, unlock 재전송 금지와 단일 백업 acceptance는 변경하지 않는다.

2026-10-06 PR #108 이후 결과 동기화: PR validation #37436106395(운영 회귀117개), main validation #37436689720과 실제 quorum 대조 실험 #37436689688이 성공했다. 생성/삭제 응답 유실은 실제 subprocess 대역 회귀로 검증했고 실제 Docker 실행은 기존 실험과 정상 cleanup의 호환성 검증이다. [PR #108 체크포인트](https://github.com/KimHG1995/Docklane/pull/108#issuecomment-6013016457)를 근거로 하며 단일 백업 완료로 해석하지 않는다.

2026-10-06 단일 cold backup 경로 구현: 원래 manager 세 ID의 명시적 부재와 복원 Docker 정지를 확인한 뒤 격리된 helper가 동일 Moby vendor의 UnlockKey+ForceNewCluster를 함께 적용한다. 실패한 사본의 자동 재시도는 금지하고, 정상 Docker 재시작 후 기존 키/CA/cluster ID/leader 및 키 회전/재시작/worker 가입을 검증한다. Go 정책8개와 Python 격리/호출10개, Bash/workflow4개, 기존 trust-key8개가 로컬에서 통과했다. 고정 vendor 어댑터는 별도 PR build gate로 검증하고 실제 acceptance는 main recovery-v2 결과 확인 전 미완료로 유지한다. [실행 절차와 제한](COLD_BACKUP_RECOVERY.md)에 기록했다.

2026-10-07 PR #109 이후 결과 동기화: main validation #37542401009와 실제 recovery-v2 #37542402155가 성공했다. 원래 manager 세 ID의 부재, 단일 cold backup의 offline quorum 재구성, 정상 Docker에서 원래 키 unlock, cluster ID/root CA/leader, 키 회전과 재시작 후 이전 키 거절/새 키 승인, fresh worker Ready/동일 CA 및 cleanup을 확인했다. Artifact 11449092312의 최종 summary와 [PR #109 체크포인트](https://github.com/KimHG1995/Docklane/pull/109#issuecomment-6026899132)가 완료 근거다. 이전 실패/대기 문단은 당시 이력이며 최신 판정은 위 성공이다. Helper 단독 single_backup_acceptance=false는 전체 drill의 성공과 별개다. 다른 Engine, 실제 workload/volume 일관성과 운영 환경 안전성은 검증하지 않았다.

2026-10-07 자동 cleanup 실행 범위 보완: 사전 검사 거부 시 이전 실행의 소유권 기록을 정리하지 않는다. 이번 실행의 durable intent 이후 실제 생성 호출을 시작한 경우에만 host 조건을 다시 확인하고 동일 run ID의 기록만 정리한다. 이전 기록은 명시적인 --cleanup-only로 처리하며, 다른 run journal 또는 혼합된 legacy 기록은 자동 정리를 거절한다. 실제 main/생성/정리 경로를 사용하는 Docker 대역 회귀 11개를 추가했다. 기존 snapshot의 진단 보존 테스트는 새로운 자동 정리 경계만 대역으로 처리한다. 복구/진단/키 처리의 성공 조건과 제한 시간은 변경하지 않는다.

2026-10-07 PR #110 이후 결과 동기화: PR validation #37548732617의 운영 회귀142개, main validation #37549139813과 실제 quorum probe #37549137498이 성공했다. 자동 cleanup의 사전 검사 거부/현재 실행 구분은 회귀로 확인했고 정상 Docker 대조 실험과 정리의 호환성도 유지했다. 동일 SHA에 별도의 push 실행이 추가 관찰됐으며 여기서는 완료된 실행을 근거로 한다. 수동 dispatch/재실행은 추가하지 않았다.

2026-10-07 cold-recovery 결과 전달 보완: 같은 사본의 rebuild는 결과 출력 성공 여부와 무관하게 한 번만 허용한다. Exclusive intent를 완료 뒤에도 유지하고 CA 확인 후 비밀정보 없는 완료 JSON을 같은 파일에 Sync/Close한 다음 stdout에 출력한다. 결과 Writer의 오류/부분 출력/재진입과 정상 출력 후 재호출에도 재실행을 거절한다. 새 회귀5개를 포함한 Go 정책13개가 실제 파일/Writer를 이용한 로컬 race test와 vet에서 통과했다. 복구 순서, 고정 Engine/vendor, 키 취급, 30초 unlock과 helper 출력 계약은 유지하며 변경 후 실제 복구 결과는 이 PR의 main 실행 체크포인트에 남긴다.

2026-10-07 PR #111 이후 결과 동기화: main validation #37549974143과 단일 암호화 복구 #37549974144가 성공했다. 운영 Python 회귀142개, Go 정책13개와 고정 vendor build를 확인했고, 결과 intent 유지 후에도 원래 manager 부재/CA/cluster ID/키 회전/신규 worker/cleanup까지 통과했다. [PR #111 체크포인트](https://github.com/KimHG1995/Docklane/pull/111#issuecomment-6027880611)가 근거이며 Engine 28.5.2/disposable Linux-DinD 신뢰 복구라는 범위는 유지한다.

2026-10-07 Agent mutation admission 보완: Control Plane은 검증한 cluster ID를 필수 헤더로 전달하고 실제 변경 7종에만 v2 경로를 사용한다. Agent는 본문 검증 후 현재 manager identity를 재조회하여 불일치/누락/확인 불가에서 DockerReader 변경 호출을 거절한다. 기존 v1 변경 경로에도 같은 guard를 적용하며, v1 downgrade와 전송 후 mutation 재시도는 없다. 조회와 계획 API 및 version/spec 조건은 유지한다. [프로토콜과 업그레이드 절차](AGENT_MUTATION_PRECONDITION.md)에 동기화했다. HTTP 경계까지의 cluster 전환 방어이며, 이 identity 조회와 실제 Docker 갱신 사이의 외부 CLI 재가입을 원자적으로 직렬화한 것은 아니다. 해당 최종 경쟁 조건과 cluster registration은 별도 미완료 범위다. 로컬 HTTP/파일 대역 회귀와 실제 의존성 CI, 실환경 acceptance를 구분하고 병합 후 결과는 이 PR 체크포인트에 기록한다.

2026-10-07 PR #112 이후 결과 동기화: PR validate #37560329658와 main validate #37560541980에서 실제 API 145개 테스트/타입 검사/빌드, Go Agent 전체 검증, mTLS와 Functional harness 회귀가 통과했다. 실제 resource contention #37560542015와 manager-agents #37560542111도 cleanup까지 성공했다. [PR #112 체크포인트](https://github.com/KimHG1995/Docklane/pull/112#issuecomment-6029436836)가 근거다. 두 운영 실행은 기존 조회/failover 호환성 증거이며, cross-cluster mutation 또는 전체 Functional acceptance를 새로 수행했다는 뜻은 아니다.

2026-10-07 Control Plane 시작 기준 보완: secure 모드는 운영자가 고정한 실제 Swarm ID인 DOCKLANE_EXPECTED_CLUSTER_ID를 필수로 요구하며 논리적 DOCKLANE_CLUSTER_ID와 구분한다. 환경 설정과 직접 주입 registry 모두 검증하고, 첫 응답이나 프로세스 재시작으로 기준을 다시 선택하지 않는다. 누락은 명시적 insecure 개발 모드에서만 기존 자동 인식을 허용하고, 명시적인 빈 값/개행/잘못된 값은 모든 모드에서 거절한다. 신규 회귀14개는 첫 접속, 별도 Node 프로세스 재시작, failover, 혼합 registry, 설정 경계와 mutation 재전송 금지를 다룬다. [설정 및 업그레이드 절차](AGENT_MUTATION_PRECONDITION.md)에 반영했다. DB 기반 cluster registration과 최종 Docker 갱신 시점의 외부 rejoin 경쟁 조건은 여전히 별도 미완료 범위이며, 실제 의존성 CI 결과와 선택된 운영 검증은 이 작업의 PR 체크포인트에 기록한다.

2026-10-08 PR #113 이후 결과 동기화: main validate #37574849436에서 API 159개 테스트/타입 검사/빌드, Go Agent와 mTLS, 운영 Python 회귀144개가 통과했고 실제 manager-agents #37574849359도 cleanup까지 성공했다. [PR #113 체크포인트](https://github.com/KimHG1995/Docklane/pull/113#issuecomment-6031401217)를 근거로 한다. 실제 매니저 검증은 기존 identity/failover 호환성이며 전체 배포/롤백이나 cross-cluster 재가입 acceptance를 새로 수행한 결과는 아니다.

2026-10-08 Agent 사전 거절 종료 처리: 변경 요청의 412/CLUSTER_PRECONDITION_FAILED, 428/CLUSTER_PRECONDITION_REQUIRED, 503/CLUSTER_IDENTITY_UNAVAILABLE 쌍만 공통 분류로 확정 거절에 추가한다. 서비스/노드/배포/과거 재배포와 수동 롤백 operation은 FAILED 및 audit을 함께 저장하고, 거절된 rollback의 deployment는 요청 전 FAILED 상태로 복귀시킨다. 실제 롤백 실행 후 수렴 실패는 기존 보호를 유지한다. 일반 503/응답 유실/잘못된 envelope는 불확실성 처리를 유지하며, 증거 없는 과거 NEEDS_ATTENTION 기록은 자동 해제하지 않는다. [거절 및 재시도 계약](AGENT_REJECTION_HANDLING.md)에 범위를 기록했다. 실제 coordinator를 사용하는 대역 회귀와 분류 단위 테스트를 추가했고, 실제 의존성 CI 결과는 이 작업의 PR 체크포인트에 기록한다.

2026-10-08 PR #114 이후 결과 동기화: PR validate #37716041070과 main validate #37716190480에서 실제 API 265개 테스트/타입 검사/빌드 및 mTLS가 통과했고, 실제 manager-agents #37716190531도 업로드와 cleanup까지 성공했다. [PR #114 체크포인트](https://github.com/KimHG1995/Docklane/pull/114#issuecomment-6050713689)가 근거다. 운영 회귀/Go 전체 suite/전체 Functional/cold recovery를 이번에 다시 실행했다는 뜻은 아니다.

2026-10-08 클러스터 등록 1단계: scoped ADMIN의 현재 논리 ID와 명시적인 환경 Swarm pin 및 manager identity를 대조한 뒤 등록과 감사를 같은 트랜잭션에 저장한다. 등록 metadata는 불변이며 동일 재호출/동시 INSERT는 기존 결과와 하나의 감사를 유지한다. 조회는 저장 정보와 설정 일치 여부만 반환하고 live health로 해석하지 않는다. 기존 migration을 바꾸지 않는 3번 schema와 기존 MySQL PoC의 등록/중복/감사 rollback 검증을 추가했다. [등록 API와 제한](CLUSTER_REGISTRATION.md)을 참조한다. 등록 테이블을 기존 조회/배포/노드/reconciliation의 필수 조건으로 연결하는 후속 작업이 남으므로 전체 cluster registration은 미완료다. 기존 mutation 거절/응답 유실 정책과 암호화 복구 범위는 유지한다.

이 단계 통과 전 production adoption을 권장하지 않는다.

## Later

- [ ] approval workflow
- [ ] scheduled deployment
- [ ] environment promotion
- [ ] Docker Config / Secret UI
- [ ] runtime configuration snapshot
- [ ] Stack / multi-service deployment
- [ ] Swarm-compatible Stack validator
- [ ] capacity dashboard
- [ ] notifications
- [ ] NCP/AWS provider adapter
- [ ] LB registration integration
- [ ] metrics/logging integrations
- [ ] image vulnerability integration
- [ ] multi-cluster overview
2026-10-08 PR #115 증거 동기화: main validate #37725655470(API 293, MySQL migration, mTLS), DB restore #37725655440 통과. 이 복구는 등록된 legacy row 복원 검증이 아니다.

2026-10-08 등록 실행 정책 2단계: DOCKLANE_CLUSTER_REGISTRATION_MODE=enforce일 때 cluster HTTP/Agent/operation lock/bootstrap entry를 매번 DB 조회로 검증한다. 등록 관리 API에는 scoped ADMIN 유지. 기존 기본 compat는 수동 전환용이고, 레코드/설정 불일치나 DB 장애면 fail closed. 새 등록을 자동 생성하거나 기존 cluster_id를 재기록하지 않는다. 실제 운영 전환과 신규 전체 functional acceptance는 미완료로 유지한다.

2026-10-08 등록 강제 DB pool 중첩 획득 보완: 리소스 lock callback의 활성 MySQL connection을 AsyncLocalStorage 범위에서 Agent 사전 등록 검증에도 전달한다. callback 종료 즉시 참조를 비활성화하며 lock 외 경로는 독립 조회로 유지한다. 등록 성공 캐시는 추가하지 않는다. 동시 10개 서로 다른 서비스와 기존 검사에 대한 CI 결과는 해당 PR에 기록한다.

2026-10-08 rollback 이력 수정: migration v4 rollback_attempts로 모든 rollback operationId→deploymentId 매핑을 보존한다. 새 시도에서 deployments.rollback_operation_id가 갱신되어도 이전 완료 operation의 조회는 영속 매핑을 사용한다. 최초 intent와 같은 트랜잭션에 이력을 남기며 중복 mutation 재전송은 하지 않는다. 기존 최신 rollback ID의 안전한 backfill만 수행하고 이미 덮인 과거 이력은 근거 없이 복원하지 않는다.

2026-10-08 PR #117/#118 결과 동기화: #117은 등록 검사의 중첩 DB checkout을 lock session 재사용으로 변경했고, #118은 rollback 시도별 불변 매핑을 schema v4로 도입했다. PR #118 최신 검증 #37732325169(API 304, MySQL 8.4, mTLS), main #37732446947 및 DB restore #37732446847 성공. 모두 기존 설정에서의 호환성 검증이며 enforce 모드의 실제 MySQL pool 포화 실험은 별도다.

2026-10-08 등록 강제 실제 MySQL 연결 포화 검증: 기존 database migration PoC의 폐기 가능한 MySQL 8.4 DB(pool limit 10)를 재사용하여 서로 다른 리소스 lock 10개가 각각 실제 MySQL connection을 보유하도록 동기화한 뒤, Agent proxy가 등록 상태를 확인하고 10개 모두 호출되는지 검증한다. 별도 workflow나 Docker 환경은 추가하지 않는다. 실패 시 실험 프로세스의 제한 시간을 적용하고 리소스 정리를 수행한다. 이번 결과는 등록 강제 모드의 전체 Swarm 배포/롤백 Functional acceptance와 별개로 기록한다.

2026-10-08 PR #119 결과 동기화: 실제 MySQL 8.4의 열 개 고유 연결을 서로 다른 lock에 점유시켜 등록 사전조건 및 Agent 호출이 모두 완료됐다. PR validate #37735884282에서 pool 10/10과 미등록/불일치 거절 및 API/mTLS가 통과했다. 전체 Swarm Functional acceptance는 아니다.

2026-10-08 등록 enforce Functional harness: 별도 opt-in으로 실제 Swarm ID를 API 시작과 재시작에 고정하고, 미등록 503 → scoped ADMIN 등록 → 불변 replay → 보호된 서비스 조회 → 기존 배포/롤백, 응답 유실, API 재시작을 검증한다. 신규 단일 노드 실환경 결과는 main push run을 확인하기 전까지 미완료다.

2026-10-08 PR #120 이후 증거 동기화: enforce 단일노드 functional PoC #37736353191에서 미등록 503, scoped ADMIN registration, immutable replay, 정상 배포/수동 rollback, API 재시작 복구, 응답 유실/자동 rollback/외부 변경 충돌 및 cleanup을 확인했다. 추가 3노드 enforce acceptance는 미완료.

2026-10-08 rollback terminal race 보완: 기존 A의 조회가 lock 획득 전에 지연되고 이후 B가 성공한 경우에도, 잠금 안 terminal 분기는 B의 가변 deployment 포인터가 아니라 저장된 A operation의 terminal status/ID/reason을 반환한다. 등록 pool 재추가 조회나 rollback mutation 재전송 없음.

2026-10-08 PR #121 병합 후 검증 동기화: PR #37740933017(API 305/305, mTLS), main #37741051045 SUCCESS. 기존 A rollback의 지연 재조회는 lock 내부에서도 A의 terminal 결과를 반환한다. 대역 회귀이며 실제 Docker 동시 rollback 주입 시험은 별개다.

2026-10-08 등록 강제 3노드 Functional PoC 준비: 기존 manager 1대/worker 2대 DinD topology에서 실제 manager Swarm ID pin, 미등록 503, VIEWER 등록 403, ADMIN 등록·재호출과 감사 1건, drain/activate, 외부 LB 트래픽, worker 장애 후 실제 ID 유지 검증을 수행한다. 기존 topology/워크플로 사용, 실제 main 실행 성공 전 체크 미완료 유지. 3-manager failover는 이번 범위가 아니다.

2026-10-08 PR #122 사후 검증 동기화: main #37742889401과 실제 1-manager/2-worker enforce 3노드 Functional PoC #37742889402가 성공했다. 137건 LB 요청, drain/activate, worker 장애 재배치, immutable 등록/감사 및 cleanup 통과. [PR #122 증거](https://github.com/KimHG1995/Docklane/pull/122#issuecomment-6054835506). 이것은 3-manager failover가 아니다.

2026-10-08 3-manager 등록 강제 failover 검증: 기존 mTLS manager Agent 실환경 harness에 disposable MySQL 등록 DB를 붙여 미등록 거절, 설정 불일치 거절, 불변 등록/감사 단일화, primary Agent 종료 후 대체 manager의 보호된 identity/cluster 조회와 새로운 Control Plane client의 등록 DB 재사용을 확인한다. 성공 여부는 main workflow의 실제 결과에 따르며, manager 노드 장애/leader 선출이나 최종 Docker mutation 재가입 경쟁 검증은 아니다.
