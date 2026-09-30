# Functional PoC

Docklane의 기능 MVP를 실제 Docker Engine / Swarm / MySQL / OCI Registry 경계에서 검증한다.

Functional PoC는 일반 PR validation과 분리한다. Docker service를 생성하고 로컬 registry/MySQL을 띄우는 테스트이므로 모든 코드 변경마다 실행하지 않는다.

## 실행 방식

GitHub Actions의 `functional-poc` workflow는 single-node smoke를, `functional-poc-3node` workflow는 3-node topology harness를 수동 실행한다.

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


### 3-node topology harness

별도 `functional-poc-3node` workflow는 GitHub runner의 outer Docker 위에 privileged DinD 컨테이너 3개를 생성한다.

```text
GitHub runner Docker
└─ docklane-poc-3node-net
   ├─ manager-01 (DinD, Swarm manager/leader)
   ├─ worker-01  (DinD, Swarm worker)
   └─ worker-02  (DinD, Swarm worker)
```

검증 범위:

- 세 노드가 정확히 3개 존재
- `manager-01`이 `Ready / Active / Leader`
- `worker-01`, `worker-02`가 `Ready / Active`
- manager Docker API가 host loopback `tcp://127.0.0.1:22375`에서 동일한 node view를 제공
- cleanup은 이번 실행이 만든 DinD container/network ID만 제거

현재 harness는 topology, Docklane node drain/activate, worker failure recovery와 외부 LB traffic까지 검증한다.

### 3-node Docklane node drain

1. manager/worker 3-node Swarm을 구성하고 manager Docker API를 host loopback으로 노출한다.
2. MySQL, Docklane Agent, API를 기동하고 Agent는 manager-01 Docker API를 사용한다.
3. worker 전용 Alpine service 1 replica를 생성해 실제 task가 worker-01 또는 worker-02에서 Running인지 확인한다.
4. 해당 worker의 현재 node version을 읽고 Docklane drain API를 호출한다.
5. node operation이 SUCCESS이고 availability가 drain인지 확인한다.
6. drained node의 service task가 0이 되고 기존 task ID가 종료되며 다른 worker에서 replacement task가 Running인지 확인한다.
7. Docklane activate API로 node를 다시 active 상태로 복구한다.
8. NODE_DRAIN_STARTED, NODE_DRAIN_SUCCEEDED, NODE_ACTIVATE_STARTED, NODE_ACTIVATE_SUCCEEDED audit가 각각 한 번인지 확인한다.

이 시나리오는 node availability 변경뿐 아니라 실제 Swarm task relocation과 Docklane audit/recovery 경로를 함께 검증한다.

### 3-node worker failure

1. node drain/activate 검증 이후 현재 fixture task가 실행 중인 worker를 식별한다.
2. 해당 worker의 outer DinD 컨테이너를 강제 종료해 실제 worker failure를 만든다.
3. Docklane node read model이 해당 node를 더 이상 ready로 보고하지 않는지 확인한다.
4. Swarm이 기존 task를 종료하고 surviving worker에 새로운 task ID를 Running 상태로 생성하는지 확인한다.
5. Docklane service read model에서 desired/running replica가 다시 1/1로 수렴했는지 확인한다.

이 시나리오는 외부 worker 장애 시 Swarm 자체 rescheduling과 Docklane read model의 장애 관찰을 함께 검증한다.

### 3-node external LB traffic

- worker 전용 Nginx service 2 replicas를 ingress published port로 생성한다.
- outer network의 HAProxy가 세 Swarm node의 routing-mesh endpoint를 backend로 사용한다.
- HAProxy를 통한 지속 HTTP 요청 중 Docklane restart API로 start-first rollout을 발생시킨다.
- rollout 전후 desired/running 2/2 수렴을 확인한다.
- 최소 20건 이상 요청에서 non-200 응답이 없는지 확인한다.

이 시나리오는 실제 외부 LB 경로의 트래픽을 유지한 상태에서 Docklane rollout의 무중단성을 검증한다.

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
9. Agent proxy의 mutation log에서 v3 target digest에 대한 `POST /image` 전달이 정확히 한 번인지 확인한다.
10. 해당 operation의 audit에 `DEPLOY_STARTED`와 `DEPLOY_SUCCEEDED`가 각각 정확히 한 번만 존재하고 실패/attention 이벤트가 없는지 확인한다.

이 시나리오는 API 재기동 후 Docker image mutation을 blind retry하지 않고 persisted intent 기반으로 검증만 재개하는지 확인한다.

### Agent response loss

1. PoC API는 실제 Agent 앞의 로컬 pass-through proxy를 사용한다.
2. `v4` Release 배포 직전에 one-shot marker를 생성한다.
3. proxy는 `POST /v1/services/:id/image`를 실제 Agent에 전달하고 backend 응답까지 읽는다.
4. Docker mutation이 실제 적용된 뒤 해당 응답만 API 쪽에서 끊는다.
5. marker는 즉시 제거되어 이후 inspect 요청은 정상 통과한다.
6. Docklane이 현재 Swarm 상태를 inspect해 동일 operation을 `SUCCESS`로 복구하는지 확인한다.
7. Agent proxy의 mutation log에서 v4 target digest에 대한 `POST /image` 전달이 정확히 한 번인지 확인한다.
8. audit에서 `DEPLOY_STARTED`와 `DEPLOY_SUCCEEDED`가 각각 한 번이고 failure/attention 이벤트가 없는지 확인한다.

이 시나리오는 Agent 요청을 다시 실행하지 않고 **응답 유실 후 관찰 기반 reconciliation**이 동작하는지 검증한다.

### Broken release + Swarm automatic rollback

1. v4가 정상 서비스 중인 상태에서 Swarm service에 health command와 `update-failure-action=rollback`을 설정한다.
2. 동일한 `vbroken` digest를 별도 Release로 생성해 Docklane 배포를 시작한다.
3. broken task의 container health가 실패해 Swarm이 자체적으로 rollback을 시작하도록 한다.
4. Docklane은 `rollback_started` 동안 mutation protection을 유지하고, `rollback_completed`를 관찰한 뒤 원래 배포를 `FAILED`로 종결한다.
5. 별도 Docklane rollback operation이 생성되지 않았는지 확인한다.
6. 실제 service image가 이전 v4 digest로 복구되고 root 응답과 health가 정상인지 확인한다.
7. broken digest에 대한 Docklane image mutation 전달이 정확히 한 번인지 확인한다.
8. audit에는 `DEPLOY_STARTED`와 `DEPLOY_FAILED`만 남고 `ROLLBACK_STARTED` / `ROLLBACK_SUCCEEDED`가 없는지 확인한다.

이 시나리오는 **Swarm 자체 rollback을 Docklane-triggered rollback으로 오인하지 않고, 기존 deployment intent를 기준으로 관찰 및 종결하는지** 검증한다.

### Capacity shortage pre-check

1. 정상 v4 service의 현재 Docker version과 replica 수를 기록한다.
2. 현재 service version을 `expectedVersion`으로 사용해 replica 1000 scale을 요청한다.
3. fixture service의 0.05 CPU reservation을 기준으로 single-node runner가 수용할 수 없는 추가 capacity를 요구한다.
4. API가 HTTP 409와 `INSUFFICIENT_CLUSTER_CAPACITY`를 반환하는지 확인한다.
5. Docker service version과 replica 수가 요청 전후 동일한지 확인한다.
6. 해당 operationId가 `operations` 테이블에 생성되지 않았는지 확인한다.
7. 기존 v4 service의 root response와 health가 계속 정상인지 확인한다.

이 시나리오는 capacity pre-check가 **operation intent 저장과 Docker mutation보다 먼저** 실패하여 부작용 없이 요청을 거절하는지 검증한다.

### External CLI conflict

1. healthy `v5` Release 배포를 시작하고 10초 health stability window에 진입시킨다.
2. Docklane이 v5 target digest를 실제 Swarm service에 반영한 것을 확인한다.
3. 검증이 끝나기 전에 외부 CLI로 `docker service update --label-add`를 실행해 service spec만 변경한다.
4. image와 health는 그대로 정상인 상태에서 service fingerprint divergence를 만든다.
5. Deployment와 operation이 모두 `NEEDS_ATTENTION`인지 확인한다.
6. operation error code가 `EXTERNAL_SERVICE_CONFLICT`인지 확인한다.
7. audit에 `DEPLOY_STARTED`와 `DEPLOY_NEEDS_ATTENTION`이 각각 한 번만 존재하고 `DEPLOY_SUCCEEDED` / `DEPLOY_FAILED`가 없는지 확인한다.
8. Agent proxy mutation log에서 v5 image mutation 전달이 정확히 한 번인지 확인한다.

이 시나리오는 application health가 정상이어도 Docklane이 자신이 기록한 deployment target과 다른 외부 Swarm 변경을 성공으로 오인하지 않는지 검증한다.

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
- `agent-image-mutations.jsonl`
- `response-loss-release.json`
- `response-loss-deploy-initial.json`
- `response-loss-deploy-status.json`
- `response-loss-deploy.json`
- `service-after-response-loss.json`
- `response-loss-audit-actions.txt`
- `automatic-rollback-policy-update.log`
- `automatic-rollback-release.json`
- `automatic-rollback-deploy-initial.json`
- `automatic-rollback-deploy-status.json`
- `automatic-rollback-deploy.json`
- `automatic-rollback-status.json`
- `service-after-automatic-rollback.json`
- `automatic-rollback-audit-actions.txt`
- `capacity-shortage-response.json`
- `external-conflict-release.json`
- `external-conflict-deploy-post.json`
- `external-conflict-deploy-post.err`
- `external-conflict-cli-update.log`
- `external-conflict-deploy-status.json`
- `external-conflict-deploy.json`
- `external-conflict-status.json`
- `external-conflict-audit-actions.txt`
- `audit-actions.txt`
- `three-node-summary.txt`
- `three-node-topology.txt`
- `manager-api-node-ls.txt`
- `manager-docker-info.txt`
- `drain-service-before.txt`
- `drain-service-after.txt`
- `drain-node-before.json`
- `drain-operation.json`
- `drain-node-after.json`
- `activate-operation.json`
- `activate-node-after.json`
- `node-drain-audit-actions.txt`
- `worker-failure-node-before.json`
- `worker-failure-node-after.json`
- `worker-failure-service-after.txt`
- `worker-failure-service.json`
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

- API restart during update — harness implemented; acceptance pending an actual workflow run
- Agent response loss — harness implemented; acceptance pending an actual workflow run
- actual external LB traffic during rollout
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


## Functional PoC resource ownership

PoC는 기존 Docker/Swarm 자원을 이름만 보고 삭제하지 않는다.

실행 순서:

```text
preflight
├─ Swarm inactive 확인
├─ 고정 이름 registry/MySQL container 부재 확인
└─ PoC service 이름 충돌 확인
        ↓
ownership 디렉터리 초기화
        ↓
EXIT cleanup 등록
        ↓
생성 직후 실제 resource ID / PID 기록
```

cleanup은 이번 실행이 기록한 다음 값만 사용한다.

- registry container ID
- MySQL container ID
- Swarm node ID
- service ID
- API / Agent / Agent proxy PID

현재 resource ID가 기록된 값과 일치할 때만 삭제한다. preflight가 실패하면 cleanup trap 자체가 등록되지 않으므로 기존 Swarm이나 동명 자원을 건드리지 않는다.

## Mutation replay evidence

Docker Service `Version.Index`는 Swarm 내부 상태 저장에도 변경될 수 있으므로 mutation 횟수 판정에 사용하지 않는다.

PoC Agent proxy는 모든 `POST /v1/services/:id/image` 전달을 `agent-image-mutations.jsonl`에 기록한다.

각 record는 최소 다음 정보를 포함한다.

- Agent path
- backend HTTP status
- target image
- expected version
- target spec hash
- response drop 여부

API restart와 Agent response-loss 시나리오는 **해당 target digest에 대한 image mutation 전달 횟수가 정확히 1회**인지 직접 검증한다.


## PoC harness safety details

### Service ID capture

`docker service create`는 `--quiet`로 실행해 service ID만 캡처한다. 진행 메시지가 stdout에 섞인 값을 후속 `service inspect` 입력으로 사용하지 않는다.

### Cleanup retryability

cleanup ownership marker는 다음 경우에만 제거한다.

- 삭제 명령이 성공한 경우
- Docker가 명시적으로 resource not-found를 반환한 경우
- 기록된 PID가 더 이상 존재하지 않는 경우
- 기록된 Swarm이 더 이상 active가 아닌 경우

Docker 조회 또는 삭제가 일시적으로 실패하면 해당 marker를 보존하고 cleanup은 non-zero로 종료한다. 동일 `cleanup.sh`를 다시 실행하면 남은 marker를 기준으로 정리를 재시도할 수 있다.

### Agent mutation accounting

Agent proxy의 mutation log는 backend 응답 완료 여부와 분리한다.

- `event=forwarded`: backend로 request body 전송이 완료된 직후, 응답을 읽기 전에 기록
- `event=response`: backend 응답을 끝까지 읽은 경우
- `event=response_error`: backend 응답이 중간에 끊긴 경우

mutation replay 판정은 `event=forwarded`만 집계한다. 따라서 첫 요청의 backend 응답이 중간에 끊기고 두 번째 요청이 CAS 409로 끝나는 경우에도 전달 횟수는 2회로 탐지된다.
