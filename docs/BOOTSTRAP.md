# Bootstrap

Docklane bootstrap은 기존 Docker/Swarm 운영 환경을 강제로 변경하지 않는 것을 기본 원칙으로 한다.

## Docker install / validate

`scripts/bootstrap-docker.sh`는 기본적으로 기존 Docker Engine을 검증한다.

```bash
bash scripts/bootstrap-docker.sh --validate
```

현재 지원 기준:

- Linux host
- Docker Engine 27.5 이상
- Docker Engine API 1.47 이상
- Docker daemon reachable
- Docker server OSType = linux

Docker Engine API는 client/server 버전 협상을 지원한다. Docklane은 현재 검증 기준을 Docker Engine 27.5 / API 1.47 이상으로 고정한다.

### 명시적 설치

Docker가 없는 Debian/Ubuntu host에서만 명시적으로 설치를 요청할 수 있다.

```bash
sudo bash scripts/bootstrap-docker.sh --install
```

동작 규칙:

- Docker가 이미 있으면 package install을 실행하지 않고 validate만 수행한다.
- Docker가 없을 때만 root를 요구한다.
- Debian/Ubuntu에서는 현재 설정된 OS package repository의 `docker.io`를 설치한다.
- 다른 distribution에서는 자동 설치를 중단하고 수동 설치 후 `--validate` 재실행을 요구한다.
- Swarm init/join은 이 단계에서 수행하지 않는다.
- native Swarm join token은 Docklane bootstrap token과 별도 lifecycle로 관리한다.

이 스크립트는 Docker daemon 설정, 기존 Swarm membership, 기존 workload를 자동 변경하지 않는다.


## Native Swarm join credential boundary

Docklane bootstrap token과 Docker native Swarm join token은 별도 credential이다.

Control Plane은 native join token을 `DOCKLANE_SWARM_JOIN_JSON`에서 읽으며 bootstrap DB에 저장하지 않는다.

```json
[
  {
    "clusterId": "default",
    "remoteAddr": "10.0.0.10:2377",
    "managerToken": "SWMTKN-1-...",
    "workerToken": "SWMTKN-1-..."
  }
]
```

동작:

1. ADMIN이 bootstrap token을 발급할 때 해당 cluster/role native credential 구성이 있는지 먼저 확인한다.
2. bootstrap client가 one-time token을 claim한다.
3. Control Plane은 bootstrap scope의 node role에 맞는 manager/worker join token만 응답한다.
4. native token 원문은 `bootstrap_tokens` 테이블에 저장하지 않는다.
5. bootstrap token은 claim 직후 사용 처리되지만 Docker native token의 rotation/lifetime에는 영향을 주지 않는다.

실제 `docker swarm join` 실행과 post-join verification은 다음 bootstrap 단계에서 처리한다.


## Retry / partial failure protocol

Bootstrap claim은 client가 생성한 UUID `claimId`를 요구한다.

```json
{
  "token": "docklane_bootstrap_...",
  "claimId": "11111111-1111-4111-8111-111111111111"
}
```

규칙:

- 최초 유효 claim은 bootstrap token에 `claimId`와 `usedAt`을 원자적으로 기록한다.
- 응답 유실이나 네트워크 중단 시 동일한 token + 동일한 `claimId` 요청은 같은 claim 결과를 replay한다.
- 동일 token을 다른 `claimId`로 재사용하면 거절한다.
- token expiry 이후에는 동일 `claimId`라도 replay하지 않는다.
- native Swarm join credential 설정이 누락된 경우 bootstrap token을 consume하기 전에 실패한다.
- 동시 claim은 DB row lock으로 직렬화하며 최초 claimId만 소유권을 획득한다.

응답의 `replayed` 필드로 최초 처리와 idempotent retry를 구분할 수 있다.


## Post-join node / role verification

Bootstrap client는 Docker join 직후 Control Plane에 실제 Swarm `nodeId`를 보고한다.

```http
POST /v1/bootstrap/complete
```

요청은 원래 bootstrap token, 동일한 `claimId`, join 결과의 `nodeId`를 포함한다.

Control Plane은 client 자기보고를 신뢰하지 않고 기존 manager Agent의 node inspect 결과로 다음 조건을 검증한다.

- node가 실제 Swarm에 존재
- `state=ready`
- `availability=active`
- 실제 role이 bootstrap scope의 `manager|worker`와 동일
- manager flag가 scope와 일치

검증이 실패하면 bootstrap completion은 성공으로 기록하지 않는다.


## Bootstrap label application

Bootstrap token에 labels가 지정된 경우 post-join role 검증이 끝난 뒤 기존 node mutation coordinator를 통해 labels를 적용한다.

규칙:

- bootstrap token ID를 node label operationId로 재사용해 completion retry를 idempotent하게 처리한다.
- 직접 Docker node update를 호출하지 않고 기존 CAS, node/service lock, affected-service placement 검증을 재사용한다.
- label mutation이 SUCCESS가 된 뒤 Agent로 node를 다시 조회해 요청한 label key/value를 실제 상태에서 확인한다.
- labels가 비어 있으면 node mutation을 만들지 않는다.
- completion 응답의 node.labels는 최종 Agent 관찰값이다.


## Bootstrap audit

Bootstrap lifecycle의 성공 경계를 `audit_events`에 기록한다.

기록 이벤트:

- `BOOTSTRAP_TOKEN_ISSUED`
- `BOOTSTRAP_TOKEN_CLAIMED`
- `BOOTSTRAP_COMPLETED`

보안 및 재시도 규칙:

- token 발급 audit는 bootstrap token insert와 같은 transaction에서 기록한다.
- claim audit는 token consume과 같은 transaction에서 기록한다.
- claim replay와 completion retry는 token row lock과 `operation_id + action` 조회를 사용해 같은 lifecycle audit를 중복 기록하지 않는다.
- audit resource type은 `bootstrap_token`, resource ID는 token ID를 사용한다.
- bootstrap token 원문과 native Swarm join token은 audit payload에 기록하지 않는다.
- bootstrap label 변경 자체는 기존 node mutation audit(`NODE_LABELS_STARTED`, `NODE_LABELS_SUCCEEDED`)를 그대로 사용한다.
