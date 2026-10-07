# Agent mutation cluster 사전조건

## 범위

Control Plane의 `/v1/identity` 확인이 끝난 뒤 Agent가 실제 변경 요청을 처리하기 전에 endpoint가 다른 Swarm으로 재가입하는 상황을 차단한다. 무기한 identity 캐시를 없앤 기존 수정에 **Agent HTTP 변경 요청의 수락 조건**을 추가한다.

이 검사는 Docker의 cluster 조회와 service/node update를 하나의 원자적 연산으로 만들지 않는다. Agent의 identity 확인 **이후** DockerReader 내부에서 최종 Docker 갱신을 호출하기 전까지 발생하는 외부 CLI 재가입은 여전히 별도 경쟁 조건이다. 이 작업으로 해당 경쟁 조건이나 cluster registration을 완료 처리하지 않는다. 운영 중 수동 rejoin은 진행 중인 mutation과 분리해야 한다.

mTLS, API 측 RBAC와 resource scope, canonical resource ID, version/spec 조건, operation 기록과 reconciliation은 그대로 유지한다. 헤더는 인증 수단이 아니며, 클라이언트가 cluster를 임의로 변경하도록 허용하는 API도 아니다. Control Plane은 운영 설정의 실제 Swarm cluster ID를 기준으로 사용하고 불일치가 발생해도 새 값으로 재설정하지 않는다. 명시적인 insecure 개발 모드에서 기준값을 생략한 경우에만 최초 정상 identity로 고정한다.

## 재시작에도 유지되는 운영 기준값

운영 Control Plane에는 `DOCKLANE_EXPECTED_CLUSTER_ID`를 반드시 설정한다. 값은 실제 Swarm cluster ID이며, API 경로 및 권한 범위의 논리 이름인 `DOCKLANE_CLUSTER_ID=default`와 다르다. 두 값을 서로 대체하거나 기본값으로 사용하지 않는다.

정상 quorum을 가진 신뢰할 수 있는 manager에서 아래 읽기 명령으로 ID를 확인하고, 운영자가 대상과 값을 검증한 뒤 배포 환경 설정에 고정한다. 임의 endpoint에서 가져온 값을 시작 스크립트가 매번 자동 저장하면 이 보호가 무효화된다. 장애 중 `info` 응답으로 기준값을 복구하거나 변경하지 않는다.

```bash
# Verify the Docker context/host and manager before running this read.
docker info --format '{{.Swarm.Cluster.ID}}'
```

배포 설정 예시는 다음과 같다. `actual-swarm-cluster-id`는 실제 확인한 값으로 교체한다.

```dotenv
DOCKLANE_CLUSTER_ID=default
DOCKLANE_EXPECTED_CLUSTER_ID=actual-swarm-cluster-id
```

형식은 기존 헤더와 같은 길이 1~128의 `[A-Za-z0-9_-]`이고, 공백/개행/쉼표/빈 문자열을 정규화하거나 허용하지 않는다. 운영 모드의 값 누락이나 모든 모드의 명시적인 잘못된 값은 자격증명 파일 읽기 전에 설정 로딩을 실패시킨다. 직접 주입한 `ManagerAgentConfig.expectedClusterId`에도 같은 검사를 적용하며, manager 목록에 secure Agent가 하나라도 있으면 생략할 수 없다.

`HttpAgentClient`를 구성할 때 기준 문자열을 복사한다. 이후의 첫 접속, health 조회, primary 장애, API 재시작과 새 client 생성에서도 원격 identity로 설정값을 덮어쓰지 않는다. 다른 cluster만 응답하면 보호된 조회 및 변경 요청을 전송하지 않는다. 전송 전의 기존 identity failover는 설정한 cluster에 대해서만 유지하며, 변경 전송 이후의 자동 재시도 금지도 유지한다. Health 성공은 전송 경로의 생존 여부일 뿐 cluster 검증 완료가 아니다.

`DOCKLANE_AGENT_INSECURE_DEV=true`로 명시한 개발 환경에서만 기준값을 **아예 생략**해 기존 최초 identity 인식을 사용할 수 있다. 이 경우 재시작 후 재인식 위험은 그대로이므로 운영에 사용하지 않는다. `.env.example`의 빈 설정을 둔 채 개발 모드로 바꾸면 오류가 나므로, 실제 값을 채우거나 개발용 환경에서 해당 항목을 제거해야 한다.

업그레이드 전에 정상 manager의 실제 ID를 모든 Control Plane 인스턴스의 환경 설정에 동일하게 배포한다. 잘못된 설정으로 접속이 거부되더라도 자동으로 관찰된 ID로 바꾸지 않는다. 대상 cluster 교체는 기존 작업/권한/DB 바인딩의 처리 정책을 확인한 별도 운영 변경으로 수행한다. 이 작업은 DB 기반 cluster registration, 등록/변경 감사 API, 최초 환경 설정의 신뢰성 검증이나 마지막 Docker update와 외부 rejoin 사이의 원자성을 구현하지 않는다.

별도 Node 프로세스를 두 번 시작해 첫 프로세스의 정상 조회 후 endpoint의 cluster를 바꾸고, 두 번째 프로세스가 같은 설정으로 변경 요청을 거절하는 회귀를 추가했다. 로컬 HTTP 서버를 쓰는 테스트이므로 실제 Swarm 재가입 시험과는 구분한다. mTLS PoC의 `mtls-health-only` 값은 Swarm 없이 transport/liveness만 검증하는 테스트용 sentinel이며 운영 설정 예시가 아니다.

## 요청 계약

Control Plane의 실제 변경은 `/v2/nodes/{nodeId}/{drain|activate|labels}` 및 `/v2/services/{serviceId}/{scale|restart|image|rollback}`을 사용한다. 조회, health, identity, 계획과 capacity-check는 기존 v1 경로를 유지한다.

변경 요청에는 `X-Docklane-Expected-Cluster-ID` 헤더가 정확히 하나 있어야 한다. 허용 값은 길이 1~128의 `[A-Za-z0-9_-]` 문자열이며, 공백이나 쉼표 목록, 중복 헤더는 허용하지 않는다. 이 문법은 전달 형식 검증이며 실제 Swarm ID의 canonical 검증을 대체하지 않는다. 요청 본문의 기존 필드와 응답 성공 스키마는 바꾸지 않는다.

Agent는 기존 JSON 및 필수 필드 검증 후, DockerReader mutation 함수를 호출하기 직전에 현재 manager identity를 다시 조회한다. 해당 조회에는 요청 취소와 최대 5초 제한을 적용하며, 오류 원문은 응답에 포함하지 않는다. 모든 7개 변경 handler가 같은 guard를 사용한다.

| Agent 응답 | 의미 | 변경 호출 |
| --- | --- | --- |
| `428 / CLUSTER_PRECONDITION_REQUIRED` | 필수 헤더가 없음 | 없음 |
| `400 / INVALID_CLUSTER_PRECONDITION` | 헤더 중복 또는 형식 오류 | 없음 |
| `412 / CLUSTER_PRECONDITION_FAILED` | 현재 cluster가 기대 값과 다름 | 없음 |
| `503 / CLUSTER_IDENTITY_UNAVAILABLE` | manager identity 확인 실패 또는 요청 취소 | 없음 |

위 코드는 Agent 프로토콜의 응답이며 외부 Control Plane API의 HTTP 상태와 동일하다는 뜻은 아니다. 유효한 헤더 이후에도 기존 본문, Docker version/spec, capacity 및 기타 작업별 조건은 별도로 적용된다. `200`은 기존과 마찬가지로 변경 요청 결과이고 deployment convergence 완료 판정은 아니다.

## 구형 버전과 업그레이드

새 헤더만 v1 요청에 붙이면 구형 Agent는 이를 무시하고 변경할 수 있다. 이를 방지하기 위해 새 Control Plane은 v2 경로만 사용하고, `404`를 받아도 v1으로 downgrade하지 않는다. Agent 선택 전의 identity failover는 유지하지만, 실제 변경 요청 전송 후에는 `412`, `428`, `503`, 연결 유실을 포함해 다른 Agent로 재전송하지 않는다.

업그레이드된 Agent에 남아 있는 v1 변경 경로도 같은 헤더와 identity 조건을 요구한다. 구형 URL을 직접 호출해 검사를 우회할 수 없다. 따라서 구형 Control Plane에서 새 Agent로 보내는 헤더 없는 변경은 `428`, 새 Control Plane에서 구형 Agent로 보내는 v2 변경은 `404`로 실패한다. 이는 조용히 잘못된 cluster를 변경하는 것보다 명시적으로 거절하는 계약이다.

업그레이드 시 신규 mutation 접수를 중단하고 기존 작업의 종료 또는 명시적인 reconciliation 상태를 확인한다. 모든 manager Agent를 올린 뒤 Control Plane을 올리고, health/identity와 올바른 cluster의 변경을 검증한 후 접수를 재개한다. 일부 Agent만 구버전으로 남아 있으면 그 endpoint로의 변경은 실패할 수 있다. 롤백도 mutation을 중단하고 호환되는 구성 전체를 기준으로 수행하며, 가용성을 이유로 헤더 검사나 downgrade 금지를 해제하지 않는다.

## 검증과 한계

Agent 회귀는 v1/v2 각각의 7개 변경 경로에서 일치/불일치/누락, 모호한 헤더, identity 오류와 요청 취소, JSON 본문을 읽는 도중 cluster가 바뀌는 상황을 확인한다. DockerReader는 대역이므로 실제 Docker의 동시 rejoin 원자성을 증명하는 테스트는 아니다.

API 회귀는 실제 HttpAgentClient와 로컬 HTTP 서버로 v2 경로와 헤더, identity 응답 직후 cluster 전환, 구형 Agent의 v1 성공 경로로 fallback하지 않음, 거절/실패 후 변경 재전송 금지를 확인한다. 기존 identity/failover 회귀의 mutation URL만 v2로 갱신한다. 전체 계약 검증은 실제 NestJS/Zod 의존성을 사용하는 API suite로 수행한다.

Functional PoC 프록시는 v1과 v2 이미지 변경 모두에서 기존 one-shot 응답 유실과 전달 횟수를 관찰한다. 실제 프록시 subprocess 회귀는 각 버전의 응답 유실/불완전 응답/연결 실패와 cluster 헤더 전달을 확인한다. 이것은 전체 Swarm acceptance와 구분한다.

API와 Agent를 함께 바꾸는 하나의 작업이며, 별도의 heavy workflow나 수동 반복 실행은 추가하지 않는다. 실제 실행의 범위와 결과는 PR 체크포인트에 남긴다.

## 참조

- [Agent OpenAPI 0.13 계약](../contracts/agent.openapi.yaml)
- [Agent 요청 guard](../agent/internal/httpserver/cluster_precondition.go)
- [Control Plane HTTP client](../apps/api/src/agent/http-agent.client.ts)
- [HTTP header values](https://pkg.go.dev/net/http#Header.Values)
- [요청 context](https://pkg.go.dev/net/http#Request.Context)
- [Docker system info와 출력 형식](https://docs.docker.com/reference/cli/docker/system/info/)
