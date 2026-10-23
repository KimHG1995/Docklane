# Maintenance 기능 개발 완료 기준 및 통합 인수 조건

## 최신 판정 (2026-10-23)

아래 날짜별 문단은 당시의 기록이다. 현재 구현/검증 상태는 이 절을 우선한다.

### 기능 수정과 빠른 회귀

- rename 이후 directory fsync 실패는 이미 durable `.pending` marker로 보완되어 있다. marker가 남은 재시작은 OPEN을 복원하지 않는다. 초기 marker sync 실패와 rename 이후 sync 실패 회귀가 존재한다.
- 추가로 barrier PUT 요청의 본문 처리/lock 대기 중 다른 요청의 저장이 실패하면, 이전 generation의 BLOCKED를 200으로 ACK할 수 있던 경로를 수정했다. GET/PUT은 동일 barrier lock 안에서 invalid 상태를 확인한다. 실제 파일 저장 실패를 끼워 넣은 회귀는 수정 전 200을 재현했고 수정 후 503으로 거절한다.
- Manager BLOCKED 확인의 fresh readback 및 최종 roster 검증은 구현되어 있다. 누락된 테스트 대역을 수정하고 readback 실패/도중 Manager 교체 거절 회귀를 추가했다.
- 이 작업의 로컬 검증: API 363개 테스트와 typecheck, Go 전체 race suite 통과. 최종 CI는 새 PR HEAD의 결과로 판단한다.

### 이미 확보한 실제 인수 증거

[실제 3-Manager 인수 #39708410250](https://github.com/KimHG1995/Docklane/actions/runs/39708410250), HEAD `6ed4378`, [artifact 12395527873](https://github.com/KimHG1995/Docklane/actions/runs/39708410250/artifacts/12395527873)는 성공 및 소유권 기반 cleanup을 확인했다.

- 7종 Docker 변경 호출의 성공, BLOCKED 21건 및 stale generation 21건 차단
- 독립 Lease 프로세스 SIGKILL, 만료 후 fencing token 인계
- restart/image/rollback 적용 후 응답 유실, UNCERTAIN 유지 및 중복 발송 차단
- 기존 close/reopen, Agent 재시작 및 OPEN 이후 foreign Swarm 거절

이 증거는 이후 runtime 변경의 최종 인수를 대체하지 않는다. scale은 replicas 0→0의 version 증가이며 실제 workload 수렴 증거가 아니다. image/rollback은 journaled Agent client 경로이지 DeploymentCoordinator 전체 상태 흐름의 인수가 아니다.

### 최종 통합 인수와 배포 차단 조건

1. 두 상주 Nest API CP 서버의 동시 요청 처리, 활성 요청 중 SIGKILL 및 후속 CP 복구
2. CLOSED 상태에서 실제 Manager leave/init/rejoin 및 이전 identity/barrier 거절
3. DeploymentCoordinator와 deployment/operation DB 상태를 포함한 DEPLOY/ROLLBACK 전체 장애 복구
4. 실제 replica 변경과 workload 수렴
5. 운영 Docker socket/CLI 권한 제한 확인, 최종 독립 안전성/동시성 리뷰
6. 최종 runtime HEAD에서 기존 실환경 인수와 위 추가 시나리오 통과

순서는 **제품/빠른 회귀 수정 → 전체 빠른 검증 → 별도 통합 인수 작업 단위 → 최종 결과 검토**다. 새 process/network orchestration은 `AGENTS.md`에 따라 제품 수정과 분리하고 기존 workflow를 재사용한다. 중복 workflow나 문서 변경만을 이유로 한 실환경 재실행을 추가하지 않는다.

현재 PR은 Draft를 유지한다. 위 조건이 충족되기 전에는 병합/운영 배포 가능 또는 Maintenance enforcement 활성화 가능으로 보고하지 않는다.

## 별도 최종 인수 하네스 (2026-10-23, 실환경 실행 대기)

제품 수정 HEAD `76caa65`의 [CI #39880932534](https://github.com/KimHG1995/Docklane/actions/runs/39880932534)는 통과했다. 이후 제품 코드를 추가하지 않는 별도 인수 작업 단위에서 기존 3-Manager 하네스를 확장한다.

- `maintenance-closed-rejoin.mjs`: DB CLOSED generation 3 중 Manager를 실제 foreign Swarm으로 전환한다. foreign Swarm의 실제 서비스에 대한 BLOCKED 오류와 version 불변을 확인한 뒤, 원래 Swarm으로 재가입하고 새 canonical Node ID/BLOCKED 상태를 검증한다.
- `maintenance-deployment-faults.mjs`: 실제 application/target/releases/operation/deployment/audit DB 경로와 DeploymentService를 사용한다. 실제 replicas 1→2 및 digest-pinned task/placement 수렴, DEPLOY/ROLLBACK 적용 후 응답 유실과 원본 UNCERTAIN 보존/중복 발송 방지를 확인한다. HTTP health는 제어된 loopback fixture이며 실제 애플리케이션 health endpoint 통합으로 확대 해석하지 않는다.
- `maintenance-resident-cp.mjs`: 두 상주 Nest AppModule CP의 동시 API 요청을 사용한다. Agent의 실제 적용 ACK를 relay에서 보류하고 첫 CP를 SIGKILL한 뒤, 두 번째 CP의 복구와 mutation 재발송 부재, 원본 SENDING/admission 보존을 확인한다.
- 기존 workflow만 사용하고 heavy 인수를 `workflow_dispatch`로 제한한다. Node helper 정적 검사 및 빠른 회귀는 동적으로 발견한다.

**하네스 구현이나 빠른 회귀 통과만으로 실제 인수 완료를 표시하지 않는다.** 실행 환경에서 제품/하네스 SHA, 전체 로그, `maintenance-acceptance.json`과 소유권 기반 cleanup 결과를 함께 확인해야 한다. 운영 Docker socket/CLI 권한 제한 확인도 별도로 필요하다.

실행 전 조건: disposable Docker host의 Swarm은 inactive이고 기존 owned fixture 이름/포트가 비어 있어야 한다. Agent는 Docker Engine 아키텍처에 맞는 Linux 바이너리로 빌드한다. 예시 환경은 `DOCKLANE_OR_MAINTENANCE_ACCEPTANCE=1`, 고유 `DOCKLANE_OR_LOG_DIR`, `DOCKLANE_MANAGER_AGENT_BINARY`이며 실행 진입점은 `bash tests/operational-readiness/manager-agents.sh`다. 호스트 Swarm을 변경하거나 기존 사용자 workload를 정리하지 않는다.

## 상태 (2026-10-16)

PR #137의 기능 코드가 포함하는 범위:

1. 등록된 실제 Swarm ID를 기반으로 한 Maintenance 영속 상태 및 세대 CAS
2. OPEN→CLOSING 요청과 Scoped ADMIN 권한, 감사 원자성
3. 신규 서비스/노드 mutation 차단, 기존 operation 관측/복구 전용 lock 분리
4. Agent mutation 직전 OPEN/generation 검사 및 durable dispatch PREPARED/SENDING/ACKNOWLEDGED/REJECTED/UNCERTAIN 기록
5. 동일 operation의 중복 발송 방지, MySQL 10개 세션 Lock 중복 획득 방지
6. Go Agent의 영속 OPEN/BLOCKED barrier 및 7종 Docker mutation 진입점 차단
7. 실제 Manager Swarm roster와 모든 Agent identity 대조, generation-pinned ACK 수집
8. 진행 중 mutation admission 영속 추적과 CLOSED 진입 전 미정리 작업 확인
9. MySQL 감사 원자성, CLOSED 상태 확정, stale generation 거부
10. 다중 CP 유지보수 조정용 단조 증가 Lease/Fencing Token (v10)
11. CLOSED→RECONCILING→OPEN: 관리자 승인, 전체 Manager 재확인, 미정리 operation/dispatch/admission 거부, 감사 트랜잭션
12. DB OPEN 커밋 후 모든 Agent OPEN, ACK 유실 또는 부분 실패 시 동일 세대만 재시도

## 핵심 상태 흐름

```text
OPEN --(ADMIN close-request CAS+audit)--> CLOSING
  --(all manager BLOCKED, no in-flight/uncertain operations, CP lease+audit)--> CLOSED
  --(ADMIN begin-reconciliation, CP lease+audit)--> RECONCILING
  --(all manager BLOCKED at fresh generation, zero unresolved work, CP lease+audit)--> OPEN
  --(explicit all-manager OPEN + readback)--> operational readiness
```

OPEN DB 커밋 이후 Agent 일부가 아직 BLOCKED일 수 있다. 안전을 위해 DB를 먼저 커밋한 결과로, 이때 서비스 가용성은 부분 제한된다. `resume-managers`는 동일한 OPEN generation에 대해서만 재확인·재개를 시도하며 Docker mutation이나 DB 상태 전이를 반복하지 않는다.

## 내구성 및 보안

- CP Lease의 만료 시각은 DB UTC 시각을 사용한다. 같은 클러스터에 대한 조정 작업은 Lease 소유자와 Fence Token을 확인하며, 토큰은 재획득할 때마다 증가한다.
- CLOSING/CLOSED/RECONCILING에는 기존 operation의 조회·확정이 가능하지만 신규 Docker 변경은 거절한다.
- SENDING/UNCERTAIN과 CP 장애로 남겨진 active admission은 자동 만료시키지 않는다. 조정 및 운영자 확인 전에는 CLOSED와 OPEN 재개가 차단된다.
- 실제 Docker Engine 변경은 Agent 내부 최종 Swarm ID 검사와 Docker version CAS로 추가 방어한다. 그러나 SwarmInspect와 Docker Update 간 원자성을 제공하지 않으며, 외부 Docker CLI/소켓을 사용하는 관리자는 Docklane 통제를 우회할 수 있다.
- Manager barrier PUT의 인가는 현재 Agent mTLS 클라이언트 인증 범위에 의존한다. 전용 관리자 클라이언트 권한, 네트워크 접근과 Docker 소켓 권한 분리가 운영 적용 전 필수다.
- 새 환경변수 `DOCKLANE_AGENT_MAINTENANCE_STATE_FILE` 과 `DOCKLANE_MAINTENANCE_ENFORCE`는 기존 설치에서 비활성화되며, 모든 Manager에 안전하게 단계적 배포한 뒤 명시적으로 활성화해야 한다.

## 기능 개발 완료와 통합 인수는 별도

**Feature Complete**는 코드 연결과 타입 검사, 단위 테스트, 실제 MySQL Migration/트랜잭션 PoC 통과를 의미하며, 아래 외부 인수 시험을 대체하지 않는다.

병합을 위해 반드시 확인할 통합 인수 조건:

- disposable **실제 3-manager Docker Swarm**, 각 Manager 독립 Agent + 영속 barrier 파일
- 두 CP가 같은 DB에 접속한 상태에서 Lease 경쟁, 만료·재획득, 오래된 Fence Token 거부
- Agent 요청을 막고 CLOSING으로 전이해 진행 중 ServiceUpdate/NodeUpdate 종료 대기 및 신규 mutation 0건 확인
- 7종 mutation 전부에서 stale generation, Manager 일부 DOWN, 고장난 barrier 파일, 실제 응답 유실 시험
- CP 강제 재시작, HTTP 전송 전/중/후 실패, DB 커밋/감사 INSERT 실패 주입 후 UNKNOWN 상태 보존
- CLOSED 이후 실제 Swarm leave/init 재가입, 재가입 ID 불일치 거절과 service/node cleanup 검증
- 재조정 후 RECONCILING→OPEN 및 Agent 일부 OPEN ACK 유실·재시작·부분 재개 재시도
- 외부 Docker CLI 접근이 운영 정책으로 통제되는지 확인, 우회가 불가피한 경우 이를 잔여 위험으로 명시
- 최종 변경 커밋 CI와 보안·동시성 리뷰 통과

이 통합 인수 이전에는 PR #137을 Draft로 유지하고 운영에서 Maintenance enforcement를 활성화하지 않는다.

## 2026-10-16 PR #137 review remediation

Three confirmed P2 defects fixed before release:

1. **Foreign Swarm OPEN replay:** Go Agent barrier lookup and the mutation guard compare the persisted Cluster ID, fresh Docker Manager Swarm ID and expected request Cluster ID. Stale/foreign or unavailable state fails closed; Go regression reproduces A→B restored-file mismatch.
2. **Explicit audit-backed fault recovery:** New migration v11 records admission process UUID, resource and the operation ID when a durable dispatch is prepared. Original UNCERTAIN/SENDING/active admission rows are not deleted; scoped ADMIN can inspect and explicitly resolve one evidence UUID with a substantive observation and reason only after the full registered Manager roster confirms BLOCKED at the current generation. Terminal operation status is required before resolving a dispatch. Both resolution and audit INSERT share an InnoDB transaction and unique replay protection. MySQL 8.4 acceptance injects an audit failure and confirms rollback/retention, then succeeds and verifies original evidence remains.
3. **Explicit bootstrap:** Scoped ADMIN initialization checks registration enforcement and fresh live Manager Swarm ID, then uses one transaction for initial OPEN generation 1 plus audit. Replays preserve an existing CLOSING/CLOSED state and ownership. MySQL 8.4 verifies audit failure rollback and idempotence.

**CI is not live Docker acceptance.** Real 3-Manager Swarm plus 2 CP tests, crash/rejoin scenarios, seven Docker mutations, and explicit external Docker CLI/socket permission restrictions still block merge and enabling production enforcement. Keep Draft until independent security/concurrency review and full integration acceptance.

## 2026-10-19 post-review P2 fixes

- Service AND node mutation resource locks propagate the same `withActiveAdmission` AsyncLocalStorage scope. Journal preparation binds the durable operation ID to the admission row for DRAIN / ACTIVATE / LABELS, just as for service scale/restart/deploy/rollback.
- Unobserved mutation `NEEDS_ATTENTION / MUTATION_NOT_OBSERVED` and `NODE_MUTATION_NOT_OBSERVED` are not automatically terminal. A scoped administrator must first obtain all-manager BLOCKED confirmation; the recovery endpoint fetches a **fresh service/node version + fingerprint** from the Agent and supplies it to one atomic MySQL recovery transaction.
- That transaction checks current lease and generation, locks the original dispatch and operation, requires the precise unchanged version and before-spec fingerprint, changes only the matching NEEDS_ATTENTION operation to `FAILED / MANUAL_MUTATION_NOT_OBSERVED`, inserts a dedicated operation-recovery audit, and inserts an immutable dispatch evidence resolution with its own audit. All changes roll back together on failure.
- An earlier CP response loss is never described as definitively unsent. It is a manual administrative determination that the requested Docker mutation is not present at the verified observation boundary; external writers and later changes remain outside Docker atomicity guarantees.
- The original dispatch is left `UNCERTAIN`; no automatic ACK rewrite, timer expiry or audit-free delete. Only the resolution ledger excludes it from the CLOSED gate.
- Real MySQL acceptance includes version mismatch refusal, correctly matched service operation + UNCERTAIN resolution, replay refusal and original immutable phase retention, and both service/node admission-operation linkage.
- Actual 3-manager Docker Swarm and two CP fault injection remains an independent merge blocker.

## 2026-10-20 실제 3-Manager 통합 인수 1차 실행

[GitHub Actions #39347891686](https://github.com/KimHG1995/Docklane/actions/runs/39347891686) — **PASS**, artifact `docklane-maintenance-three-manager-39347891686` (ID `12231962020`), 27개 증거 파일 업로드 및 소유권 기반 cleanup PASS.

전용 workflow `maintenance-three-manager-acceptance.yml`은 소유한 Docker-in-Docker Manager 3대, 각자의 mTLS Go Agent/영속 barrier 파일과 MySQL 8.4를 생성한다. 별도 OS 프로세스 CP의 Lease 획득 경쟁 및 소유권 교체/구 token 거절, 실제 ServiceUpdate(재시작), 실제 NodeUpdate(라벨), 전 Manager BLOCKED ACK, 7종 경로×3 Manager = 21건의 차단 요청, audit-backed CLOSED 및 RECONCILING→OPEN, Manager 한 대 Agent 응답 유실 후 재시작/재개방, 마지막에 강제 Swarm leave/init 후 이전 cluster barrier 조회/변경 412 거절을 검증했다.

**검증 범위 제한**: 이 1차 실행은 정상 Control Plane 클래스와 DB 경로/독립 Lease 프로세스를 사용하는 실환경 시험이다. 별도 CP 두 대가 동일한 전체 API 서버로 동시에 트래픽을 처리하면서 SIGKILL되는 경우, Docker API 응답을 주입해 전송 중/후에 유실시키는 경우, 7종 **실제 변경 성공 경로**(21건의 차단 시험과 구별), DEPLOY/ROLLBACK 애플리케이션 전체 흐름의 실제 장애 주입 및 제한된 Docker 소켓 운영 권한은 아직 입증되지 않았다. 따라서 PR Draft 및 생산 enforcement 금지는 유지한다.

## 2026-10-20 P2 assertion specificity — live retest

[GitHub Actions #39353720145](https://github.com/KimHG1995/Docklane/actions/runs/39353720145) **PASS**. Evidence artifact [12234362624](https://github.com/KimHG1995/Docklane/actions/runs/39353720145/artifacts/12234362624), owned fixture cleanup PASS.

- All 7 mutation paths on all 3 Managers (21 requests) at **current BLOCKED generation 2** must return HTTP 409 with JSON `code=MAINTENANCE_AGENT_BLOCKED`, not just an arbitrary 409. After the probe, both real service and node Version/SpecHash stay unchanged.
- After all Managers explicitly reopen at generation 5, 7 paths × 3 Managers (21 **separate** probes) with obsolete generation 4 must return 409 with `code=MAINTENANCE_GENERATION_STALE`; service/node Version/SpecHash must stay unchanged.
- These tests detect an accidentally removed Agent BLOCKED guard even if stale-generation checking survives. Actual Docker update success was already covered for service restart/node labels in the same disposable scenario, not all seven mutation success cases.
- Scope still outstanding: simultaneous two resident CP API servers and SIGKILL while active, Docker mutation response loss **after** daemon application, full seven successful mutations, DEPLOY/ROLLBACK end-to-end faults, CLOSED-time rejoin before reopen, and operational Docker socket permissions. Do not mark these as passed based on a 409 assertion.

## 2026-10-20 최신 재검증 (823e268)

- [실제 3-Manager 인수 #39374137080](https://github.com/KimHG1995/Docklane/actions/runs/39374137080) — PASS. 독립 CP SIGKILL, DB 기준 Lease 만료 후 재획득, 더 높은 fencing token 및 이전 owner 거절을 포함한 기존 통합 하네스 전체 성공.
- [일반 검증 #39374140609](https://github.com/KimHG1995/Docklane/actions/runs/39374140609) — 실행된 검증 Job 모두 PASS (조건부 skipped Job 제외).
- `maintenance-three-manager.mjs`의 Worker stdout 구분자를 리터럴 `\\n` 검색에서 실제 줄바꿈 검색으로 수정한 커밋 [823e268](https://github.com/KimHG1995/Docklane/commit/823e26860a57957650058cebabcb87751e0e29f2)에서 재검증.

**검증되지 않은 범위 (병합 차단):** 7종 모두의 정상 Docker 변경 성공 경로, 전체 DEPLOY/ROLLBACK 장애 주입, 실서비스 2개 CP 동시 API 수신 및 강제 종료, CLOSED 도중 Manager 재가입, 외부 Docker socket/CLI 제한의 운영 입증, 독립 보안·동시성 리뷰. 성공한 기존 하네스를 이 항목들의 PASS로 확대 해석하지 않는다.

**추가 리뷰 필요:** Go Agent barrier의 `persist()`가 rename 이후 디렉터리 fsync에서 실패하는 경우, setter는 현재 프로세스 상태만 BLOCKED로 내린다. OPEN 전환 중 이러한 실패가 발생하면 재시작에서 파일에 남은 OPEN을 재수용할 위험이 있는지 장애 주입으로 확인하고, 복구 시 안전성을 증명할 때까지 완료로 분류하지 않는다.
