# 정상 키 unlock과 quorum 대조 실험

## 목적과 판정 범위

이 실험은 백업 복사, 새 manager 주소, 잘못된 키 변수를 제외하고 정상 키 unlock의 준비 대기가 quorum 가용성에 의존하는지 확인한다. `recovery-v2`의 단일 암호화 백업 복구를 다른 시나리오로 대체하지 않는다. 성공하더라도 `single_backup_acceptance=false`다.

기준은 `main@a038b2a9b7de1da00add414f50f6375d5ef126c7`이다. 기존 [복구 run #37406102027](https://github.com/KimHG1995/Docklane/actions/runs/37406102027)의 artifact `11386897386`은 Engine 28.5.2 / API 1.51, `pending`, `ControlAvailable=true`, `OOMKilled=false`와 별도 `UnlockSwarm` / `raft.WaitForLeader` 스택을 기록했다. ZIP SHA256은 `c283b3f8f9bd5f72734628940341ba2515d378283d73d4d8bb14c30b9d61e81c`이다.

## 소스 대조

[Moby v28.5.2 UnlockSwarm](https://github.com/moby/moby/blob/v28.5.2/daemon/cluster/swarm.go#L291-L358)은 `controlMutex`를 잡고 정상 키로 node runner를 시작한 뒤 `nr.Ready()`를 기다린다. 이 함수에는 호출자의 취소 context나 준비 대기 timeout이 없다. [Init](https://github.com/moby/moby/blob/v28.5.2/daemon/cluster/swarm.go#L28-L49)도 같은 mutex를 사용한다. CLI만 종료하거나 force-new-cluster를 병렬 전송하는 것은 이 대기의 검증된 해결책이 아니다.

[nodeRunner.Ready](https://github.com/moby/moby/blob/v28.5.2/daemon/cluster/noderunner.go#L77-L101)는 ready 또는 node 종료를 기다린다. [SwarmKit Manager.Run](https://github.com/moby/moby/blob/v28.5.2/vendor/github.com/moby/swarmkit/v2/manager/manager.go#L580-L619)에는 Raft leader 대기가 있다. `ControlAvailable=true`만으로 전체 준비 완료를 판정하거나 종료 코드 137만으로 OOM을 단정하지 않는다.

## 대조 순서

1. 명시적인 disposable opt-in이 있는 Linux host에서만 실행한다. 원격 Docker endpoint와 `DOCKER_CONTEXT` override, 이미 Swarm에 가입한 outer host, 같은 이름의 기존 리소스 또는 남은 ownership이 있으면 시작하지 않는다.
2. 기존 실패와 같은 image digest로 독립적인 manager 3개를 만들고 autolock을 켠다. 내부 Engine이 28.5.2인지 확인한다.
3. follower 하나를 재시작해 locked 상태를 확인한다. 나머지 manager가 살아 있는 조건에서 정상 키 unlock과 3-manager 준비 수렴을 확인한다.
4. 나머지 두 manager를 pause한다. 같은 follower를 다시 재시작하고 locked 상태를 확인한다. 백업 복사와 주소 교체는 없다.
5. 정상 키 unlock을 한 번만 보낸다. DinD 내부 30초 제한과 외부 프로세스 제한을 적용한다. 대기 중인 프로세스, pending 상태와 서로 분리된 unlock/leader 대기 스택을 확인한다.
6. 같은 요청이 아직 살아 있고 예산이 충분할 때만 기존 두 peer를 unpause한다. 같은 unlock 요청의 정상 종료, 3-manager 수렴, 원래 cluster ID와 unlock key 보존을 확인한다.
7. 기록된 full container/network ID만 정리한다. 불확실한 inspect 또는 삭제 실패에서는 ownership을 남겨 workflow의 always-cleanup 단계에서 재시도한다.

진단이 불완전하거나 요청이 이미 끝났거나 예산이 부족하면 peer 재개를 실행하지 않는다. 재개 후 unlock이 실패하거나 timeout이면 실험 전체가 실패한다. 종료된 unlock 재전송, force-new-cluster, autolock 해제, Raft 파일 수정은 없다. 실패 후 리소스 삭제는 disposable 환경 정리이며 복구 계속 진행이 아니다.

## 실행과 증거

폐기 가능한 전용 환경에서만 실행한다.

```bash
DOCKLANE_OR_DISPOSABLE_HOST=1 \
DOCKLANE_OR_LOG_DIR=/tmp/docklane-unlock-quorum-probe \
python3 tests/operational-readiness/unlock-quorum-probe.py
```

실제 실행은 `operational-readiness-unlock-quorum`의 main push 또는 수동 실행이다. PR에서는 기존 validate의 빠른 Python 회귀만 실행한다. 원래 recovery-v2와 legacy v1 workflow는 바꾸지 않는다. 문서 변경만으로 heavy 실험을 재실행하지 않는다.

업로드 대상은 `unlock-quorum-probe.json`과 `unlock-quorum-pending.json` 두 파일뿐이다. 명령 stdout/stderr는 익명 임시 파일에서 받고 원시 스택은 기존 정규화기로 해석한다. 공개 JSON은 판정 boolean, 제한된 상태, image/version, 경과 시간, 안전한 오류 분류와 cleanup 결과로 제한한다. Unlock key는 stdin으로 전달하며 key, join token, 개인키, 임의 daemon 오류와 함수 인자를 업로드하지 않는다. 이는 모든 기존 artifact의 일반적인 비밀정보 감사 완료를 뜻하지 않는다.

`--cleanup-only`도 disposable opt-in과 local Unix Docker endpoint를 확인한다. 알 수 없는 소유권이나 원격 context로 정리 명령을 보내지 않는다. 이 실험은 외부에서 동시에 자원을 변경하지 않는 전용 runner를 전제로 한다.

## 운영 판단과 남은 검증

[Docker 운영 가이드](https://docs.docker.com/engine/swarm/admin_guide/#recover-from-losing-the-quorum)는 실패한 원래 manager를 되살려 quorum을 확보하는 경로를 우선 제시한다. 이 실험은 그중 peer의 프로세스와 키가 메모리에 유지된 pause/unpause 조건만 다룬다. 모든 manager가 재시작돼 잠긴 조건이나 독립 백업 여러 개를 복원하는 조건까지 확대 해석하지 않는다.

`quorum-restored-same-unlock`은 기존 peer를 되살릴 수 있을 때 같은 unlock이 완료된 대조 실험 결과다. 원래 manager 상태를 모두 잃은 상황, 단일 cold backup의 force-new-cluster, root CA 복원, 키 회전, fresh worker join을 검증한 결과가 아니다. 예상 대기가 재현되지 않으면 성공으로 숨기지 않고 조사 대상으로 남긴다.

이미 운영 unlock timeout이 발생한 상태에서 이 실험을 후속 복구 명령으로 실행하지 않는다. 해당 daemon 상태를 보존해 분석하고 확인되지 않은 재전송을 중단한다. 단일 암호화 백업 재해 복구 경로와 완전한 recovery runbook은 계속 별도 검증 대상이다.
