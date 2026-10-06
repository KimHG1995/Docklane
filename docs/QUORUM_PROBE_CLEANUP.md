# Quorum 대조 실험의 소유권과 cleanup

## 범위

`unlock-quorum-probe.py`의 생성/삭제 응답 유실을 처리한다. 제품 Agent 또는 기존 DB/Swarm/trust-key Bash harness 전체의 생성 소유권을 변경한 작업은 아니다. 대조 실험의 실제 pending 확인, 동일 unlock 요청, 30초 제한, 키와 cluster ID 검증 및 단일 백업 acceptance 분리는 그대로 유지한다.

## 생성 전 기록

첫 생성 전에 무작위 128비트 실행 ID와 리소스별 생성 의도를 `ownership-trust-key/creation.json`에 저장한다. 임시 파일을 fsync한 뒤 원자적으로 교체하고 부모 디렉터리도 fsync한다. 생성된 network/container에는 `io.docklane.quorum-probe.run`과 `io.docklane.quorum-probe.resource` label을 함께 부여한다. unlock key와 token은 이 기록에 포함하지 않는다.

성공 응답의 full ID는 journal을 먼저 갱신하고 기존 ID marker에도 저장한다. 따라서 생성 이후 marker 쓰기나 프로세스가 중단돼도 journal로 소유권을 복구할 수 있다. 생성 명령은 자동 재전송하지 않는다.

응답을 잃어 ID가 없는 경우 두 label로 후보를 조회한다. 후보가 정확히 하나일 때 full ID, 실제 이름과 두 label을 inspect로 다시 검증한다. Container는 private PID namespace도 확인한다. 이름만으로 삭제하거나 다른 실행의 리소스를 대신 정리하지 않는다.

**후보가 없다는 결과는 생성이 앞으로 완료되지 않는다는 증명이 아니다.** 결과가 불명확하면 생성 의도를 보존하고 cleanup은 실패한다. 이후 명시적인 cleanup 재시도에서 해당 label의 리소스를 발견하면 정리한다. 후보가 여러 개이거나 응답/소유권이 잘못된 경우도 실패한다.

## 삭제와 재시도

확인된 full ID로만 삭제한다. 성공한 삭제 또는 해당 ID에 대한 종료 코드 1의 정확한 `No such container/network` 응답만 정리 완료로 취급한다. 빈 stdout 또는 `[]`도 확인하며 임의 문자열의 `not found` 부분 일치는 사용하지 않는다.

삭제가 적용됐지만 응답만 유실되면 첫 cleanup은 실패하고 기록을 남긴다. 다음 cleanup에서 그 ID가 명시적으로 없음을 확인하면 기록을 제거하고 성공한다. 반대로 Docker 통신/권한 오류, timeout, 다른 ID, 잘못된 JSON과 label 불일치는 계속 기록을 보존한다.

기존 full-ID marker만 있는 실행도 지원한다. journal과 marker가 충돌하거나 기록이 손상/과대/심볼릭 링크이면 삭제를 실행하지 않는다. cleanup-only는 동일한 디스크 기록과 검증 경로를 사용한다. 모든 관련 리소스가 확인된 경우에만 빈 journal을 제거한다.

실패한 실험이 cleanup 성공만으로 성공으로 바뀌지 않는다. `cleanup_completed`는 cleanup의 결과이고 `single_backup_acceptance`는 계속 false다. journal은 기존 JSON 두 파일 artifact 허용 목록에 포함되지 않는다.

## 검증

```bash
python3 tests/operational-readiness/unlock-quorum-ownership-test.py
python3 tests/operational-readiness/unlock-quorum-probe-test.py
```

신규 17개 테스트는 실제 Python 오케스트레이션과 자식 Docker 대역을 실행한다. 대역은 생성/삭제 결과를 별도 상태 파일에 반영한 뒤 응답을 지연하며, 실제 subprocess timeout과 종료를 통해 응답 유실을 재현한다. 새 core 회귀 10개를 원본에 실행하면 12개 assertion/subtest 실패가 발생했고, 수정 후 확장된 17개와 기존 23개가 통과했다. 이는 실제 Docker의 장애 주입 acceptance를 수행했다는 뜻은 아니다.

주요 검증은 생성 응답 유실, 프로세스 재시작 후 cleanup-only, 늦게 완료된 생성, 다른 실행/이름 불일치 거절, 삭제 응답 유실 뒤 exact-ID not-found 성공, 통신/권한 오류 보존, marker 기록 실패와 journal 손상 거절이다.

Label 필터는 [Moby v28.5.2 MatchKVList](https://github.com/moby/moby/blob/v28.5.2/api/types/filters/parse.go)를 기준으로 하며, 조회 필터 자체만 신뢰하지 않고 반환 리소스를 다시 검증한다. 대조 실험의 이전 성공은 [run #37428339620](https://github.com/KimHG1995/Docklane/actions/runs/37428339620)이며 단일 암호화 백업 복구 결과와 구분한다.
