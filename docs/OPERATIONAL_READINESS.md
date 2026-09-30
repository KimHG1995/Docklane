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
