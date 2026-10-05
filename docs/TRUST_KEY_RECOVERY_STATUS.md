# Swarm 암호화 복구 검증 상태

## 기준과 범위

기준 소스는 `main@5f8b010849baf6187848892e5dd682af327702f7`이다.
[recovery-v2 run #36984088600](https://github.com/KimHG1995/Docklane/actions/runs/36984088600)은 **cancelled**이며 acceptance 성공 근거가 아니다. 실행 로그의 마지막 시나리오 메시지는 `restoring encrypted state`다. 이 로그만으로 어느 Docker 명령에서 멈췄는지, daemon 내부 원인이 무엇인지 확정할 수 없다.

이번 변경은 `trust-key-restore-v2.sh`의 검증 정확성과 중단 동작을 보완한다. 제품 API/Agent 코드, 원본 `trust-key-restore.sh`, 기존 cleanup은 변경하지 않는다. Autolock을 끄거나 잠금 해제 실패를 무시해서 복구 성공으로 처리하지 않는다.

## 로컬에서 확인한 결함

- 잘못된 키를 만들 때 마지막 base64 문자만 바꾸면 문자열은 달라도 디코딩한 키가 같을 수 있다. 32바이트 synthetic fixture의 마지막 문자 `U`를 `X`로 바꾼 경우 동일한 바이트로 디코딩됐다. 새 방식은 첫 유효 base64 문자를 변경한다.
- 기존 locked/invalid-key 검증은 명령의 모든 실패를 기대한 거절로 받아들였다. 새 검증은 local state, 종료 코드, 구체적인 오류 메시지를 확인하며 타임아웃과 Docker 연결 오류는 실패로 처리한다.
- 기존 v2에도 시간 제한 없는 unlock 호출이 남아 있었다. 새 wrapper는 DinD 내부 CLI와 외부 `docker exec`를 모두 제한한다. 기본 내부 제한은 30초이며 `DOCKLANE_OR_RECOVERY_CALL_TIMEOUT_SECONDS`로 1~60초를 지정할 수 있다.

클라이언트 타임아웃은 daemon 측 작업 취소를 증명하지 않는다. unlock 타임아웃은 단계명과 종료 코드를 남기고 시나리오를 중단한다. 같은 unlock을 재전송하거나 이어서 `--force-new-cluster`를 호출하지 않는다.

## 검증 방법

```bash
bash -n tests/operational-readiness/trust-key-restore-v2.sh
python3 tests/operational-readiness/trust-key-restore-test.py
```

Python 회귀 테스트는 실제 Bash 함수와 negative-key 실행 블록을 읽어 실행한다. Docker 프로세스 경계만 대역으로 바꾸고 timeout은 실제 실행 파일을 사용한다. 테스트는 8개이며 base64 바이트 구분, locked/invalid-key의 정확한 판정, 무한 대기 제한, 재시도/후속 mutation 차단, 단계별 evidence, 새 helper의 키 미출력을 검증한다. 테스트에 사용하는 키는 synthetic 데이터다.

기존 소스에서는 17개 assertion/subtest가 실패했고, 수정 소스에서는 8개 테스트가 모두 통과했다. 이는 하네스 회귀 검증이지 실제 Docker Swarm 복구 acceptance가 아니다.

기존 `validate`의 Operational Readiness job에서도 `*-test.py`를 실행한다. heavy `recovery-v2` workflow는 기존처럼 main push 또는 수동 실행이며 PR sync마다 실행하지 않는다.

## 다음 acceptance 판정

다음 실제 실행에서 `source-unlock-status.txt`, `restore-unlock-status.txt`, `rotated-unlock-status.txt`와 단계별 오류를 확인한다. `status=started`만 남거나 `status=failed`이면 완료로 표시하지 않는다. 잠금/키 거절, 올바른 키 복원, root CA 보존, rotation 이후 검증, fresh worker join까지 실제로 통과한 run만 ROADMAP 완료 근거로 사용한다.

복구가 다시 실패하면 해당 단계와 실제 엔진 버전을 먼저 확인한다. 대기 시간을 반복해서 늘리거나, 보호 기능을 비활성화하거나, 단순 preflight green을 복구 완료로 간주하지 않는다. 전체 암호화 복구와 recovery runbook은 아직 미완료다.

## 참고 자료

- [Docker Swarm backup/restore](https://docs.docker.com/engine/swarm/admin_guide/)
- [Docker Swarm autolock](https://docs.docker.com/engine/swarm/swarm_manager_locking/)
- [SwarmKit key encoding](https://github.com/moby/swarmkit/blob/1fd637ba5cc32ff30d1dd2bdb14997bd4f424b46/manager/encryption/encryption.go)
