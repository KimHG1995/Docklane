# 클러스터 등록 1단계: 불변 등록 정보와 감사 기록

## 범위

현재 single-cluster MVP의 논리 ID와 실제 Swarm ID를 명시적으로 연결하는 관리자 API다. 운영자가 이미 고정한 `DOCKLANE_EXPECTED_CLUSTER_ID`와 현재 manager Agent의 identity가 일치해야 새 등록을 저장한다. 임의 endpoint나 인증서, key, join token을 요청 본문으로 받지 않는다. Docker를 생성/가입/변경하지 않으며 기존 Agent의 identity 조회만 사용한다.

이번 단계는 등록/조회, 중복 방지, 감사와 DB migration까지다. **기존 조회/배포/노드 변경/재시작 reconciliation의 실행 권한을 이 등록 테이블로 전환하지 않는다.** 따라서 등록이 없거나 등록 정보가 설정과 달라도 기존 runtime은 기존 환경 pin과 Agent guard 계약을 따른다. `matchesConfiguration=false`를 새 runtime 차단으로 해석하면 안 된다. 모든 운영 경로의 등록 필수화, 기존 데이터의 명시적 이관 및 multi-instance 일관성은 다음 별도 작업이며 ROADMAP의 전체 cluster registration은 미완료로 유지한다.

## API

두 경로 모두 기존 Bearer 인증과 `ADMIN`, URL의 cluster 범위 권한을 요구한다. 서비스 계층도 같은 역할과 범위를 확인한다. wildcard 권한이 있어도 현재 프로세스의 `DOCKLANE_CLUSTER_ID` 외의 cluster는 등록하거나 조회하지 못한다.

### PUT /v1/clusters/:clusterId/registration

최초 생성과 동일 요청 재호출 모두 `200`을 반환한다.

```json
{
  "swarmClusterId": "operator-verified-swarm-id",
  "displayName": "공공 운영"
}
```

`swarmClusterId`와 논리 경로 ID는 길이 1~128의 영문/숫자/underscore/hyphen이다. displayName은 1~128자이며 앞뒤 공백과 제어 문자를 거절한다. 값을 trim하거나 원격 응답으로 대체하지 않는다. Zod strict object로 미지원 필드도 거절한다.

처리 순서는 권한/논리 범위, 요청 검증, 명시적 환경 pin 일치, 기존 등록 확인, 현재 manager identity 확인, 등록+감사 트랜잭션이다. Insecure 개발 모드라도 영속 등록에는 명시적 expected ID가 필요하다. 등록을 위해 처음 관찰한 cluster를 기준값으로 자동 저장하지 않는다.

응답에는 `id`, `clusterId`, `swarmClusterId`, `displayName`, `registeredBy`, `verifiedNodeId`, UTC `createdAt`만 포함한다. verifiedNodeId는 최초 등록 당시 확인한 manager이며, failover의 고정 대상으로 사용하거나 계속 같은 node여야 한다고 해석하지 않는다.

같은 논리 ID/Swarm ID/이름의 재호출은 기존 결과를 반환하고 새 감사 이벤트를 만들지 않는다. Agent가 현재 불통이어도 이미 저장된 결과를 반환할 수 있으므로 **이 응답은 새 live verification이 아니다.** 최초 등록자와 당시 확인한 node도 그대로 보존한다. Swarm ID 또는 표시 이름을 바꾸는 덮어쓰기는 409이며 update/delete/rebind API는 제공하지 않는다.

### GET /v1/clusters/:clusterId/registration

저장된 정보를 반환하며 Agent를 호출하지 않는다. 미등록은 404다.

```json
{
  "registration": {
    "id": "generated-uuid",
    "clusterId": "default",
    "swarmClusterId": "operator-verified-swarm-id",
    "displayName": "공공 운영",
    "registeredBy": "admin-id",
    "verifiedNodeId": "manager-node-id",
    "createdAt": "2026-10-08T00:00:00.000Z"
  },
  "configuredSwarmClusterId": "operator-verified-swarm-id",
  "matchesConfiguration": true
}
```

`matchesConfiguration`은 저장된 ID와 현재 프로세스에 고정된 설정 문자열의 비교다. health, 실제 Agent의 현재 cluster, quorum, manager 준비 상태 또는 변경 성공 여부가 아니다. 설정 drift 시에도 관리자가 기존 값을 확인할 수 있도록 저장 정보를 반환한다. 생략된 개발 설정에서는 configuredSwarmClusterId가 null이며 matchesConfiguration은 false다.

## 영속화 및 불확실성

3번 migration은 `cluster_registrations`만 추가한다. 기존 1/2번 migration과 서명은 변경하지 않고, 기존 deployment target이나 operation을 자동 등록/재바인딩하지 않는다. 논리 ID는 PK, 실제 Swarm ID와 등록 UUID는 UNIQUE다. 두 식별자에는 ascii_bin collation을 명시한다.

새 등록과 `CLUSTER_REGISTERED` 감사는 같은 InnoDB 트랜잭션으로 저장한다. 감사의 operation_id는 등록 UUID이며 resource_type은 cluster다. endpoint나 인증 정보가 아니라 반환되는 등록 metadata만 감사 snapshot에 남긴다.

동시 INSERT의 정확한 ER_DUP_ENTRY/1062에 대해서만 전체 트랜잭션을 rollback한 뒤 저장된 결과를 다시 읽는다. 같은 불변 metadata면 기존 결과를 반환하고, 다른 metadata 또는 다른 alias에 바인딩된 Swarm이면 409다. INSERT IGNORE나 ON DUPLICATE KEY UPDATE로 정보를 덮어쓰지 않는다. audit/commit 실패를 INSERT 중복으로 오인하지 않으며, 일반 DB 오류와 timeout을 성공으로 바꾸거나 INSERT를 자동 재전송하지 않는다. commit 응답이 유실됐을 때는 명시적인 같은 PUT 재호출이 저장된 결과를 확인할 수 있다.

등록 행 변경과 임의 삭제는 운영 절차로 제공하지 않는다. 잘못된 등록의 교체는 기존 workload, audit, 권한과 runtime binding의 처리 정책을 포함한 별도 변경이다.

## 적용과 검증

정상 manager의 실제 ID를 신뢰 가능한 경로로 확인해 환경 설정에 먼저 고정한 뒤 scoped ADMIN으로 PUT을 호출한다. 등록 API가 환경 pin을 대신하지 않는다. DB schema version 3 적용 후 version 2까지만 아는 과거 binary는 기존 migration 정책에 따라 시작을 거절하므로, 업그레이드 전 백업과 binary/schema rollback 계획을 준비해야 한다. 자동 downgrade나 migration 기록 삭제로 이전 버전을 강제 실행하지 않는다.

서비스/저장소 회귀는 실제 구현에 Agent와 DB/트랜잭션 대역을 연결한다. Controller 회귀는 실제 Zod schema와 기존 AuthGuard/metadata를 사용한다. 기존 MySQL migration PoC 안에서 실제 repository의 동시 등록, 하나의 감사, 재조회, 서로 다른 바인딩 거절과 서버 측 audit 오류의 rollback을 검증한다. 새로운 workflow나 Docker topology는 추가하지 않는다. 실제 실행 결과는 PR 체크포인트에서 확인하며, 이 검증을 전체 Swarm 등록/배포 acceptance라고 부르지 않는다.

## 참고

- [Agent 운영 pin과 사전조건](AGENT_MUTATION_PRECONDITION.md)
- [Agent 거절과 불확실성](AGENT_REJECTION_HANDLING.md)
- [MySQL 8.4 unique constraints](https://dev.mysql.com/doc/refman/8.4/en/constraint-primary-key.html)
- [MySQL 8.4 transaction rollback](https://dev.mysql.com/doc/refman/8.4/en/commit.html)
