# Swarm 암호화 복구 검증 상태

## 기준과 실제 실패

기준 소스는 `main@5be09fffb48e420933185287300f4ec3ecca4bc4`다.
[recovery-v2 run #37385891177](https://github.com/KimHG1995/Docklane/actions/runs/37385891177)은 **failure**다. 원본 manager 정상 키 unlock, 복원 manager의 locked 상태, 잘못된 키 거절은 통과했다. 모든 원본 manager가 사라진 뒤 복원 manager의 `restore-unlock`은 30초 제한에서 종료 코드 137로 중단됐다. 후속 `force-new-cluster`는 실행하지 않았다. 137만으로 OOM을 단정하지 않는다.

이전 [run #36984088600](https://github.com/KimHG1995/Docklane/actions/runs/36984088600)은 cancelled이며 성공 근거가 아니다. 일반 Swarm 복구에서 확인한 manager 주소 불일치는 별도 실행의 증거다. 암호화 복구의 daemon 내부 원인을 그 자료로 확정하지 않는다.

이번 작업은 **진단 및 사전 검증 보강**이다. 제품 API/Agent, 원본 `trust-key-restore.sh`, 기존 cleanup, unlock 제한 시간과 복구 순서는 바꾸지 않는다. Autolock을 끄거나 실패를 무시하여 acceptance를 통과시키지 않는다.

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

## 로컬 및 PR 검증

```bash
bash -n tests/operational-readiness/trust-key-restore-v2.sh
python3 tests/operational-readiness/trust-key-restore-test.py
python3 tests/operational-readiness/recovery-diagnostics-test.py
```

기존 하네스 회귀 8개와 새 진단 회귀 13개를 실행한다. 새 회귀는 실제 수집기와 Bash 실패 경로를 사용하며 Docker 프로세스만 대역이다. 소유권 누락/불일치, 제한 시간, 비정상 JSON, 인자 없는 stack, synthetic secret 미노출, 진단 실패 후 cleanup 순서, 후속 mutation 차단을 확인한다. 실제 signal guard는 가상 PID/proc 읽기와 kill을 대역으로 하여 `docker-init`과 `dockerd`를 구분하는지 별도 실행한다. 실제 Docker daemon 복구를 증명하는 테스트는 아니다.

기존 `validate`는 `*-test.py`를 동적으로 실행하므로 새 테스트도 PR gate에 포함된다. heavy recovery-v2는 계속 main push 또는 명시적인 수동 실행만 사용한다. 변경된 helper/test도 해당 workflow의 경로 필터에 포함한다. artifact가 비어 있으면 업로드 성공으로 처리하지 않는다.

## 다음 실환경 판정

이번 변경 후 main의 실제 실행은 한 번 확인한다. 실패하면 수집된 stack의 `UnlockSwarm`, node readiness, mutex/dispatcher/Raft 대기를 실제 소스와 대조한다. `partial`이면 없는 자료를 추정하여 채우지 않는다. 같은 원인의 반복 push/재실행 대신 최소 재현과 진단 근거를 먼저 검토한다.

잠금/잘못된 키 거절, 올바른 키 복원, root CA 보존, 키 회전 후 검증과 fresh worker join까지 실제로 통과한 run만 ROADMAP 완료 근거가 된다. 전체 암호화 복구와 recovery runbook은 **미완료**다. merge 후 새로 확인된 run 결과는 PR 체크포인트에 기록하고, 다음 작업에서 ROADMAP과 이 문서에 먼저 동기화한다.

## 참고 자료

- [Docker daemon 로그 및 SIGUSR1 stack](https://docs.docker.com/engine/daemon/logs/)
- [Docker DinD entrypoint](https://github.com/docker-library/docker/blob/master/dockerd-entrypoint.sh)
- [Docker Swarm backup/restore](https://docs.docker.com/engine/swarm/admin_guide/)
- [Docker Swarm autolock](https://docs.docker.com/engine/swarm/swarm_manager_locking/)
- [SwarmKit key encoding](https://github.com/moby/swarmkit/blob/1fd637ba5cc32ff30d1dd2bdb14997bd4f424b46/manager/encryption/encryption.go)
