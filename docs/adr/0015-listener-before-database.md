# ADR 0015: 리스너 확보 후 DB 초기화

- 상태: 작업본에 구현, 집중 검증만 완료. Phase 4 및 운영 적용은 미승인.

## 배경

서버가 SQLite 초기화를 먼저 수행한 뒤 포트 bind를 시도했다. 기존 bind 회귀 테스트는 현재 필수 DB 스키마가 없는 파일을 사용해 bind 전 실패도 통과로 오인할 수 있었다. 현재 스키마를 갖춘 테스트 소유 DB로 실제 `EADDRINUSE`를 재현한 결과, bind 실패 후 메인 파일 바이트는 같았지만 WAL·SHM이 새로 남았다. 초기화 과정의 트리거 삭제·재생성과 관찰된 `schema_version` 변화는 부합하지만 WAL 전체의 유일 원인이나 데이터 손상을 증명하지는 않는다.

## 결정

- 실제 `app.listen`의 성공 콜백에서 DB 초기화, 429 스키마 검증, expiry scheduler 시작을 순서대로 수행한다. bind 오류 시 해당 작업을 시작하지 않는다.
- 콜백이 완료되기 전 모든 애플리케이션 요청을 503으로 거부하는 readiness 게이트를 파서와 라우트 앞에 둔다. 기존 no-store 헤더 처리는 게이트보다 앞에 유지한다.
- 시작 중 오류 및 종료 진입 시 readiness를 닫고, 지연 시작 콜백이나 재진입한 종료 뒤에는 DB 초기화의 다음 단계·scheduler 시작·readiness 복구를 하지 않는다. 시작 콜백 안의 동기 오류는 기존 실패 경로로 처리한다.
- Node 리스너 콜백과 DB 초기화가 동기적으로 실행되는 동안 일반 요청 이벤트는 같은 이벤트 루프에서 그 콜백보다 앞서 처리되지 않는다는 전제에 더해 readiness 게이트를 둔다. 이 결정은 초기화가 비동기화되거나 worker로 이동하는 경우 재검토한다.
- 종료 시 전체 DB producer가 추적됐다는 증거는 여전히 없으므로 ADR 0009의 DB 연결 유지와 5초 deadline 정책을 그대로 둔다.

## 대안과 결과

기존 순서를 유지하고 bind 실패 후 WAL을 정리하는 방법은 bind 전 실제 DB 변경이 일어날 수 있고 미추적 DB 작업이 남았을 수 있어 채택하지 않았다. 사전 포트 확인 후 나중에 bind하는 방법은 검사와 bind 사이의 경쟁을 없애지 못한다. 리스너를 먼저 확보하면 초기화 실패 중에도 짧게 포트가 점유될 수 있고, 준비 전 연결에는 503을 반환한다. 정상 시작 전 포트가 열려 있다는 사실만으로 준비 완료라고 판단하면 안 된다.

## 검증 및 한계

- 작업 전 테스트 소유 파일 SQLite·루프백에서 실제 bind 시도와 `EADDRINUSE`, 종료 코드 1을 관찰하고 DB sidecar 변경으로 RED를 확인했다. 변경 후 기본 `phase1-bind.test.mjs`의 tsx 로더 단독 실행은 **2/2**: 실제 bind 충돌 후 파일 비교와 실제 production listener의 `/health` 양성 경로. 자식 서버는 Node 네이티브 TypeScript 변환과 테스트 전용 resolve·네트워크 가드를 사용하며 운영 계정과 DB를 사용하지 않았다. 헬스 요청은 정상 시작 확인일 뿐 제공자 호환성 검증이 아니다.
- 시작 순서·readiness·합성 종료 경합 **8/8**, 종료 관련 선택 6개 파일 **45/45**, 별도 선택 3개 파일 **43/43**, 실제 Express·테스트 소유 루프백 소켓의 사용량 종료 fixture 외부 **1/1**이 통과했다. 합성 의존성·가짜 타이머·메모리 SQLite와 테스트 전용 계측을 포함하며 모든 결과는 별개 범위다.
- `tsc --noEmit` exit 0. 전체 기본 테스트, 빌드 산출물, 실제 제공자, 모든 DB producer의 종료 소유권 및 운영 기존 DB 전환은 검증하지 않았다.
- 시작 순서 변경 이후 인증 사용량 종료 집중 실행 외부 **1/1**, DB 연결 유지 관련 선택 테스트 **2/2**도 통과했다. 전자는 가짜 listener 및 테스트 전용 소스 계측, 후자는 모의 SIGTERM과 메모리 DB를 사용한다.
- 선택 종료 테스트 중 시작 콜백이 빠졌던 OAuth 재시도·격리 writer·토큰 admission·deadline fixture를 정상 초기화 이후 종료하도록 수정했다. 합성 DB 초기화와 expiry 시작을 명시적으로 확인하고 핵심 경로에서 expiry stop을 관찰했으며, 수정 후 선택 6개 파일 합동 재실행은 **45/45**다. 실제 제공자·DB·소켓이나 전역 producer drain을 증명하지 않는다.
- bind 테스트는 명시적 절대 `TMPDIR`, Windows 시스템 환경값, Node 24의 실험적 타입 변환이 필요하다. 테스트 가드는 OS 샌드박스가 아니다. 다른 플랫폼 및 모든 경로 경합은 미검증이다.

## 참조

- 구현: `src/server.ts`; 회귀: `tests/phase1-bind.test.mjs`, `tests/phase1-bind-owned.fixture.mjs`, `tests/server-listen-before-init.fixture.mjs`.
- [Node.js net.Server listen](https://nodejs.org/api/net.html#serverlisten), [SQLite WAL](https://sqlite.org/wal.html).
- [ADR 0009: 종료 기한과 DB 작업](./0009-shutdown-deadline-database.md), [테스트 안전성](../phase4-test-execution-safety.md).
