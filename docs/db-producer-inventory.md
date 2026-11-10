# DB 생산자 목록과 종료 소유권 (ADR 0016 항목 2)

작성 2026-11-10. 코드 grep과 테스트 실행으로 확인한 범위만 적는다. "생산자"는 DB를 읽거나 쓰는 작업을 시작할 수 있는 진입점이다.

## 종료 모델 (ADR 0009, 유지)

`src/server.ts`의 `shutdown()`은 다음 순서로 동작한다.

1. 5초 종료 제한을 건다. 제한에 걸리면 `process.exit(1)`로 끝낸다.
2. 각 생산자의 승인(admission)을 즉시 닫는다.
   - `requestWork.stopAndDrain()`
   - `drainTokenRefreshes()`
   - `expiry.stopAndDrain()`
   - `stopOAuth()`
   - `stopSiwc()`
3. HTTP 리스너를 닫고(`server.close`), 모든 drain이 성공하면 종료 제한의 참조를 해제(`unref`)한다.
4. DB는 명시적으로 닫지 않는다. 프로세스는 이벤트 루프가 비면 종료 코드 0으로 끝난다.

따라서 보장 내용은 다음과 같다.

- 종료가 시작된 뒤에는 핵심 생산자가 **새 DB 작업을 시작하지 않는다**. 거부 방식은 503, 연결 거부, 또는 생산자별 오류다.
- 승인된(owned) 작업은 5초 종료 제한 안에 끝나는 경우에만 완료가 보장된다. 넘기면 강제 종료(종료 코드 1)된다. 중간에 끊긴 커밋은 SQLite WAL 복구에 맡긴다.
- 종료 코드 0은 "추적된 drain이 모두 성공했고, 이벤트 루프가 자연스럽게 비었다"는 뜻이다.

drain 등록의 역할은 두 가지다. 승인 차단은 `stopAndDrain()`을 **호출**하는 순간 일어나므로 등록 여부와 무관하다.

1. drain이 끝날 때까지 종료 제한 타이머를 참조(ref) 상태로 둔다. 그래서 스스로 이벤트 루프를 붙잡지 않는 승인된 작업도 최대 5초 동안 프로세스를 살려 둔다. 예: unref 타이머를 기다리는 작업, Promise 체인에만 매달린 작업.
2. drain 실패를 판정해 종료 코드 1로 만든다.

drain 성공 후 제한 타이머를 unref하는 것은 취소가 아니다. 다른 핸들이 루프를 붙잡고 있으면 5초에 발화해 종료 코드 1이 된다(`phase1-server` 'work that outlives the deadline…').

변형 검증(2026-11-10). 테스트 쪽 지연은 unref 타이머로, 클라이언트는 `Connection: close`로 둬서 이벤트 루프를 붙잡는 다른 핸들을 없앤 상태에서 확인했다.

| 변형 | 결과 |
|---|---|
| M1: `server.ts`에서 요청 drain을 등록하지 않음 | `phase4-shutdown-drain-http` 'post-response DB work…' 실패, `phase1-server` 'a disconnected tracked handler…' 실패 |
| FF: `forward-chat.ts`가 `recordSuccessAsync`를 await하지 않음 | 'post-response DB work…' 실패 |

추적되지 않은 비동기 작업(직접 등록한 Express 라우트 등)은 보장 대상이 아니다. `v1.ts` 주석대로 다른 생산자는 요청 매니저가 덮지 않는다.

## 생산자 목록

| 생산자 | DB 작업 | 승인 차단 | 진행 중 작업 소유 | 근거 테스트 |
|---|---|---|---|---|
| v1 추론 `/v1/chat/completions`, `/v1/messages` | 사용자 인증과 일일 한도 예약, 계정 선택, OPEN 예약, 발송 fence, 정산(OPEN 삭제, v2 제한), 성공/실패 기록, 사용량 로그 | `v1.ts` 라우터가 `requestWork.ownedDispatch`로 승인. 종료 후 503 | owned scope 안에서 핸들러를 끝까지 await한다(응답 뒤 성공 기록과 사용량 로그 포함). 위 M1·FF 변형으로 검증 | `phase4-shutdown-drain-http` 4/4: 진행 중 비스트림·스트림 완료+정산+로그, 새 요청 거부, 종료 중 클라이언트 중단 시 60초 제한 전환, 응답 뒤 DB 작업 drain |
| v1 `/v1/models` | 없음(확인 필요 없음: DB 미사용 경로) | owned | — | — |
| 관리자 동기 라우트(users, accounts, import, stats, settings) | 저장소 읽기/쓰기 | `ownedSyncUserRoute` → `ownedDispatch`. 종료 후 503 | 동기 핸들러 + 응답 메서드 호출까지 | `admin-stats-shutdown`(통과, 부하 시 간헐). `admin-user-routes-shutdown`, `admin-account-import-drain`, `admin-routing-snapshot-drain`은 **현재 실패**(아래 남은 일) |
| 관리자 `/routing-snapshot` | v2 제한, OPEN, 계정 읽기 | `ownedDispatch` | 동기 | `admin-routing-snapshot-drain` 실패(VM 의존성 목록에 v2 저장소 누락) |
| 일반 OAuth 시작/완료, 콜백 리스너 | 완료 시 `onTokens` 콜백으로 계정 생성 | `oauthStopping` 확인 후 거부, 리스너 닫기 | `oauthOperations` 집합을 `stopOAuth()`가 기다림 | `phase1-server`: 콜백 리스너 닫기, 끊긴 교환 abort·drain, 중복 교환 방지 |
| SIWC 로그인·로그아웃·관리 라우트 | 자격증명, 라우팅, 접근 정책 | `track()`/`ownedSync`, `stopSiwc()` | SIWC active 집합 | `siwc-logout-admin` 등(ADR 0009, 12/12) |
| SIWC 토큰 갱신 | 갱신 의도, 회전 결과 저장 | `requestWork.run`/`ownedDispatch` | 공유 flight + 늦은 응답 저장 | `siwc-late-rotation` 7/7 (늦은 본문 저장이 drain까지 추적됨) |
| 일반 토큰 갱신(`tokens.ts`) | 갱신 의도, 회전 결과 저장 | `drainTokenRefreshes()` 이후 새 갱신 거부 | 진행 중 flight를 기다림 | `phase1-server`: 끊긴 갱신 저장, 종료 뒤 새 갱신 차단, 멈춘 교환은 제한으로 종료 1 |
| 429 v2 만료 스케줄러 | v2 제한 만료 삭제 | `expiry.stopAndDrain()` | 진행 중 tick을 기다림. 타이머는 unref | `account-429-v2-expiry` **현재 실패**(VM에서 `require` 없음) |
| 비동기 writer(`withAsyncWriter`) | 위 생산자들의 쓰기 | 독자 승인 없음. 호출자 소유 | 호출자가 await. 재시도 타이머는 참조 상태 | 호출자 테스트에 포함 |
| 시작 시 `initDatabase` | 스키마 검증·생성 | `shuttingDown` 확인 | listen 콜백 동기 구간 | `phase1-server` 시작 계열 |

`.unref()`로 만든 타이머는 다음 넷뿐이다. 모두 DB 작업을 기다리게 하는 타이머가 아니다.

- 만료 스케줄러 타이머
- 종료 제한(drain 성공 후)
- 추론 watchdog(소켓이 루프를 붙잡음)
- OAuth·SIWC 플로 TTL

## 남은 일 (리뷰 deleg_385d22f7·deleg_c917dad4 비차단, BACKLOG로 이관)

- **(우선) keep-alive 유휴 연결이 종료를 늦춘다.** 진단에서 `server.close()` 뒤에도 클라이언트 keep-alive 서버 측 소켓이 약 4초 동안 이벤트 루프를 붙잡았다. 이 소켓이 5초 제한보다 늦게 닫히면 정상 종료가 종료 코드 1이 된다. 수정안은 종료 시 `server.closeIdleConnections()` 호출과 drain 중 응답에 `Connection: close`를 붙이는 것이다. keep-alive 클라이언트로 "5초 안에 종료 코드 0"을 확인하는 테스트도 추가한다. 운영 코드(`server.ts`) 변경이 필요하다.
- `phase1-server`의 추적 라우트는 `trackedRoute`의 복제본이다. export하거나 테스트 훅으로 실제 함수를 쓰게 한다.
- M1 변형 실행 중 'shutdown deadline bounds a stalled token exchange'가 한 번 실패했다. 원본에서 반복 실행해 불안정성 여부를 확인한다.

- 종료 후 `initDatabase` 재초기화 거부를 별도 테스트로 유지한다. 이전 'cannot reopen database' 테스트가 덮던 속성이다.
- 만료 스케줄러의 writer 내부 두 번째 시계 비교(`lockedNow`)는 현재 도달할 수 없는 방어 코드다. `sample()`이 역행 시 먼저 throw하기 때문이다. 제거하거나 주석으로 명시한다.
- 가짜 의존성 보강: 만료 테스트의 가짜 writer(비동기·롤백), 스냅샷 테스트의 가짜 transaction(트랜잭션 안 읽기 확인), 사용자 라우트 테스트의 safeIntegers(BigInt 반환).
- `phase4-shutdown-drain-http`의 200ms 고정 대기를 이벤트 기반 대기로 바꾸고, keep-alive 연결로 503 승인 차단을 확정하는 사례를 추가한다.
