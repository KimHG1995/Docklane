# Functional PoC

Docklane의 기능 MVP를 실제 Docker Engine / Swarm / MySQL / OCI Registry 경계에서 검증한다.

Functional PoC는 일반 PR validation과 분리한다. Docker service를 생성하고 로컬 registry/MySQL을 띄우는 테스트이므로 모든 코드 변경마다 실행하지 않는다.

## 실행 방식

GitHub Actions의 `functional-poc` workflow를 수동 실행한다.

현재 자동 smoke 범위는 disposable GitHub runner의 단일 manager Swarm이다.

```text
GitHub runner
├─ Docker Engine / single-node Swarm manager
├─ local registry :5000
├─ MySQL :33306
├─ Docklane Agent :9443
├─ Docklane API :3001
└─ fixture service :18080
```

이 단계는 v0.6의 3-node topology를 대체하지 않는다. Control Plane과 실제 Docker/MySQL/Registry 사이의 첫 통합 경계를 검증하는 smoke gate다.

## 현재 자동 검증 시나리오

### Normal digest deploy

1. fixture image v1/v2를 로컬 OCI registry에 push한다.
2. v1 replicated service를 Swarm에 생성한다.
3. Release v2를 tag로 생성한다.
4. Docklane registry adapter가 tag를 immutable sha256 digest로 resolve한다.
5. DeploymentTarget에 v2 Release를 배포한다.
6. API 결과가 `SUCCESS`인지 확인한다.
7. 실제 service image가 Release digest로 pin 되었는지 확인한다.
8. 외부 health endpoint body가 v2로 변경됐는지 확인한다.

### Same digest/spec no-op

동일 Release를 새 operationId로 다시 배포한다.

완료 조건:

- `SUCCESS`
- `noOp=true`
- health 안정 구간 통과

### Broken release + manual rollback

1. health endpoint가 503을 반환하는 `vbroken` image를 registry에 push한다.
2. Release를 생성하고 현재 v2 service에 배포한다.
3. service image가 broken digest로 실제 변경됐는지 확인한다.
4. application health 실패로 Deployment가 `FAILED`인지 확인한다.
5. 해당 Deployment에 manual rollback을 요청한다.
6. `ROLLED_BACK`을 확인한다.
7. 실제 service image digest가 이전 v2 Release digest로 복구됐는지 확인한다.
8. root response가 다시 `v2`, `/health`가 HTTP 200인지 확인한다.

### API restart during update

1. startup이 8초 지연되는 healthy `v3` image를 registry에 push한다.
2. 별도 10초 health stability window로 v3 배포를 시작한다.
3. DB에 operation/deployment intent가 저장되고, Swarm service image가 v3 digest로 실제 변경된 것을 확인한다.
4. operation이 아직 `RUNNING` 또는 `VERIFYING`인 상태에서 API 프로세스를 SIGKILL로 종료한다.
5. 동일 MySQL과 Agent를 유지한 채 API를 다시 시작한다.
6. application bootstrap reconciliation이 기존 operation을 읽어 배포 검증을 재개한다.
7. status API polling으로 `SUCCESS`를 확인한다.
8. live response가 `v3`, `/health`가 HTTP 200인지 확인한다.
9. Docker service spec version이 정확히 한 번만 증가했는지 확인한다.
10. 해당 operation의 audit에 `DEPLOY_STARTED`와 `DEPLOY_SUCCEEDED`가 각각 정확히 한 번만 존재하고 실패/attention 이벤트가 없는지 확인한다.

이 시나리오는 API 재기동 후 Docker image mutation을 blind retry하지 않고 persisted intent 기반으로 검증만 재개하는지 확인한다.

### Agent response loss

1. PoC API는 실제 Agent 앞의 로컬 pass-through proxy를 사용한다.
2. `v4` Release 배포 직전에 one-shot marker를 생성한다.
3. proxy는 `POST /v1/services/:id/image`를 실제 Agent에 전달하고 backend 응답까지 읽는다.
4. Docker mutation이 실제 적용된 뒤 해당 응답만 API 쪽에서 끊는다.
5. marker는 즉시 제거되어 이후 inspect 요청은 정상 통과한다.
6. Docklane이 현재 Swarm 상태를 inspect해 동일 operation을 `SUCCESS`로 복구하는지 확인한다.
7. Docker service spec version이 정확히 한 번만 증가했는지 확인한다.
8. audit에서 `DEPLOY_STARTED`와 `DEPLOY_SUCCEEDED`가 각각 한 번이고 failure/attention 이벤트가 없는지 확인한다.

이 시나리오는 Agent 요청을 다시 실행하지 않고 **응답 유실 후 관찰 기반 reconciliation**이 동작하는지 검증한다.

### Authorization rejection

VIEWER token으로 Application 생성 요청을 보내 HTTP 403을 확인한다.

### Audit completeness

실제 MySQL `audit_events`에서 아래 event를 확인한다.

- `APPLICATION_CREATED`
- `DEPLOYMENT_TARGET_CREATED`
- `RELEASE_CREATED`
- `DEPLOY_STARTED`
- `DEPLOY_SUCCEEDED`
- `DEPLOY_NO_OP_STARTED`
- `DEPLOY_NO_OP_SUCCEEDED`

## Evidence

workflow는 성공/실패와 무관하게 runner의 PoC evidence를 artifact로 저장한다.

주요 파일:

- `summary.txt`
- `api.log`
- `agent.log`
- `application.json`
- `target.json`
- `release.json`
- `deploy.json`
- `noop-deploy.json`
- `broken-release.json`
- `broken-deploy.json`
- `rollback.json`
- `service-after-deploy.json`
- `service-after-broken-deploy.json`
- `service-after-rollback.json`
- `restart-release.json`
- `restart-before-crash.txt`
- `restart-deploy-post.json`
- `restart-deploy-post.err`
- `restart-deploy-status.json`
- `restart-deploy.json`
- `service-after-api-restart.json`
- `restart-audit-actions.txt`
- `agent-proxy.log`
- `agent-proxy-drops.log`
- `response-loss-release.json`
- `response-loss-deploy-initial.json`
- `response-loss-deploy-status.json`
- `response-loss-deploy.json`
- `service-after-response-loss.json`
- `response-loss-audit-actions.txt`
- `audit-actions.txt`
- Docker build/push/swarm 생성 로그

artifact retention은 14일이다.

## 로컬 실행

테스트는 현재 Docker Swarm이 비활성인 disposable host를 요구한다.

```bash
corepack enable
pnpm install --no-frozen-lockfile
bash tests/functional-poc/run.sh
```

실패 또는 종료 후 cleanup:

```bash
bash tests/functional-poc/cleanup.sh
```

실제 개발 서버나 운영 Swarm이 활성화된 호스트에서는 실행하지 않는다.

## 아직 수동/후속 검증인 v0.6 항목

- 3-node manager-01 / worker-01 / worker-02 topology
- broken release + automatic rollback
- external CLI conflict
- API restart during update — harness implemented; acceptance pending an actual workflow run
- Agent response loss — harness implemented; acceptance pending an actual workflow run
- capacity shortage
- actual external LB traffic during rollout
- worker failure
- node drain
- Swarm internal ports network exposure 검증

이 항목들은 단일-node smoke가 안정화된 뒤 별도 시나리오로 확장한다.


## Asynchronous deployment polling

Deployment/rollback POST 응답은 동기 관찰 한계 안에서 terminal 상태가 되지 않으면
`VERIFYING` 또는 `ROLLBACK_VERIFYING`을 반환할 수 있다.

Functional PoC는 첫 POST 응답만으로 성공/실패를 판정하지 않는다.

```text
POST deploy / rollback
       ↓
deployment id 확보
       ↓
GET /v1/clusters/default/deployments/:id/status
       ↓
terminal 상태까지 제한 시간 polling
```

허용 terminal 상태는 시나리오별 예상값으로 검증하며, 다른 terminal 상태에 도달하면 즉시 실패한다.

## Cleanup

`cleanup.sh`의 Git 실행 권한에 의존하지 않는다.

```bash
bash tests/functional-poc/cleanup.sh
```

`run.sh`의 EXIT trap과 GitHub Actions cleanup step 모두 위 방식으로 호출한다.
