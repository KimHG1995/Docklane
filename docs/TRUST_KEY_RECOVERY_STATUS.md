# Swarm 암호화 복구 검증 상태

## 마지막 전체 복구 실행

실환경 증거는 `main@72a860efb49f0d326bf7b1bccbe31611e17323d4`의 [recovery-v2 run #37406102027](https://github.com/KimHG1995/Docklane/actions/runs/37406102027)이다. PR #100 파서 수정 이후에도 정상 키 restore-unlock이 30초 제한에서 종료 코드 137로 실패했다. 원본 manager unlock, 복원 manager의 locked 상태와 잘못된 키 거절은 통과했지만 force-new-cluster, 키 회전 및 fresh worker join에는 도달하지 못했다.

진단 수집, artifact 업로드와 cleanup은 성공했다. [PR #100 체크포인트](https://github.com/KimHG1995/Docklane/pull/100#issuecomment-6008373060)의 artifact `11386897386`에는 다음이 기록돼 있다.

- DinD Engine 28.5.2 / API 1.51, status=collected, 7개 probe의 timeout/truncation 없음.
- OOMKilled=false, LocalNodeState=pending, ControlAvailable=true.
- 별도 goroutine 요약의 Cluster.UnlockSwarm (swarm.go:350)과 raft.WaitForLeader (util.go:52) / Manager.Run (manager.go:609) 대기.
- ZIP SHA256: `c283b3f8f9bd5f72734628940341ba2515d378283d73d4d8bb14c30b9d61e81c`.

ControlAvailable만으로 준비 완료를 판정하거나 137만으로 OOM을 단정하지 않는다. CLI 종료 후에도 daemon 쪽 unlock 요청은 남아 있을 수 있다.

이전 run #37396470008과 #37385891177도 restore-unlock 실패이고 #36984088600은 cancelled다. 이전 정규화기는 일부 goroutine을 합쳤으므로 과거 요약 전체를 단일 호출 경로로 해석하지 않는다. 원본 stack은 artifact에 없어 과거 요약을 소급 복원할 수 없다. 일반 Swarm 복구의 주소 불일치와 암호화 복구 실패는 별개의 증거다.

## 원인 분리 작업

Engine 28.5.2의 UnlockSwarm은 제어 mutex를 잡은 채 node runner의 준비를 기다리며 Init도 같은 mutex를 사용한다. 단순 timeout 증가 또는 병렬 force-new-cluster는 검증된 해결책이 아니다. 상세 소스와 조건부 실험은 [unlock/quorum 대조 실험](UNLOCK_QUORUM_PROBE.md)에 기록했다.

새 대조 실험은 같은 follower를 quorum이 있는 경우와 나머지 peer가 pause된 경우에 재시작한다. 아직 살아 있는 30초 제한 unlock 한 건에서만 원래 peer를 재개하고 같은 요청이 정상 종료하는지 확인한다. 백업 복사 없이 readiness 의존성을 분리하는 실험이며 단일 백업 복구 acceptance를 대체하지 않는다. 새로운 실환경 결과는 병합 후 PR 체크포인트에 기록하고 다음 작업에서 ROADMAP에 동기화한다.

제품 API/Web/Agent, trust-key-restore-v2.sh, 기존 복구 순서와 unlock 제한 시간은 변경하지 않는다. Autolock을 해제하거나 실패를 무시하여 acceptance를 통과시키지 않는다. PR #101~#103의 identity, cleanup, resource contention 보완도 전체 암호화 복구 성공을 뜻하지 않는다. Legacy v1은 PR #102 이후 수동 실행만 남아 있다.

## 대조 실험의 실패 이력과 진단 수정

[run #37419223384](https://github.com/KimHG1995/Docklane/actions/runs/37419223384)는 `main@8e61dbd`에서 실패했다. Quorum이 있는 대조군 unlock은 완료했지만, peer를 pause한 조건에서 진단용 `docker info`가 내부 3초 제한으로 exit 137을 반환했다. 스택 수집과 peer 재개에는 도달하지 못했고, cleanup과 artifact 업로드는 성공했다. 이 결과는 원래 단일 백업 복구의 30초 unlock timeout과 구분한다. [체크포인트](https://github.com/KimHG1995/Docklane/pull/105#issuecomment-6010113874)의 artifact `11392640956`은 결과 JSON 한 개이며 ZIP SHA256은 `84d0ad327011d3eac52850a8e3ca7a3b685cc5cfe6d02636dd03345ba4b3b753`이다.

PR #106은 `Probe.snapshot()`의 상태 조회와 스택 수집을 분리했다. 조회 timeout 또는 잘못된 JSON/필수 필드 오류는 unknown/partial로 기록하고, ownership이 확인된 daemon의 스택은 남은 예산 내에서 별도로 수집한다. 당시 정상 info 조회 결과는 상태와 control boolean만 보존했다. 재개 판정 전에 기존 결과 JSON의 `snapshot` 필드에 정규화한 프레임을 저장하므로 이후 판정 실패와 cleanup에도 증거가 남는다.

상태가 unknown이면 스택이 있어도 기존 `pending_evidence` 검증은 실패한다. 정보 부족을 pending으로 추정하거나 재개 조건을 완화하지 않는다. 진단 명령은 ownership 확인부터 공유 10초 예산, 각 외부 명령 최대 4초와 내부 명령 3초 제한을 사용한다. 이 예산은 unlock의 30초 예산에 포함되며 별도로 추가하지 않는다. 소유권 검증 실패 시 exec/signal을 금지하고, signal 실패 후에는 이전 dump를 읽지 않는다. 전체 대조 실험 또는 단일 백업 복구 성공은 새 실제 실행으로만 판단한다.

## 로컬 준비 상태 조회

[PR #106 이후 run #37422751815](https://github.com/KimHG1995/Docklane/actions/runs/37422751815)는 info 상태 조회가 unavailable인 상태에서도 스택 요약 62개를 보존했다. 별도 UnlockSwarm과 WaitForLeader/Manager.Run 대기를 확인했지만 unknown 상태 때문에 peer 재개 전에 실패했다. Cleanup과 artifact 업로드는 성공했고 main validate #37422751838 및 운영 회귀 80개가 통과했다. Artifact `11393194019`의 ZIP SHA256은 `e705c7a33cfc135348b0eb7ba6e515419d695f4e86718541078ed4abf303702a`다. 이 실행의 info 종료 코드는 보존되지 않았다.

Moby의 [Info](https://github.com/moby/moby/blob/v28.5.2/daemon/cluster/swarm.go#L432-L498)는 Raft-backed cluster/nodes 조회를 포함한다. 반면 [HEAD /_ping](https://github.com/moby/moby/blob/v28.5.2/api/server/router/system/system_routes.go#L39-L67)의 Swarm 헤더는 [Cluster.Status](https://github.com/moby/moby/blob/v28.5.2/daemon/cluster/swarm.go#L496-L515)를 통해 node runner 상태를 로컬에서 읽는다. 대조 실험의 snapshot만 후자로 전환한다. 이를 즉시 응답의 절대 보장으로 간주하지 않고 helper 2초, 내부 exec 3초, 외부 명령 최대 4초와 공유 진단 10초 제한을 유지한다.

`local-swarm-status.go`는 Go 표준 라이브러리만 사용하며 owned follower에 복사한 정적 바이너리가 `/var/run/docker.sock`에 HEAD 요청 하나만 보낸다. TCP/프록시/Docker 환경변수, redirect, retry, info fallback은 사용하지 않는다. HTTP 200과 단일 Swarm 헤더, 문서화된 여섯 값만 허용한다. 누락/중복/비정상/시간 초과는 unknown이며 원시 응답을 출력하지 않는다.

재개 판정은 `StateSource=ping-swarm-header`의 실제 pending과 별도 스택의 chan receive UnlockSwarm 및 select WaitForLeader + Manager.Run을 요구한다. Ping은 ControlAvailable을 제공하지 않으므로 이를 true로 합성하지 않고 null로 남긴다. 동일한 살아 있는 unlock과 남은 시간 확인, 성공 후 topology/cluster ID/key 보존 검증을 계속 수행한다. 대기 함수 이름만 있거나 unknown/active/locked 상태이면 재개하지 않는다. 이 변경은 기존 peer 복귀 대조 실험만 다루며 단일 백업의 강제 quorum 복구를 구현한 것은 아니다.

## 유지하는 복구 검증

- Negative fixture는 실제로 다른 32바이트 키를 만든다. 마지막 base64 문자의 무시되는 padding bit만 바꾸지 않는다.
- Locked/invalid-key는 local state, 종료 코드 및 Docker 오류로 판정한다. 연결 오류와 timeout은 기대한 거절이 아니다.
- DinD 내부 CLI와 외부 exec 모두 제한한다. 전체 복구의 기본 unlock 제한은 30초다.
- 전체 복구에서 timeout 이후 unlock 재전송이나 force-new-cluster를 시도하지 않는다. 대조 실험도 이미 종료되거나 만료된 요청에서 peer 복귀를 진행하지 않는다.

## 실패 시 진단과 비밀정보

전체 복구의 정상 키 unlock 실패는 원래 단계/종료 코드를 먼저 기록하고 recovery-diagnostics.py를 실행한 뒤 EXIT cleanup으로 넘어간다. 진단 실패나 자료 누락은 복구 실패를 성공으로 바꾸지 않는다.

소유권 파일의 전체 container ID, 실제 inspect ID와 이름이 일치하고 private PID namespace인 경우에만 내부 exec를 허용한다. 공식 DinD의 PID 1은 docker-init일 수 있으므로 /var/run/docker.pid의 양수 PID와 /proc/<pid>/comm == dockerd를 확인한 뒤 컨테이너 내부 daemon에 SIGUSR1을 보낸다. 호스트 Docker 또는 PID 1을 무조건 신호 대상으로 삼지 않는다.

기존 수집기의 전체 예산은 35초, 외부 실행 제한은 40초, 각 외부 probe는 최대 4초, 내부 명령은 3초다. 준비 조회가 멈추면 가능한 진단을 남기고 partial로 표시한다. 기존 복구 JSON에는 버전/commit/image digest, container/node 식별자, IP, OOM 상태, 읽을 수 있는 Swarm 상태, daemon 오류 분류 횟수, 정규화한 대기 함수/파일/줄 번호 및 probe 결과만 남긴다.

원본 로그/stack은 익명 임시 파일에서 읽고 artifact 경로에 쓰지 않는다. 함수 인자, 메모리 주소, 임의 오류 원문, 환경변수, unlock/join key와 개인키는 진단 JSON에 복사하지 않는다. collected는 수집 완료이지 복구 성공이 아니며 전체 goroutine이나 모든 비밀정보를 빠짐없이 검사했다는 보장도 아니다. 이 설명은 진단 경로에 대한 것으로 전체 기존 artifact의 보안 감사 완료를 뜻하지 않는다.

새 대조 실험은 별도의 JSON 두 개로 artifact를 제한하며 원래 복구 수집기의 실패 코드나 acceptance 필드를 위조하지 않는다. 원시 stack 대신 기존 정규화기로 확인한 별도 대기 위치의 판정과, 제한된 함수명/파일명/줄 번호 프레임을 `snapshot` 필드에 보존한다. 이 필드의 collected/partial은 수집 상태이며 복구 성공이나 peer 재개 승인이 아니다.

## 파서 및 회귀 검증

Goroutine 헤더 경계와 상태 문자열 파싱은 분리돼 있다. 미지원/잘린 헤더는 이전 프레임 연결을 끊고 다음 정상 헤더까지 제외한다. 점/괄호 포함 상태를 지원하되 상태 길이 96자, 요약 최대 256개, goroutine당 최대 40개 프레임 제한과 함수/파일/줄 번호 필터를 유지한다. 대기 시간, thread metadata, label 원문과 인자는 복사하지 않는다.

PR #103의 진단 13개, 파서 9개, 복구 Bash 8개, cleanup/legacy trigger 9개, 준비 대기 8개로 총 47개 회귀가 통과했다. [검증 체크포인트](https://github.com/KimHG1995/Docklane/pull/103#issuecomment-6009469585)를 참조한다. 새 대조 실험의 21개 회귀는 Python 오케스트레이션과 실제 자식 프로세스를 실행하되 Docker는 대역이다. 이를 실환경 복구 성공 근거로 사용하지 않는다.

```bash
python3 tests/operational-readiness/local-swarm-status-test.py
python3 tests/operational-readiness/unlock-quorum-probe-test.py
python3 tests/operational-readiness/unlock-quorum-snapshot-test.py
python3 tests/operational-readiness/recovery-diagnostics-test.py
python3 tests/operational-readiness/recovery-stack-test.py
python3 tests/operational-readiness/trust-key-restore-test.py
```

기존 validate는 *-test.py를 자동 탐색한다. 새 heavy 대조 실험은 main push 또는 명시적인 수동 실행만 사용하고 PR synchronization에서 실행하지 않는다. 원래 recovery-v2를 반복 재실행하는 개발 루프는 추가하지 않는다.

## 완료 조건

잠금 및 잘못된 키 거절, 올바른 키로 단일 암호화 백업 복원, root CA 보존, 키 회전 후 검증과 fresh worker join이 실제로 모두 통과한 run만 전체 acceptance 완료 근거다. 기존 peer의 일시 장애를 복원하는 대조 실험으로 조건을 완화하지 않는다. **전체 암호화 복구와 recovery runbook은 미완료**다.

## 참고 자료

- [Docker backup/restore 및 quorum 상실 복구](https://docs.docker.com/engine/swarm/admin_guide/)
- [Docker autolock](https://docs.docker.com/engine/swarm/swarm_manager_locking/)
- [Docker daemon 로그 및 SIGUSR1](https://docs.docker.com/engine/daemon/logs/)
- [Docker DinD entrypoint](https://github.com/docker-library/docker/blob/master/dockerd-entrypoint.sh)
- [SwarmKit key encoding](https://github.com/moby/swarmkit/blob/1fd637ba5cc32ff30d1dd2bdb14997bd4f424b46/manager/encryption/encryption.go)
- [Go goroutine 헤더](https://go.dev/src/runtime/traceback.go)
- [Go 대기 상태](https://go.dev/src/runtime/runtime2.go)
