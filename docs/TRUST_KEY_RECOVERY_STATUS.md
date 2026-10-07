# Swarm 암호화 복구 검증 상태

## 현재 구현과 판정

단일 cold backup의 정상 키 unlock이 기존 quorum을 기다리던 문제를 해결하기 위해, 정지된 복원 사본에서 동일 Engine의 vendored SwarmKit에 UnlockKey와 ForceNewCluster를 함께 전달하는 경로를 추가했다. 기존 manager 복귀 없이 실행하며, 외부 네트워크와 task 실행을 차단한 helper가 끝난 뒤 정상 Docker API로 잠금/키/CA/worker 검증을 수행한다. 상세 절차와 제한은 [단일 백업 복구 절차](COLD_BACKUP_RECOVERY.md)를 참조한다.

PR #109 이후 [recovery-v2 #37542402155](https://github.com/KimHG1995/Docklane/actions/runs/37542402155)가 성공했다. 원래 manager 세 ID의 부재, 단일 암호화 백업의 quorum 재구성, 원래 키 unlock/cluster ID/root CA/leader, 키 회전과 재시작 후 이전 키 거절/새 키 승인, fresh worker Ready/동일 CA 및 cleanup이 통과했다. [PR #109 체크포인트](https://github.com/KimHG1995/Docklane/pull/109#issuecomment-6026899132)와 artifact 11449092312의 최종 summary를 근거로 Engine 28.5.2/disposable Linux-DinD 신뢰 복구 및 버전 한정 runbook을 완료했다. ZIP SHA256은 3a2f1b4d4d7da123e7018770e0204568788546918206ddc2c2c567f28997df28이다. 이후 수정의 실제 검증 결과는 해당 PR 체크포인트에 기록한다.

## 기존 증거

이전 복구 순서의 실행 [#37406102027](https://github.com/KimHG1995/Docklane/actions/runs/37406102027)은 main@72a860e에서 정상 키 restore-unlock 30초/exit137로 실패했다. 원본 manager의 정상 unlock, 복원 manager locked 및 wrong-key rejection은 통과했지만 force-new-cluster/키 회전/fresh worker 가입에는 도달하지 못했다. OOMKilled=false였으며 별도 UnlockSwarm(swarm.go:350), WaitForLeader(util.go:52)/Manager.Run(manager.go:609) 스택이 수집됐다. Exit137만으로 OOM이나 복구 불가능을 뜻하지 않는다.

Artifact11386897386의 ZIP SHA256은 c283b3f8f9bd5f72734628940341ba2515d378283d73d4d8bb14c30b9d61e81c다. 더 오래된 #37396470008/#37385891177도 실패, #36984088600은 cancelled다. PR #100 이전 파서의 합쳐진 goroutine 요약은 단일 호출 경로로 해석하지 않는다.

PR #104~#106 대조 실험에서 workflow context와 info 지연에 의한 진단 유실을 보완했다. #37422751815는 상태 unknown으로 실패했지만 62개 스택 요약을 보존했다. Info는 cluster/nodes RPC를 포함하므로 로컬 준비 상태의 즉시 응답을 보장하지 않는다. 상세 이력은 [quorum 대조 실험](UNLOCK_QUORUM_PROBE.md)에 남아 있다.

PR #107의 [#37428339620](https://github.com/KimHG1995/Docklane/actions/runs/37428339620)은 HEAD /_ping의 실제 pending과 별도 대기 스택을 확인하고, 아직 살아 있는 동일 unlock에서 원래 peer를 복귀시켜 성공했다. main validation #37428339641과 운영 회귀 100개도 통과했다. 3.148초는 사전 대기 3초를 포함한 해당 요청 전체 시간이다. 이 실험은 원래 peer 메모리/상태를 보존했으므로 single_backup_acceptance=false다.

PR #108은 생성 intent+실행별 label 및 exact-ID not-found 처리로 cleanup 응답 유실 두 건을 수정했다. PR validation #37436106395(운영 회귀117개), main validation #37436689720과 [실제 대조 실험 #37436689688](https://github.com/KimHG1995/Docklane/actions/runs/37436689688)이 성공했다. Artifact11398884567의 ZIP SHA256은 05e8b650a1908f7d7042fe68eb569e530d5892bc2975a0c3bc8fd9ca2db04de5다. 새 cleanup 계약은 [소유권 및 재시도](QUORUM_PROBE_CLEANUP.md)에 정리했다.

PR #110은 사전 검사 거부 시 이전 실행 리소스를 자동으로 정리하지 않도록 수정했다. 현재 생성 실행의 식별자와 host 조건을 확인하고 이전 기록은 명시적 cleanup-only로 분리한다. PR validate #37548732617의 전체 운영 회귀 142개, main validate #37549139813과 실제 quorum probe #37549137498이 성공했다. 거부 경로의 무삭제 조건은 Docker 대역 회귀에서, 실제 실행은 정상 생성/정리와 대조 실험의 호환성으로 검증한다.

## 변경한 복구 경로

Docker UnlockSwarm이 제어 잠금을 보유한 채 readiness를 기다리고 Init도 같은 잠금을 사용하는 점을 피한다. 올바른 키의 restore-unlock을 전송하기 전에 복원 Docker를 중지하고, 격리된 사본에서 upstream node.Config의 두 옵션을 같은 startup에 적용한다. 기존 timeout 이후에 다른 mutation을 겹쳐 보내는 방식이 아니다.

원래 manager 세 ID의 명시적 부재, 복원 ID/이름/소유권, stopped 상태와 private PID를 확인한다. Key는 stdin으로 전달하고, helper는 백업 CA fingerprint/필수 파일/정규 key를 확인해 exclusive intent를 기록한다. 성공과 실패 모두 같은 사본의 helper 재호출을 거절한다. 정상 Docker 시작 후 여전히 잠겨 있음을 확인하고, 원래 키의 실제 승인 및 CA/cluster ID/leader를 검증한다.

Helper는 rebuild 및 CA 확인이 끝나면 기존 intent 파일에 비밀정보 없는 완료 JSON을 추가해 Sync/Close한 뒤 stdout에 출력한다. 출력 실패/부분 출력에도 이 파일을 삭제하지 않으므로 같은 사본의 두 번째 rebuild가 차단된다. 기록이 불완전하거나 성공 출력이 유실됐다고 marker를 지우거나 다음 복구 단계로 강제 진행하지 않는다. 기존 stdout JSON 필드와 wrapper의 실패 후 중단은 유지한다.

새 helper 성공은 그 단계의 성공이며 single_backup_acceptance=false다. 기존 Bash drill의 최종 summary는 키 회전, 재시작 후 old key 거절/new key 승인, fresh worker Ready 및 동일 CA까지 실제로 통과했을 때만 생성한다. 기존 peer의 일시 복귀로 이 조건을 대신하지 않는다.

## 안전 조건과 검증 범위

기존 unlock은 30초 제한이며, 실패 시 진단 후 중단하고 재전송하지 않는다. Offline helper는 별도의 명시적인 사전 단계로 Node startup30초/Stop5초/컨테이너40초 및 외부 제한을 둔다. 이 시간을 기존 unlock의 단순 timeout 증가로 사용하지 않는다. Original tar는 수정하지 않으며 암호화를 끄지 않는다.

원본/회전 키와 private backup은 artifact 밖에 유지한다. 공개 결과에는 제한된 phase, 상태, source IDs와 CA hash만 남긴다. 기존 진단 파서는 함수 인자와 원시 로그를 제외하고 goroutine별 경계를 유지한다. Collected/partial과 helper 완료는 전체 복구 성공이 아니다.

PR #109의 사전 검증은 Go 정책8개, Python 복원 격리/호출10개, 실제 Bash 순서와 workflow 정적 검증4개 및 기존 trust-key 회귀8개였다. Upstream 어댑터의 고정된 Moby vendor tree에 대한 test/vet/build #37442073432와 PR/main validation도 통과했다. 결과 전달 실패 수정에는 실패 Writer, 부분 출력, 출력 전 영속 기록, 정상 완료 뒤 재호출 및 출력 중 재진입 회귀5개를 추가해 Go 정책13개가 로컬 race test/vet와 함께 통과했다. 이는 실제 파일과 Writer의 검증이며 Swarm 실행은 아니다. 기존 validate 및 pinned vendor build, main recovery-v2는 별도 검증 단계다.

Helper는 애플리케이션 task 실행을 비활성화하고 이 drill에는 워크로드 복구가 없다. 따라서 성공해도 범용 프로덕션 워크로드/데이터 일관성 검증을 대신하지 않는다. 제품 Agent의 요청 도중 cluster 변경 사전조건 또한 별도 미완료 범위다.
