# Swarm 암호화 복구 검증 상태

## 기준과 실제 실패

실환경 증거의 기준 소스는 `main@00f0db13db35c7098038513c74551f9197a48278`다.
[recovery-v2 run #37396470008](https://github.com/KimHG1995/Docklane/actions/runs/37396470008)은 **failure**다. PR #99 병합 후 기존 하네스 8개와 진단 회귀 13개, disposable-host 확인, artifact 업로드와 cleanup은 성공했지만, 정상 키 `restore-unlock`은 30초 제한에서 종료 코드 137로 중단됐다. 후속 unlock 재시도나 `force-new-cluster`는 실행하지 않았다.

[PR #99의 병합 후 체크포인트](https://github.com/KimHG1995/Docklane/pull/99#issuecomment-6007072222)에 기록된 artifact `11383490137`의 관찰은 다음과 같다. 이번 파서 수정이 새 실환경 검증을 수행했다는 뜻은 아니다.

- DinD Engine 28.5.2 / API 1.51에서 진단 `status=collected`, probe timeout/truncation 없음.
- `OOMKilled=false`, `LocalNodeState=pending`, `ControlAvailable=true`. 137만으로 OOM을 단정하거나 control flag만으로 준비 완료를 판정하지 않는다.
- `UnlockSwarm`의 `nr.Ready()` 대기와 manager의 `raft.WaitForLeader()` 대기 위치를 각각 확인했다. CLI 종료 뒤에도 daemon 요청이 남아 있었다.
- 이전 정규화기는 일부 goroutine 헤더를 놓쳤다. 위 호출 위치는 개별 관찰이며, 인접 프레임 전체가 하나의 호출 스택이라는 증거는 아니다. 원본 stack은 artifact에 없으므로 이미 저장된 요약을 이번 수정으로 소급 복원할 수 없다.

이전 [run #37385891177](https://github.com/KimHG1995/Docklane/actions/runs/37385891177)도 정상 키 restore-unlock에서 실패했고, [run #36984088600](https://github.com/KimHG1995/Docklane/actions/runs/36984088600)은 cancelled다. 둘 다 성공 근거가 아니다. 일반 Swarm 복구에서 확인한 manager 주소 불일치는 별도 실행의 증거이며 암호화 복구 원인으로 혼동하지 않는다.

이번 작업은 **goroutine 스택 경계 파싱 수정과 상태 문서 동기화**다. 제품 API/Web/Agent, 복구 shell harness와 workflow, cleanup, unlock 제한 시간과 복구 순서는 바꾸지 않는다. Autolock을 끄거나 실패를 무시하여 acceptance를 통과시키지 않는다.

## 유지하는 검증

- 실제로 다른 32바이트 키를 만드는 negative fixture를 사용한다. 마지막 base64 문자의 padding bit만 변경하는 방식은 사용하지 않는다.
- locked/invalid-key는 local state, 종료 코드와 Docker 오류 문구로 판정한다. 연결 오류와 timeout은 기대한 거절이 아니다.
- DinD 내부 CLI와 외부 exec를 모두 제한한다. 기본 unlock 제한은 30초다.
- CLI 종료는 daemon 요청 취소를 증명하지 않는다. timeout 뒤 unlock 재전송이나 `force-new-cluster`를 시도하지 않는다.

## 실패 시 진단

정상 키 unlock이 실패하면 원래 단계/종료 코드를 먼저 기록한다. 이어 `recovery-diagnostics.py`를 실행하고, 그 뒤 EXIT cleanup으로 넘어간다. 진단 실패나 일부 자료 누락은 원래 복구 실패를 성공으로 바꾸지 않는다.

수집 대상은 하네스가 기록한 전체 container ID다. 소유권 파일, inspect ID와 container 이름이 일치하고 private PID namespace인 경우에만 내부 exec를 허용한다. 공식 DinD의 PID 1은 `docker-init`일 수 있으므로 `/var/run/docker.pid`의 양수 PID와 `/proc/<pid>/comm == dockerd`를 확인한 뒤 컨테이너 안에서 `SIGUSR1`으로 stack dump를 요청한다. 호스트 Docker나 PID 1을 무조건 신호 대상으로 삼지 않는다.

진단의 전체 예산은 35초, 외부 Python 실행 제한은 40초다. 각 외부 probe는 최대 4초, DinD 내부 프로세스는 3초로 제한한다. 준비 상태 조회가 멈추어도 stack/로그 수집을 가능한 범위에서 계속하고 `partial`을 기록한다.

업로드하는 `recovery-diagnostics-<phase>.json`에는 다음만 남긴다.

- 내부 Engine/API 버전, Git commit과 image ID/digest
- container ID, 노드 IP와 OOMKilled 여부
- 읽을 수 있는 local Swarm 상태와 manager 주소
- daemon 오류의 분류별 횟수
- goroutine 대기 상태, 함수명, 소스 파일명과 줄 번호
- probe별 종료 코드, timeout, 파싱/자료 누락 상태

원본 daemon 로그와 stack은 익명 임시 파일에서 읽고 닫으며 artifact 경로에는 쓰지 않는다. Go 함수 인자, 메모리 주소, 임의 오류 원문, 환경변수, unlock/join key와 개인키는 새 JSON에 복사하지 않는다. 수집기에 키를 인자로 전달하지 않는다. 이 보장은 새 진단 경로에 대한 것이며 기존 전체 artifact의 일반적인 비밀정보 감사 완료를 뜻하지 않는다.

`collected`는 진단 수집 완료일 뿐 복구 성공이 아니다. `partial`은 일부 자료가 부족하고 `ownership-unverified`는 안전하게 대상을 확인하지 못했다는 의미다. 어떤 값도 acceptance 성공을 나타내지 않는다.

## 스택 경계 파싱

`goroutine `으로 시작하는 헤더를 만나면 먼저 이전 프레임 연결을 끊는다. 상태 문자열을 인식하는 정규식과 경계 처리를 분리하여, 미지원 또는 잘린 헤더 아래 프레임이 이전 goroutine에 붙지 않게 한다.

`sync.WaitGroup.Wait`, `sync.Mutex.Lock` 같은 점 포함 상태와 `force gc (idle)`, `chan receive (nil chan)` 같은 괄호 포함 상태를 지원한다. 상태는 제한된 문자 집합과 최대 96자로 제한한다. 대기 시간과 `locked to thread`는 헤더 구분에만 사용하고 출력 상태에는 복사하지 않는다. 미지원 헤더 메타데이터, 주소, label 원문은 보존하지 않는다. 지원하지 않는 형식의 프레임은 다음 정상 헤더까지 제외한다.

함수/파일/줄 번호 필터와 최대 256개 요약, goroutine별 최대 40개 프레임 제한은 유지한다. 미지원 헤더와 허용되지 않은 함수가 제외되므로 요약 항목 수는 실제 goroutine 총수가 아니다. `collected`도 모든 헤더나 프레임을 빠짐없이 해석했다는 보장은 아니다.

## 로컬 및 PR 검증

```bash
bash -n tests/operational-readiness/trust-key-restore-v2.sh
python3 tests/operational-readiness/trust-key-restore-test.py
python3 tests/operational-readiness/recovery-diagnostics-test.py
python3 tests/operational-readiness/recovery-stack-test.py
```

기존 하네스 회귀 8개, 진단 회귀 13개, 새 스택 경계 회귀 9개가 로컬에서 모두 통과했다. 새 경계 테스트를 원본 파서에 실행하면 25개 assertion/subtest 실패가 재현되고, 수정 후 9개 테스트가 모두 통과한다. 스택 테스트는 synthetic 입력으로 실제 파서를 직접 실행하며 Docker를 사용하지 않는다. 기존 진단 회귀는 실제 수집기와 Bash 실패 경로를 사용하며 Docker 프로세스만 대역이다. 소유권 누락/불일치, 제한 시간, 비정상 JSON, 인자 없는 stack, synthetic secret 미노출, 진단 실패 후 cleanup 순서, 후속 mutation 차단을 확인한다. 실제 signal guard는 가상 PID/proc 읽기와 kill을 대역으로 하여 `docker-init`과 `dockerd`를 구분하는지 별도 실행한다. 실제 Docker daemon 복구를 증명하는 테스트는 아니다.

기존 `validate`는 `*-test.py`를 동적으로 실행하므로 새 `recovery-stack-test.py`도 workflow 변경 없이 PR gate에 포함된다. heavy recovery-v2는 기존 main push 경로 필터 또는 명시적인 수동 실행만 사용한다. `recovery-diagnostics.py` 변경은 기존 main push 필터에 해당하므로 병합 시 heavy 실행이 자동 발생할 수 있다. 이 작업은 별도 수동 실행이나 반복 재실행을 추가하지 않는다. artifact가 비어 있으면 업로드 성공으로 처리하지 않는다.

## 다음 실환경 판정

파서 수정은 quorum 없는 unlock의 readiness 대기를 해결하지 않는다. 다음 복구 작업은 기존 node-ready/leader 대기의 최소 재현과 안전한 복구 경로 검증으로 제한한다. 새로운 실환경 진단이 생기면 수정된 파서의 개별 스택을 실제 소스와 대조하고, `partial` 또는 제외된 프레임은 추정으로 채우지 않는다. 같은 원인의 반복 push/재실행을 개발 루프로 사용하지 않는다.

잠금/잘못된 키 거절, 올바른 키 복원, root CA 보존, 키 회전 후 검증과 fresh worker join까지 실제로 통과한 run만 ROADMAP 완료 근거가 된다. 전체 암호화 복구와 recovery runbook은 **미완료**다. merge 후 새로 확인된 run 결과는 PR 체크포인트에 기록하고, 다음 작업에서 ROADMAP과 이 문서에 먼저 동기화한다.

## 참고 자료

- [Docker daemon 로그 및 SIGUSR1 stack](https://docs.docker.com/engine/daemon/logs/)
- [Docker DinD entrypoint](https://github.com/docker-library/docker/blob/master/dockerd-entrypoint.sh)
- [Docker Swarm backup/restore](https://docs.docker.com/engine/swarm/admin_guide/)
- [Docker Swarm autolock](https://docs.docker.com/engine/swarm/swarm_manager_locking/)
- [SwarmKit key encoding](https://github.com/moby/swarmkit/blob/1fd637ba5cc32ff30d1dd2bdb14997bd4f424b46/manager/encryption/encryption.go)

- [Go runtime goroutine 헤더 형식](https://go.dev/src/runtime/traceback.go)
- [Go runtime 대기 상태 문자열](https://go.dev/src/runtime/runtime2.go)
