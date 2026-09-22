# Roadmap

Docklane은 기능 수보다 실제 운영 흐름을 먼저 완성하는 방식으로 개발한다.

## v0.0 — Foundation

목표: 개발 가능한 monorepo와 Docker API spike.

- [ ] pnpm workspace / monorepo
- [ ] Next.js web
- [ ] NestJS API
- [ ] shared contracts
- [ ] database/migration
- [ ] basic authentication
- [ ] Docker Engine API spike
- [ ] local development compose
- [ ] lint / typecheck / test CI

Exit criteria:

- Web → API → DB 기본 연결
- 개발 환경에서 Swarm manager 정보를 읽는 최소 PoC

## v0.1 — Swarm Read Model

목표: CLI 없이 cluster 상태를 읽는다.

- [ ] cluster registration
- [ ] manager quorum
- [ ] node list/detail
- [ ] service list/detail
- [ ] task status
- [ ] desired/running replicas
- [ ] dashboard
- [ ] agent authentication

Exit criteria:

- 3-node Swarm의 실제 상태가 UI와 일치
- manager/worker 장애 상태를 구분

## v0.2 — Basic Operations

목표: 반복 운영 작업을 UI로 수행한다.

- [ ] replica scale
- [ ] service restart
- [ ] node labels
- [ ] node drain
- [ ] node activate
- [ ] mutation audit

Exit criteria:

- scale 4 → 8 → 3
- drain 후 task 재배치 확인
- 모든 mutation에 audit event 생성

## v0.3 — Release Management

목표: container image가 아니라 release를 배포 단위로 만든다.

- [ ] registry adapter
- [ ] repository/tag browser
- [ ] digest resolution
- [ ] release entity
- [ ] git commit / build metadata
- [ ] release history

Exit criteria:

- 동일 tag가 아닌 digest로 실제 배포 image 추적 가능

## v0.4 — Deployment

목표: Docklane의 핵심 rolling deployment flow 완성.

- [ ] deployment ticket
- [ ] deployment state machine
- [ ] deployment lock
- [ ] rolling update
- [ ] SSE progress
- [ ] service/task event mapping
- [ ] application health verification
- [ ] deployment history

Exit criteria:

```text
Release
  -> Deploy
  -> Rolling update
  -> Verify health
  -> Success
```

전체 흐름을 UI에서 완료.

## v0.5 — Rollback

- [ ] automatic rollback
- [ ] manual immediate rollback
- [ ] historical redeploy
- [ ] rollback progress
- [ ] rollback audit

Exit criteria:

- broken image 배포 후 자동 rollback
- v5에서 v2로 historical redeploy 가능

## v0.6 — Node Bootstrap

- [ ] one-time join token
- [ ] token TTL
- [ ] bootstrap script
- [ ] Docker installation/validation
- [ ] Swarm join
- [ ] node labels
- [ ] bootstrap audit

VM provisioning 자체는 여전히 범위 밖이다.

## v0.7 — Governance

- [ ] VIEWER / OPERATOR / ADMIN
- [ ] deployment approval
- [ ] deployment diff
- [ ] environment promotion
- [ ] scheduled deployment
- [ ] notification webhook

## Later

- [ ] Docker Config / Secret UI
- [ ] Stack editor / Swarm validation
- [ ] capacity dashboard
- [ ] Swarm backup status
- [ ] NCP provider adapter
- [ ] AWS provider adapter
- [ ] LB registration integration
- [ ] metrics/logging integrations
- [ ] image vulnerability integration
- [ ] multi-cluster overview

## MVP Validation Topology

```text
manager-01
worker-01
worker-02
```

검증 시나리오:

1. 정상 rolling deployment
2. broken release automatic rollback
3. worker failure task rescheduling
4. node drain task migration
5. replica scale
6. historical redeploy
7. audit completeness
8. manager quorum degraded mutation blocking
