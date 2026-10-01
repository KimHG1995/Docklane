# Operational Readiness

v0.8은 기능 MVP 이후 운영 장애와 복구 동작을 실제 Docker Swarm 경계에서 검증한다.

Functional PoC와 분리해 최소 3 manager topology를 사용한다. 각 항목은 harness 구현만으로 완료 처리하지 않고 실제 GitHub Actions run이 성공한 경우에만 ROADMAP acceptance를 갱신한다.

## Leader loss

전용 workflow:

`operational-readiness-leader-loss`

Topology:

```text
GitHub runner Docker
└─ docklane-or-manager-net
   ├─ manager-01 (DinD, Swarm manager)
   ├─ manager-02 (DinD, Swarm manager)
   └─ manager-03 (DinD, Swarm manager)
```

검증 순서:

1. manager 3개를 구성하고 모두 `Ready / Active`인지 확인한다.
2. 정확히 1개가 `Leader`, 나머지 2개가 `Reachable`인지 확인한다.
3. 현재 leader를 동적으로 식별해 해당 DinD container를 중지한다.
4. surviving manager에서 기존 leader가 더 이상 Ready가 아닌지 관찰한다.
5. 2/3 manager가 control 가능한 상태를 유지하고 새로운 leader가 선출되는지 확인한다.
6. 중지했던 manager를 다시 기동한다.
7. 3개 manager가 다시 `Ready / Active`, 1 Leader + 2 Reachable 상태로 복구되는지 확인한다.

주요 evidence:

- `topology-before-loss.txt`
- `topology-after-leader-loss.txt`
- `topology-after-recovery.txt`
- `leader-stop.log`
- `leader-restart.log`
- `summary.txt`



### Acceptance

2026-09-30 GitHub Actions run #36680739108: **SUCCESS**

관찰 결과:

```text
before
manager-01 | Ready   | Active | Leader
manager-02 | Ready   | Active | Reachable
manager-03 | Ready   | Active | Reachable

leader loss
manager-01 | Unknown | Active | Unreachable
manager-02 | Ready   | Active | Reachable
manager-03 | Ready   | Active | Leader

recovery
manager-01 | Ready   | Active | Reachable
manager-02 | Ready   | Active | Reachable
manager-03 | Ready   | Active | Leader
```

현재 leader를 중지한 뒤 2/3 manager quorum에서 새 leader가 선출됐고, former leader 재기동 후 3/3 manager 상태가 복구됐다.

## Safety

operational readiness harness는 기존 Docker resource를 이름만 보고 삭제하지 않는다.

- 시작 전 동명 container/network 존재 여부를 확인한다.
- 생성 직후 실제 container/network ID를 ownership marker에 기록한다.
- cleanup은 marker에 기록된 ID가 현재 resource ID와 일치할 때만 삭제한다.
- cleanup 실패 시 marker를 남겨 동일 cleanup script로 재시도할 수 있게 한다.

현재 leader-loss harness는 leader failover와 former leader recovery만 검증한다. manager loss, quorum loss, network partition은 별도 작업 단위로 추가한다.


## Manager loss

Leader가 아닌 `Reachable` manager 1대를 중지해 단일 manager 장애 시 quorum과 leader continuity를 검증한다.

검증 순서:

1. 3-manager Swarm을 구성해 1 Leader + 2 Reachable 상태를 확인한다.
2. 현재 leader가 아닌 Reachable manager를 동적으로 선택한다.
3. 해당 manager의 DinD container를 중지한다.
4. 기존 leader가 그대로 유지되는지 확인한다.
5. surviving manager 2개가 Ready/Active이고 quorum control이 유지되는지 확인한다.
6. 중지했던 manager가 Unreachable 상태로 관찰되는지 확인한다.
7. manager를 재기동한다.
8. 3개 manager가 Ready/Active로 복구되고 기존 leader가 유지되는지 확인한다.

주요 evidence:

- `topology-before-loss.txt`
- `topology-after-manager-loss.txt`
- `topology-after-recovery.txt`
- `manager-stop.log`
- `manager-restart.log`
- `manager-loss-summary.txt`

Leader loss와 manager loss workflow는 동일한 `operational-readiness-three-manager` concurrency group을 사용해 같은 Docker resource 이름을 동시에 사용하지 않는다.


### Manager loss acceptance

2026-09-30 GitHub Actions run #36681425236: **SUCCESS**

관찰 결과:

```text
before
manager-01 | Ready | Active | Leader
manager-02 | Ready | Active | Reachable
manager-03 | Ready | Active | Reachable

manager loss
manager-01 | Ready | Active | Leader
manager-02 | Down  | Active | Unreachable
manager-03 | Ready | Active | Reachable

recovery
manager-01 | Ready | Active | Leader
manager-02 | Ready | Active | Reachable
manager-03 | Ready | Active | Reachable
```

non-leader manager 한 대의 장애와 복구 동안 leader continuity와 2/3 quorum control이 유지됐다.


## Quorum loss

3-manager Swarm에서 현재 Leader만 남기고 Reachable manager 2대를 동시에 중지해 1/3 상태를 만든다.

검증 순서:

1. 3 manager가 Ready/Active이고 1 Leader + 2 Reachable인지 확인한다.
2. 두 Reachable manager를 중지해 현재 Leader만 남긴다.
3. surviving manager에서 manager control-plane read가 실패하는지 확인한다.
4. node label write도 실패해 1/3 상태에서 Raft mutation이 차단되는지 확인한다.
5. follower manager 1대를 복구한다.
6. 2/3 manager quorum과 1 Leader가 복구되는지 확인한다.
7. node label write가 다시 성공하는지 확인한다.
8. 마지막 manager까지 복구해 3/3 Ready/Active 상태를 확인한다.

주요 evidence:

- `topology-before-quorum-loss.txt`
- `quorum-loss-node-ls.out`
- `quorum-loss-node-ls.err`
- `quorum-loss-write.out`
- `quorum-loss-write.err`
- `topology-after-quorum-recovery.txt`
- `quorum-recovery-write.log`
- `topology-after-full-recovery.txt`
- `quorum-loss-summary.txt`

Leader loss, manager loss, quorum loss는 모두 `operational-readiness-three-manager` concurrency group을 사용해 동일한 DinD resource namespace를 직렬화한다.


### Quorum loss acceptance

2026-09-30 GitHub Actions run #36682067172: **SUCCESS**

관찰 결과:

```text
before
manager-01 | Ready | Active | Leader
manager-02 | Ready | Active | Reachable
manager-03 | Ready | Active | Reachable

1/3 quorum
docker node ls -> context canceled
node write -> The swarm does not have a leader. It's possible that too few managers are online.

2/3 recovery
manager-01 | Ready   | Active | Leader
manager-02 | Ready   | Active | Reachable
manager-03 | Unknown | Active | Unreachable

3/3 recovery
manager-01 | Ready | Active | Leader
manager-02 | Ready | Active | Reachable
manager-03 | Ready | Active | Reachable
```

1/3 상태에서 manager control-plane read/write가 차단됐고, manager 한 대 복구 후 2/3 quorum에서 read/write가 다시 가능해졌다.


## Network partition

현재 Leader 프로세스는 계속 실행한 채, 해당 manager의 network namespace에 peer manager 2대의 IP를 대상으로 INPUT/OUTPUT DROP rule을 적용해 leader를 다수측으로부터 격리한다.

검증 순서:

1. 3 manager가 Ready/Active이고 1 Leader + 2 Reachable인지 확인한다.
2. 현재 Leader를 동적으로 식별한다.
3. Leader container 내부 iptables에 나머지 manager 2대와의 양방향 DROP rule을 추가한다.
4. 다수측 2 manager가 기존 Leader와 다른 새 Leader를 선출하는지 확인한다.
5. 격리된 former Leader에서 control-plane read/write가 실패하는지 확인한다.
6. 다수측 새 Leader에서는 node-spec write가 계속 성공하는지 확인한다.
7. DROP rule을 제거해 네트워크를 복구한다.
8. 3 manager가 다시 Ready/Active, 1 Leader + 2 Reachable 상태로 합류하는지 확인한다.

주요 evidence:

- `topology-before-partition.txt`
- `partition-input-rules.txt`
- `partition-output-rules.txt`
- `topology-during-partition.txt`
- `isolated-node-ls.err`
- `isolated-write.err`
- `majority-write.log`
- `topology-after-partition-recovery.txt`
- `network-partition-summary.txt`

이 시나리오는 프로세스 종료가 아닌 통신 단절에서 Raft majority가 새 leader를 유지하고, minority manager가 control-plane mutation을 수행하지 못하는지 검증한다.


## Manager-specific Go Agent deployment

각 Swarm manager에 동일한 Go Agent 바이너리를 1개씩 배포하고, Agent가 반드시 해당 host의 local Docker daemon에 연결되도록 한다.

Control Plane 설정은 두 모드를 지원한다.

Legacy single endpoint:

```text
DOCKLANE_AGENT_URL=https://manager-01:9443
```

Manager registry:

```json
DOCKLANE_MANAGER_AGENTS=[
  {"id":"manager-01","baseUrl":"https://manager-01:9443"},
  {"id":"manager-02","baseUrl":"https://manager-02:9443"},
  {"id":"manager-03","baseUrl":"https://manager-03:9443"}
]
DOCKLANE_AGENT_PRIMARY_ID=manager-01
```

Control Plane은 명시적으로 선택한 primary Agent를 먼저 사용한다. read/plan 요청에서 transport 오류 또는 Agent 5xx가 발생하면 다른 manager Agent의 `/v1/identity`를 확인하고, 기준 Swarm cluster ID와 일치하는 Agent로 전환한다. 선택된 Agent는 유지하며 실패한 endpoint는 짧은 cooldown 동안 우선순위에서 제외해 즉시 failback이 반복되지 않도록 한다.

실제 Docker mutation 요청은 다른 Agent에 자동 재전송하지 않는다. mutation 전송 결과가 불명확한 경우 해당 Agent를 일시적으로 제외하고 오류를 상위 coordinator에 전달하며, 기존 operation reconciliation이 다른 정상 Agent의 read path를 사용해 실제 Docker 상태를 확인한 뒤 결과를 확정한다. `/v1/health`는 Swarm 미가입 상태에서도 사용할 수 있도록 identity 검증과 독립적으로 failover한다.

Agent `GET /v1/identity`는 다음을 반환한다.

- Swarm cluster ID
- local Swarm manager node ID
- hostname
- manager 여부
- 현재 local node의 leader 여부

전용 workflow:

`operational-readiness-manager-agents`

Acceptance topology:

```text
manager-01 ─ docklane-agent ─ local Docker daemon
manager-02 ─ docklane-agent ─ local Docker daemon
manager-03 ─ docklane-agent ─ local Docker daemon
```

검증 순서:

1. 3-manager DinD Swarm을 구성한다.
2. 정적 Go Agent 바이너리를 각 manager container에 복사한다.
3. 각 Agent를 해당 manager의 local Docker socket에 연결해 실행한다.
4. 각 Agent의 `/v1/identity`를 manager 내부 loopback에서 조회한다.
5. Agent가 보고한 node ID가 해당 Docker daemon의 `Swarm.NodeID`와 일치하는지 확인한다.
6. 세 Agent가 서로 다른 manager node ID를 보고하는지 확인한다.
7. 세 Agent가 동일한 Swarm cluster ID를 보고하는지 확인한다.
8. 정확히 한 Agent만 자신의 local node를 leader로 관찰하는지 확인한다.
9. Control Plane `HttpAgentClient`가 manager-01을 primary로 선택한 상태에서 identity를 확인한다.
10. manager-01의 Agent 프로세스만 종료하고 Swarm manager 자체는 유지한다.
11. 같은 `HttpAgentClient` 인스턴스의 다음 identity 요청이 manager-02 또는 manager-03으로 전환되는지 확인한다.
12. failover 전후의 Swarm cluster ID가 동일하고 node ID가 달라졌는지 확인한다.

주요 evidence:

- `topology.txt`
- `manager-01-identity.json`
- `manager-02-identity.json`
- `manager-03-identity.json`
- `manager-agent-failover.json`
- `manager-agents-summary.txt`

이 workflow도 다른 3-manager readiness workflow와 동일한 `operational-readiness-three-manager` concurrency group을 사용한다.

2026-10-02 acceptance run #36941789676에서 3-manager mTLS Agent 구성, 동일 cluster identity 검증, primary Agent 프로세스 종료 후 Control Plane read failover를 확인했다.
