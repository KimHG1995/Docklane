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
