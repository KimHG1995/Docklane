# 단일 암호화 Swarm 백업 복구 절차

## 적용 범위와 현재 상태

이 절차는 Docklane의 폐기 가능한 Linux/DinD 검증 환경, Docker Engine 28.5.2와 동일 버전의 SwarmKit에 한정한다. 원래 manager 세 대가 모두 제거된 뒤 하나의 cold backup과 해당 unlock key로 신뢰 도메인을 복원하는 실험이다. 일반 운영 호스트에서 직접 실행하는 범용 복구 도구가 아니며 제품 API에 자동 복구 명령을 추가하지 않는다.

이번 변경의 실제 acceptance는 병합 후 `operational-readiness-recovery-v2` 실행으로 판정한다. 구현, helper 빌드 또는 quorum pause/unpause 성공만으로 완료 처리하지 않는다. 최신 성공/실패 실행은 이 변경 PR의 체크포인트를 확인한다. Root CA, cluster ID, 키 회전 및 fresh worker 가입이 모두 통과해야 전체 신뢰 복구 완료다.

## 기존 교착 경로와 새 방식

Engine 28.5.2의 `UnlockSwarm`은 제어 잠금을 잡은 채 node readiness를 기다린다. 기존 manager가 모두 사라져 leader를 선출할 수 없으면, 그 요청 뒤의 Docker `swarm init --force-new-cluster`에는 도달하지 못한다. CLI 종료 뒤 같은 요청을 다시 보내거나 병렬 init으로 이 잠금을 우회하지 않는다.

이번에는 올바른 키의 restore-unlock을 보내기 **전**, 잠긴 복원 Docker를 중지한다. 해당 Docker의 vendored SwarmKit `node.Config`가 제공하는 `UnlockKey`와 `ForceNewCluster`를 한 번의 node startup에 함께 전달한다. 새 CA를 생성하거나 암호화를 끄거나 Raft 파일 형식을 직접 수정하지 않는다. Node readiness 후 정상 Stop/flush가 완료돼야 다음 단계로 진행한다.

Helper는 Moby `89c5e8fd66634b6128fc4c0e6f1236e2540e46e0`의 vendor tree에 대해 빌드한다. 임의 최신 SwarmKit이나 설치된 다른 버전을 사용하지 않는다. 미리 빌드한 정적 바이너리를 새 도구 컨테이너에 읽기 전용으로 마운트하며, 컨테이너는 network=none, read-only root, cap-drop=ALL이고 복원 사본의 볼륨만 쓰기 가능하다. 원래 manager 이름을 도구에 재사용할 수 있지만 ID는 새 값이며 원래 manager나 메모리/네트워크를 복귀시키지 않는다.

Helper의 task executor는 비활성화하고 노드 availability는 Pause로 시작한다. 이 테스트의 백업에는 애플리케이션 서비스/볼륨 복구 시나리오가 없으므로, 일반 워크로드 재실행이나 데이터 일관성까지 검증한 결과로 확대하지 않는다. 실제 운영 채택 전 해당 환경의 워크로드, 버전, 장애 격리와 백업 보관 정책을 별도로 검증해야 한다.

## 실행 전 확인

원본 백업 tar와 key는 artifact 디렉터리 밖의 private 경로에 둔다. 원본 tar는 수정하지 않고 별도 복원 볼륨에서만 작업한다. Root CA SHA-256은 백업 생성 시 확보한 값이어야 한다.

`offline-quorum-rebuild.py`는 다음 조건을 모두 확인한다. 기록된 원래 manager full ID가 정확히 세 개이고, Docker의 명시적인 not-found로 모두 부재여야 한다. 복원 컨테이너는 ID/이름/소유권 marker가 일치하고 Running/Paused/Restarting/Dead가 모두 false이며 private PID namespace여야 한다. Docker context override 및 원격 endpoint는 거절한다. 통신 오류를 부재로 처리하지 않는다.

Go helper는 명시적인 disposable-copy opt-in, clean absolute state path, 필수 certificate/key/docker-state.json 및 기존 Raft 디렉터리, 예상 CA fingerprint와 정규 인코딩된 32바이트 unlock key를 확인한다. 경로의 symlink와 누락된 백업을 거절한다. 작업 전 exclusive intent를 영속화하고 불명확한 실패에는 intent를 남긴다. 같은 사본을 자동 재시도하지 않는다.

## 실제 drill 순서

1. Autolock을 켠 manager 3개를 구성하고 follower를 정지해 cold backup을 생성한다. 원본 follower 재시작이 locked이고 기존 키로 정상 해제됨을 확인한다.
2. 원래 세 manager의 전체 ID와 source cluster ID/CA fingerprint를 기록한 뒤 manager 컨테이너와 원본 볼륨을 모두 제거한다. 이후에는 cold backup 하나만 복원 데이터로 사용한다.
3. 같은 hostname/IP의 새 복원 컨테이너에 tar를 복원한다. Docker를 시작해 locked와 잘못된 키의 명시적인 거절을 확인한 뒤 다시 정지한다.
4. 올바른 키를 stdin으로만 전달해 격리된 offline helper를 한 번 실행한다. 생성/삭제 응답 유실은 PR #108의 label+intent 소유권 관리로 처리한다. 도구 실패 또는 cleanup 실패면 Docker를 재시작하지 않는다.
5. Helper가 정상 종료하고 CA가 보존됐으면 Docker를 다시 시작한다. 여전히 locked임을 확인한 후 원래 키로 정상 Docker unlock을 한 번 실행한다. 기존 30초 제한과 실패 후 재전송 금지는 유지한다.
6. 원래 cluster ID와 root CA가 같고 복원 manager가 실제 leader인지 검증한다. 단순 ControlAvailable 플래그만으로 성공하지 않는다.
7. Unlock key를 회전하고 Docker를 재시작한다. Locked, 이전 key 거절, 새 key 승인과 준비 상태를 차례로 확인한다.
8. 새로운 worker를 생성해 새로 발급받은 worker join token으로 가입시킨다. Manager 측 canonical worker ID가 Ready/worker이고 root CA가 백업과 일치해야 한다.
9. 위 검증을 모두 통과한 경우에만 최종 summary를 작성한다. 소유 리소스와 private 백업을 정리하고 sanitized 증거만 업로드한다.

## 빌드 및 실행

전용 disposable 환경에서 기존 workflow를 사용하는 경로가 기준이다. 로컬 실행은 동일한 source checkout과 architecture가 필요하다.

```bash
bash scripts/build-cold-recovery.sh \
  /absolute/build/src/github.com/docker/docker \
  /absolute/bin/docklane-cold-recovery

DOCKLANE_OR_DISPOSABLE_HOST=1 \
DOCKLANE_OR_COLD_HELPER=/absolute/bin/docklane-cold-recovery \
DOCKLANE_OR_LOG_DIR=/tmp/docklane-operational-readiness \
DOCKLANE_OR_PRIVATE_BACKUP_DIR=/tmp/docklane-private-recovery \
bash tests/operational-readiness/trust-key-restore-v2.sh
```

키를 CLI argument, 환경변수, 로그 또는 PR 댓글에 넣지 않는다. 위 drill 내부에서 key는 private 파일/메모리와 stdin 경로로 전달한다. Helper의 원시 로그는 업로드하지 않으며 고정된 phase 이름과 결과만 기록한다. 이 제한은 전체 저장소의 모든 artifact를 보안 감사했다는 뜻은 아니다.

## 중단과 재시도

원래 manager가 하나라도 존재하거나 복원 Docker가 실행 중이거나 증거/키/CA가 맞지 않으면 즉시 중단한다. Offline helper timeout/비정상 종료/CA 변경에는 working copy를 신뢰하지 말고 원본 백업을 보존한다. Intent를 삭제해 같은 사본을 강제로 재사용하지 않는다. 전용 환경을 정리한 뒤 원본 tar에서 새로운 복원 사본을 만드는 것은 별도의 명시적인 새 drill이다.

정리만 재시도할 때는 `offline-quorum-rebuild.py --cleanup-only`를 사용한다. Label/ID 검증에 실패하면 ownership을 보존한다. 종료된 unlock의 자동 재전송, autolock=false, 기존 manager 복귀로 단일 백업 조건 대체, 실패를 무시한 worker 가입은 금지한다.

## 근거

- [Moby 28.5.2 UnlockSwarm/Init](https://github.com/moby/moby/blob/v28.5.2/daemon/cluster/swarm.go)
- [같은 Engine의 vendored node.Config 및 Node lifecycle](https://github.com/moby/moby/blob/v28.5.2/vendor/github.com/moby/swarmkit/v2/node/node.go)
- [SwarmKit force-new-cluster와 DEK manager 연결](https://github.com/moby/moby/blob/v28.5.2/vendor/github.com/moby/swarmkit/v2/manager/manager.go)
- [Docker 백업과 quorum 복구 운영 가이드](https://docs.docker.com/engine/swarm/admin_guide/)
