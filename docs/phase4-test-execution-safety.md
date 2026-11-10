# Phase 4 테스트 실행 안전성: 확인된 차단 항목

이 문서는 현재 작업본의 테스트 실행 범위를 정리한다. 전체 테스트 통과나 운영 적용 승인을 의미하지 않는다. 기존 승인 대기 작업과 명시적으로 차단된 작업은 재실행하거나 다른 방법으로 같은 결과를 얻지 않는다.

## 기본 테스트 명령

`package.json`의 `npm test`는 `node --import tsx --test tests/*.test.mjs src/upstream/*.test.ts`다. 최상위 `tests/*.test.mjs`는 포함하지만 `tests/request-lifecycle-ownership/`의 중첩 파일과 `.fixture.mjs` 파일은 해당 패턴에 직접 포함되지 않는다. 별도 집중 테스트 통과를 기본 전체 테스트 통과로 간주하지 않는다.

## 실행 전 수정·검토가 필요한 확인된 항목

| 대상 | 코드에서 확인한 현재 상태 | 필요한 검증 |
| --- | --- | --- |
| `tests/phase1-bind.test.mjs` | 이전의 시스템 임시 fallback·port 0·환경 상속·bind 전 오류 오인 fixture를 `phase1-bind-owned.fixture.mjs` import로 교체했다. 명시적 절대 `TMPDIR`, Windows 시스템 환경과 Node 24 타입 변환이 필요하다. | 기본 tsx 로더를 사용한 해당 파일 단독 실행은 2/2 통과했다. 다른 플랫폼, 기본 환경의 이식성 및 전체 suite는 미검증이다. 운영 DB와 포트 20128은 사용하지 않았다. |
| `tests/routing-snapshot-server.test.mjs` | 기존 port 0·환경 상속 fixture를 `routing-snapshot-server-owned.fixture.mjs` import로 교체했다. 합성 환경과 테스트 소유 파일 SQLite를 사용하고, 실제 서버의 리스너를 테스트 전용 IPC로 우회한다. | Windows에서 기본 tsx 로더를 사용한 해당 파일 단독 실행은 1/1 통과했다. 실제 TCP는 사용하지 않았고 POSIX 소켓 경로·전체 suite는 미검증이다. 신뢰할 수 있는 절대 `TMPDIR`과 Node의 네이티브 TypeScript 변환이 필요하다. |
| `tests/phase4-200-forward-shutdown-owned.fixture.mjs` | 파일에 명시적 quarantine 예외가 남아 있고 이전 DB close 기준을 사용한다. 기본 `*.test.mjs` 대상은 아니다. | quarantine을 우회하지 않는다. 별도 안전 검토와 수정이 필요한 미검증 fixture다. 사용량 종료 경로의 별도 루프백·직접 라우터 검증과 혼동하지 않는다. |

위 표는 확인된 항목만 열거하며 모든 테스트에 대한 안전성 감사가 아니다. `listen(0)` 사용을 지적한 것은 실제로 예약 포트를 점유했다는 주장이 아니다.

### bind 충돌 격리 fixture의 RED → GREEN 결과

`tests/phase1-bind-owned.fixture.mjs`를 기본 `phase1-bind.test.mjs`에서 import한다. 합성 환경과 테스트 소유 디렉터리·SQLite 파일, 자식이 소유한 43040–43060 범위의 루프백 포트를 사용한다. 기본 테스트 래퍼는 tsx 로더를 쓰지만 생산 서버 자식은 Node 기본 TypeScript 변환 및 테스트 전용 모듈 해석 훅을 사용한다. 실제 생산 서버의 리스너 시도, `EADDRINUSE`와 exit 1을 관찰한 뒤 파일 상태를 비교하며, 별도 양성 테스트는 실제 production listener의 `/health`를 확인한다. 테스트 자식의 연결 예외는 해당 자식이 생성한 단일 리스너로 제한하며, JS 가드는 OS 샌드박스가 아니다.

집중 실행 결과 **1개 실패, exit 1**: bind 충돌은 관찰됐고 메인 DB 파일 바이트는 같았으나, 종료 후 WAL·SHM 파일이 새로 남았으며 WAL 크기는 12,392바이트였다. 추가 격리 실행에서 합성 스키마 SQL과 테이블 행의 JSON 표현 해시, `user_version`은 전후 같았고 양쪽 `integrity_check`는 `ok`였지만, `schema_version`은 39에서 43으로 변했다. 현재 초기화 코드가 매번 두 revision trigger를 `DROP`·`CREATE`하는 점과 부합하지만, 이 관찰만으로 해당 코드가 WAL 전체의 유일한 원인임을 증명하지는 않는다. 이 비교는 합성 데이터와 검사한 항목에 한정되며 SQLite 저장 클래스나 모든 논리·물리 상태의 동일성을 뜻하지 않는다. 읽기 전용 재개방도 sidecar를 변경할 수 있어 파일 스냅샷은 재개방 전에 찍었다.

첫 실행은 Windows 환경 누락으로 Node 난수 초기화가 중단되어 테스트 본문에 도달하지 못했다. 서버 시작 순서를 수정한 뒤 기본 테스트 파일 단독 실행은 **2/2, exit 0**이다. 이 fixture는 메인 DB·디렉터리 파일 목록과 기존 sidecar 내용을 비교한다. sidecar 존재만으로 논리 데이터 손상을 단정하지 않으며, 격리된 합성 DB의 결과를 운영 DB 전체로 일반화하지 않는다. 전체 테스트는 실행하지 않았다. 설계와 나머지 한계는 [ADR 0015](./adr/0015-listener-before-database.md)에 기록한다.

## 이미 수행한 제한된 검증

- 종료 관련 최상위 테스트 6개 파일을 직접 선택해 함께 실행: Node 집계 41/41, exit 0. 메모리 SQLite 또는 합성 의존성·타이머가 중심이며 전체 `npm test`가 아니다.
- 별도 OAuth 종료 재시도 합성 시험: 21/21, exit 0. 실제 콜백 리스너·제공자·운영 DB는 사용하지 않았다.
- 200 응답 후 사용량 기록의 직접 라우터 종료 회귀: 외부 1/1, exit 0. 정상 및 요청 drain 누락 변형을 각각 자식에서 실행했다. 메모리 SQLite·합성 제공자·가짜 리스너·테스트 전용 서버 소스 계측을 사용했다.
- TypeScript `tsc --noEmit -p tsconfig.json`: exit 0. 빌드 산출물을 만들지 않았으며 전체 테스트는 아니다.
- 시작 순서·readiness 합성 테스트 8/8, 변경 후 선택한 종료 테스트 6개 파일 45/45, 별도 종료·인증 3개 파일 43/43, 실제 루프백 사용량 종료 fixture 외부 1/1. 이들은 범위가 다른 집중 실행이며 전체 suite가 아니다.
- 시작 순서 변경 후 인증 사용량 종료 fixture 외부 1/1과 DB 유지 관련 두 테스트 2/2 통과. 이들은 각각 테스트 전용 소스 계측·합성 listener, 또는 모의 SIGTERM을 사용하며 모든 DB producer의 완료를 증명하지 않는다.
- 선택한 종료 테스트 중 OAuth 재시도·격리 writer·토큰 admission·deadline fixture가 시작 콜백을 생략하던 공백을 수정했다. 각 fixture에서 합성 DB 초기화와 expiry 시작을 확인한 후 종료하고, 핵심 경로에서는 expiry stop 호출도 확인한다. 수정 후 해당 네 파일의 집중 실행은 각각 21/21, 1/1, 10/10, 9/9이며, 기존 선택 6개 파일 합동 재실행은 **45/45, exit 0**이다. 실제 DB·제공자·소켓이 아닌 합성 테스트이고 전역 종료 안전성의 증거가 아니다.
- snapshot 기본 테스트 단독 실행: Windows 외부 1/1, 내부 HTTP 요청 15회. 실제 생산 서버·현재 스키마의 합성 파일 SQLite를 사용하되 listener를 고유 named pipe로 바꾸었고 실제 TCP·제공자 연결은 하지 않았다. JS 네트워크 가드는 OS 샌드박스가 아니며 scratch의 신뢰와 경로 교체가 없다는 가정이 필요하다. 테스트 전용 자식은 Node의 실험적 TypeScript 변환을 사용했다.
- fatal HTTP 리스너 오류 시 OAuth·SIWC stop 호출 누락을 합성 테스트로 먼저 재현한 뒤 수정했다. 독립 정적 리뷰 후 시작·종료 관련 선택 3개 파일 **28/28**, 별도 종료·OAuth 합성 3개 파일 **33/33**, TypeScript `--noEmit` exit 0이다. fake listener·stop·timer 경로이며 실제 OAuth/SIWC 보조 리스너나 5초 실시간 종료, 전체 producer drain을 증명하지 않는다.
- SIWC 로그아웃의 종료 소유권 누락을 합성 writer·직접 핸들러에서 재현하고, 핸들러 전체를 기존 SIWC 작업 집합에 등록했다. 독립 정적 리뷰 후 신규 기본-glob wrapper 단독 **1/1**, TypeScript `--noEmit` exit 0. 두 writer와 응답 호출 시점을 테스트 전용 VM 소스 계측으로 관찰했으며 실제 SQLite·인증·소켓·제공자 및 전역 drain은 미검증이다. 기존 승인 대기 SIWC callback 테스트를 수정하거나 실행한 결과는 아니다.
- SIWC 계정 목록·라우팅·접근 정책의 동기 DB 경로 5개는 각각 소유권과 stop 후 진입 차단 테스트가 수정 전 실패했다. 동기 예외가 Express `next`로 전달되지 않는 중간 수정의 회귀도 별도로 재현·수정했다. 독립 리뷰 뒤 신규 기본-glob wrapper와 로그아웃 wrapper 선택 실행은 **12/12**, 타입 검사 exit 0이다. 합성 재진입·가짜 DB·직접 핸들러·테스트 전용 소스 계측이며 실제 인증·SQLite·소켓과 전체 테스트는 미검증이다.

## 운영 차단

모든 DB 생산자의 종료 소유권과 기존 DB의 운영 전환은 아직 증명되지 않았다. 오프라인 429 CLI의 직접 실행은 비활성 상태다. 운영 서비스·DB·계정에 이 작업본을 적용하지 않는다. [ADR 0009](./adr/0009-shutdown-deadline-database.md)와 [오프라인 전환 문서](./offline-open-upgrade.md)를 함께 참고한다.
