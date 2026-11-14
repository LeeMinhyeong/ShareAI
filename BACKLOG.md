# ShareAI 개선 백로그

각 Phase의 코드 리뷰·테스트 과정에서 확인한 미완료 및 개선 항목입니다. **완료된 기능 목록이 아닙니다.** 상태는 확인된 사실과 미검증 사항을 구분하며, 구현 후 별도 에이전트의 코드 리뷰와 테스트를 거쳐 완료 처리합니다. 전체 개발 단계와 완료 기준은 [README 로드맵](./README.md#️-개발-로드맵)을 따릅니다.

## 우선 처리: 구독 계정과 안전성

### [ ] 실제 Claude·ChatGPT 구독 계정 연동 검증
- **관련 Phase:** 3 — 구독 계정 연결
- **현재 상태:** OAuth 흐름과 토큰 갱신은 모의 응답 및 격리 DB로 테스트했지만, 실제 구독 계정으로 로그인하고 추론에 성공한 사례는 아직 확인되지 않았습니다. 구독 계정은 API 키 방식과 다릅니다.
- **작업:** 제공자별 로그인·자격증명 가져오기·갱신·실제 요청 및 실패 후 재인증 흐름을 검증하고, 제공자 정책 및 계정 사용 위험을 확인합니다.
- **완료 기준:** 각 제공자에서 실제 구독 계정 로그인과 추론 성공, 실패 및 재인증 경로가 검증되고 결과와 제약이 기록됩니다. 자격증명은 로그나 문서에 남기지 않습니다.

### [ ] OAuth refresh 불확정 상태와 재인증 UX 개선
- **관련 Phase:** 3, 6 — 구독 계정 연결·대시보드
- **위치:** `src/upstream/tokens.ts`, `src/db/repositories/accounts.ts`, [REFRESH-SAFETY.md](./REFRESH-SAFETY.md)
- **현재 상태:** 갱신 결과가 불확실하거나 기존 refresh intent가 있으면 토큰 재전송을 차단하는 보수적 정책입니다. 다른 프로세스의 갱신과 충돌한 요청은 기다리지 않고 실패할 수 있으며, 네트워크 손실·프로세스 종료 후 재인증이 필요할 수 있습니다. 제공자가 이전과 같은 refresh token을 반환하거나 새 refresh token을 생략하는 경우에도 가용성이 제한됩니다.
- **작업:** 관리자에게 불확정·재인증 필요 상태를 명확히 표시하고 안전한 복구 절차를 제공하는 방안을 검토합니다. 동일 refresh token의 안전하지 않은 재전송을 허용하지 않습니다.
- **완료 기준:** 충돌·응답 유실·프로세스 중단·재인증 시나리오를 격리 환경에서 검증하고, 운영자에게 상태와 조치가 표시됩니다. 제공자와 로컬 저장의 원자성을 보장한다고 주장하지 않습니다.

### [ ] 반복 만료 토큰 응답 시 추가 refresh 회전 제한
- **관련 Phase:** 3 — 구독 계정 연결
- **위치:** `src/upstream/tokens.ts`, [REFRESH-SAFETY.md](./REFRESH-SAFETY.md)
- **현재 상태:** 제공자가 계속 만료된 access token을 반환하면 후속 일반 요청마다 추가 refresh가 발생할 수 있다는 위험이 마지막 독립 리뷰에서 지적됐습니다. 실제 제공자에서 재현되지는 않았습니다.
- **작업:** 반복 만료 응답의 횟수 제한, 쿨다운 및 재인증 안내 정책을 검토합니다. 회전된 자격증명을 안전하게 저장하는 동작을 보존해야 합니다.
- **완료 기준:** 모의 제공자의 반복 만료 응답에서 추가 회전이 제한되고, 정상적인 후속 복구가 차단되지 않는지 회귀 테스트로 확인합니다.

## 클라이언트·요청 처리

### [ ] 같은 요청의 다른 계정 재전송 (Phase 4 범위 밖)
- **관련 Phase:** 4 이후 — [ADR 0016](./docs/adr/0016-phase4-scope-freeze.md)에서 범위 제외
- **위치:** `src/upstream/forward-chat.ts`, [ADR 0005](./docs/adr/0005-retry-failover-policy.md)
- **현재 상태:** 비활성. 공급자별 "실행 전 거절" 근거가 없어 허용 signature가 없습니다. 429를 받은 요청 하나는 사용자에게 실패로 보입니다.
- **작업:** 공급자·endpoint·오류 signature별 근거와 약관 허용을 확인한 뒤 ADR 0005의 게이트·예산 조건으로 검토합니다.
- **완료 기준:** 중복 실행·과금이 없다는 근거가 문서화된 signature만 허용하고 격리 테스트·독립 리뷰를 통과합니다.

### [ ] 인증·종료 테스트 보강 (리뷰 Low/Medium 잔여)
- **관련 Phase:** 4, 6 — 2026-11-09 독립 리뷰 `deleg_9fe283df`(A/B/C 모두 PASS)의 비차단 지적
- **위치:** `tests/all-route-auth-synthetic.test.mjs`, `tests/server-quarantined-writer-shutdown.test.mjs`, `tests/siwc-callback-drain.test.mjs`
- **현재 상태:** 인증 테스트는 admin·SIWC·v1 라우터만 검사하고 `server.ts`의 app 수준 mount·앞단 미들웨어는 열거하지 않습니다. admin 양성 대조, 전 경로 OPTIONS·`isAccepting()=false` 503, `setHeader`/`end` 감시가 없습니다. 종료 테스트는 `requestWork`·expiry drain의 실패·hang을 기록하지 않습니다. SIWC 실제 서버 테스트는 listen 동기 throw만 다루고 비동기 `'error'` 경로는 fake로만 검증합니다. 비활성 사용자 제외는 저장소 계층 테스트로 옮겨야 합니다. `stopSiwc` 실패 후 `stopping=true` 유지 시 재시작 의미가 문서화되지 않았습니다.
- **완료 기준:** app.stack 열거 테스트, 위 사례의 회귀 테스트 추가 및 ADR 0009에 SIWC 중단 후 상태 명시.

### [ ] 라우터 중단 전환 판정 보강
- **관련 Phase:** 4 — [ADR 0008](./docs/adr/0008-new-request-account-429-policy.md) 2026-11-09 개정
- **위치:** `src/upstream/forward-chat.ts` 바깥 catch, `src/upstream/inference.ts` `readWithAbort`
- **현재 상태:** 라우터 자체 중단 여부를 catch 진입 시점의 `signal.aborted`로 판정합니다. 공급자 실패가 매크로태스크 경계를 거쳐 전파되는 좁은 경로에서는 무기한 OPEN 대상이 60초 제한으로 바뀔 수 있습니다(비차단, 오판 방향은 완화 쪽). 2026-11-13 개정 뒤에는 공급자 실패도 60초 제한이라, 이 오판이 결과를 바꾸는 경우는 전송 결과를 보지 못한 발송뿐입니다. `terminalObserved` 가드, 401 재시도 중 중단, dispatch 전 중단은 직접 테스트가 없습니다.
- **완료 기준:** 중단 오류에 출처 표식을 달아 판정하고, 판정 로직 단위 테스트와 `BEFORE DELETE ... RAISE` 트리거 기반 settle 실패 주입 테스트를 추가합니다.

### [ ] 추론 시간 제한 보강
- **관련 Phase:** 4 — [ADR 0016](./docs/adr/0016-phase4-scope-freeze.md) 항목 3
- **위치:** `src/upstream/forward-chat.ts` `INFERENCE_TIMEOUTS`, watchdog
- **현재 상태:** 값은 export된 가변 상수(테스트 seam)입니다. `touch()`는 걸려 있는 단계를 구분하지 않습니다(실제 경로는 확인되지 않음). 비-ok 응답 뒤 재설정 시점이 일반(settle 후)과 SIWC(settle 전)에서 다릅니다. 느린 클라이언트로 drain이 무응답 제한을 넘으면 라우터 중단으로 처리되어 공급자 계정이 60초 제한을 받습니다(구 120초 정책과 같은 성격, ADR 0008 귀속 규칙 사안). 디스패치 전 승인 대기 제한과 쓰기 후 재설정은 직접 테스트가 없습니다. 실제 공급자의 heartbeat 간격과 추론 무음 시간은 미검증입니다.
- **완료 기준:** 운영자 설정화와 운영 값 freeze, 단계 세대 토큰, SIWC 승인 지연 테스트, 소비자 정체와 공급자 무음의 귀속 구분. `TransformStream`을 `node:stream/web`에서 명시적으로 import하고 `package.json` `engines`(현재 없음)에 Node 버전 하한 명시. 테스트 헬퍼 `tests/helpers/fresh-db.mjs`를 `.ts`로 옮기거나 테스트용 tsconfig로 타입 검사(현재 `src/upstream/*.test.ts`는 비리터럴 URL import로 rootDir 밖 헬퍼를 불러 타입 검사에서 빠짐).

### [ ] 종료 시 DB 정상 close의 전역 증명 (Phase 6으로 이연)
- **관련 Phase:** 6 — 운영 ([ADR 0016](./docs/adr/0016-phase4-scope-freeze.md))
- **위치:** `src/server.ts`, [ADR 0009](./docs/adr/0009-shutdown-deadline-database.md)
- **현재 상태:** 등록된 작업 drain 후에도 DB를 명시적으로 닫지 않고 5초 기한에 실패 종료합니다. 모든 DB 생산자의 추적은 증명되지 않았습니다.
- **작업:** 모든 생산자의 소유권 증명 후 정상 close·WAL checkpoint를 검토합니다.
- **완료 기준:** 실제 SQLite·소켓 환경에서 추적 누락 없이 drain 후 close되는지 검증합니다.

### [ ] 업스트림 미발송 실패 시 사용자 할당량 정책 검토
- **관련 Phase:** 4, 6 — 라우팅·사용자 통계
- **위치:** `src/auth/user-auth.ts`, `src/db/repositories/users.ts`, `src/upstream/forward-chat.ts`
- **현재 상태:** 사용자 할당량은 요청 접수 시 UTC 기준으로 예약하며 실패·취소에도 환불하지 않습니다. 모든 계정이 쿨다운 중인 503처럼 업스트림 호출이 없는 요청도 차감되어, 장애 중 반복 요청이 사용자의 한도를 소진할 수 있습니다.
- **작업:** 사전 발송 실패의 예외 여부와 운영자 표시·클라이언트 backoff를 검토합니다. 무조건적인 환불이나 인증 우회로 동시 요청의 한도 집행을 약화하지 않습니다.
- **완료 기준:** 선택한 정책의 경쟁 조건·실패·취소를 격리 테스트하고 사용자에게 할당량과 실제 추론 횟수 차이를 명확히 표시합니다.

### [ ] 추론 요청 및 스트림 정지 시간 제한
- **관련 Phase:** 5 — 클라이언트 호환
- **위치:** `src/upstream/inference.ts`, `src/upstream/forward-chat.ts`
- **현재 상태:** 독립 정적 리뷰에서 클라이언트가 연결을 유지한 상태로 업스트림 응답이나 스트림이 멈추면 서버 측 deadline이 없다고 지적했습니다. 이 항목은 해당 리뷰에서 실행 재현하지 않았습니다.
- **작업:** 최초 응답 대기와 스트림 유휴 시간에 대한 제한·취소 정책을 정하고 구현합니다. 스트림 출력이 이미 시작된 후의 오류 처리와 재시도 가능 시점을 구분합니다.
- **완료 기준:** 모의 업스트림의 응답 지연·스트림 정지·클라이언트 중단을 테스트하고, 리소스 정리와 클라이언트 오류 응답을 확인합니다.

### [ ] 429/5xx 계정 자동 전환
- **관련 Phase:** 4 — 라우팅과 자동 전환
- **위치:** `src/upstream/forward-chat.ts`, `src/account-pool/manager.ts`
- **현재 상태:** 단조 관찰 기반 429 제한을 작업본의 선택·발송 및 일부 응답 처리에 연결했고 일반 계정의 인증 경로에서 합성 시계 변경과 관찰자 재생성 사례를 격리 테스트했습니다. SIWC 전체 경로와 실제 파일·프로세스 재시작은 미검증입니다. 이미 발송된 같은 요청의 429/5xx 재전송은 구현되지 않았고 확인된 5xx의 쿨다운은 프로세스 로컬입니다. 전체 테스트와 실제 제공자 검증은 미완료입니다.
- **작업:** 사용자가 선택한 새 요청의 대체 계정 선택 정책을 유지하면서 5xx 공유 제한, 시계 변경과 불확정 OPEN의 안전한 복구를 완성합니다. 제공자의 실제 제한 범위와 약관상 허용은 별도 확인이 필요하며, 사용자 선택을 허용 증거로 취급하지 않습니다. 동일 요청 재발송은 별도 정책과 안전 근거가 필요합니다.
- **완료 기준:** 허용된 오류 유형별 전환과 후보 소진, 후속 요청 및 스트리밍 시작 전후 오류 처리를 격리 테스트하고 적용한 정책 근거를 기록합니다.

### [ ] 계정 일일 할당량 원자 집행 및 날짜 초기화
- **관련 Phase:** 4 — 라우팅과 자동 전환
- **위치:** `src/account-pool/manager.ts`, `src/db/repositories/accounts.ts`
- **현재 상태:** 독립 정적 리뷰에서 완료된 요청 수만으로 후보를 필터링해 동시 요청이 계정 한도를 초과할 수 있고 일일 초기화 호출이 없다고 지적했습니다. 해당 리뷰에서는 실행 재현하지 않았습니다.
- **완료 기준:** 격리 DB 및 다중 프로세스에서 동시 요청, 날짜 경계·재시작, 실패·중단과 기존 데이터 보존을 검증합니다.

### [ ] 사용자 quota와 관리 화면 사용량의 집계 기준 명확화
- **관련 Phase:** 4, 6 — 라우팅·운영 통계
- **위치:** `src/auth/user-auth.ts`, `src/db/repositories/usage-logs.ts`, `src/upstream/forward-chat.ts`
- **현재 상태:** Phase 3 리뷰에서 quota 예약량과 사용량 로그 집계가 실패·usage 누락·시간대에 따라 다를 수 있다고 지적했으며, 담당 에이전트가 차이를 재현했습니다.
- **완료 기준:** 예약·추론 시도·성공·토큰 사용량을 구분해 정의하고 일관된 시간대와 화면 표기를 테스트합니다.

## 운영·검증

### [ ] 사용 이력 대량 조회 성능 개선
- **관련 Phase:** 4, 6 — 라우팅·운영 통계
- **위치:** `src/db/repositories/usage-logs.ts`, `src/account-pool/manager.ts`, `docs/global-usage-index.md`
- **현재 상태:** UTC 오늘 통계는 범위를 사전 필터링하지만 전역 timestamp 선행 인덱스는 자동 생성하지 않습니다. 이력 페이지는 엄격한 날짜 파싱을 사용해 많은 일치 행을 정렬할 수 있습니다. 합성 10만 행 쿼리 측정은 운영 지연의 증거가 아닙니다.
- **작업:** 인덱스 또는 정규화 컬럼을 검토하되 기존 데이터 보존, 엄격한 날짜 해석, 페이지 순서, 오프라인 전환·기존 업그레이더 스키마 호환을 검증합니다. 운영 DB에 자동 적용하지 않습니다.
- **완료 기준:** 격리 DB에서 인덱스 유무 결과 일치, 실행 계획, 쓰기 비용 및 페이지 경계를 검증하고 별도 리뷰를 받습니다.

### [ ] 헬스체크와 의존성 준비 상태 분리
- **관련 Phase:** 6 — 운영 및 모니터링
- **위치:** `src/server.ts`의 `/health`
- **현재 상태:** `/health`는 프로세스 응답성(liveness) 확인이며 DB 등 의존성 준비 상태를 보장하지 않습니다.
- **작업:** 운영에 필요한 경우 별도 readiness 검사와 장애 응답 정책을 설계합니다.
- **완료 기준:** 정상·의존성 장애 상황에서 liveness와 readiness가 의도대로 구분되는지 검증합니다.

### [ ] 운영 배포·마이그레이션 안전성 검증
- **관련 Phase:** 2, 6 — 저장소와 인증·운영
- **위치:** `src/db/client.ts`, [REFRESH-SAFETY.md](./REFRESH-SAFETY.md)
- **현재 상태:** 격리 DB에서 마이그레이션과 동시 시작 회귀 테스트를 실행했지만 운영 DB에 적용하거나 실제 복구 절차를 검증하지 않았습니다. refresh intent의 보호는 같은 SQLite DB와 새 구현을 사용하는 프로세스에 한정됩니다. 상세 운영 제약은 별도 안전 문서를 따릅니다.
- **작업:** 운영 적용 전 백업·복원과 마이그레이션 절차를 검증하고, 기존 프로세스와 새 프로세스 혼용 및 이전 DB 복원의 위험을 관리합니다. 영구 intent의 안전한 보존·정리 정책도 검토합니다.
- **완료 기준:** 격리된 백업 사본에서 데이터·사용 로그·참조 보존과 복원 절차를 확인하고, 실제 운영 적용 전 필요한 중단·백업 절차를 문서화합니다.

### [ ] 종료·만료 경계 테스트 보강
- **관련 Phase:** 3, 6 — 구독 계정 연결·운영
- **현재 상태:** Windows 테스트는 실제 OS 종료 신호 전달 대신 자식 프로세스 내부의 신호 이벤트를 사용한 것으로 보고됐습니다. 마지막 JWT 리뷰에서는 동시 일반 요청의 단일 refresh와 `exp == now` 경계를 직접 확인하는 테스트가 보강 가능하다고 했습니다.
- **작업:** 실제 OS 신호 전달을 안전하게 검증할 수 있는 격리 테스트와 JWT 경계·동시 요청 테스트를 추가합니다.
- **완료 기준:** 테스트가 실제 종료 전달 및 경계 동작을 검증하고, 사용자 프로세스·운영 DB에는 영향을 주지 않습니다.

## 429 v2 테스트 기대값 리뷰 잔여 (2026-11-10, deleg_b12409ce)

비차단 지적. 7번(arm 실패 주입)은 반영 완료(`phase4-ordinary-open-safety`, 변형 검출 확인).

- **레거시 쿨다운 → v2 변환 없음 (마이그레이션 차단 항목):** 업그레이드 시점에 `account_429_cooldowns`에 남은 미만료 쿨다운은 v2로 옮겨지지 않아 즉시 선택 가능해진다. 오프라인 마이그레이션(ADR 0008, 현재 명령 비활성)에서 변환하거나 폐기를 ADR에 명시할 것.
- 운영 경로 전반에서 레거시 테이블 쓰기 0건을 단언하는 회귀 테스트 1개; `client.ts`의 레거시 스키마 생성·검증 정리.
- v2 만료 서비스를 가짜 단조 시계로 실제 호출하는 SIWC 경로 테스트(현재 `siwc-cooldown-http`는 DELETE로 만료를 대신함).
- v2 스키마 위반 시 스냅샷 `unknown` + 선택 차단(fail-closed) 단언, 비정상 `duration_ms` 처리 단언.
- 앵커 있는 **과거** HTTP-date Retry-After가 null(무기한)이 되는 것이 의도인지 결정; `Retry-After 120` 상한 단언.
- `siwc-refresh-admission` 워커: 장벽 발동 1회·갱신 토큰 확인 단언, 갱신 전 게이트에서 arm하는 별도 사례.
- `quota-reselection-provenance` VM 스텁: 레거시 쿼리는 빈 결과로 바꾸고 v2 쿼리에서만 차단.
- SIWC transport 실패(502) 사례: 다음 요청 503(OPEN), Retry-After 미전송 단언.

## 테스트 복구 2차 리뷰 잔여 (2026-11-10, deleg_b49e1a77)

반영 완료: E(ADR 0017 기록, 라우트 수준 멈춘 취소 사례 추가), A(`usage` 키 유무로 분기하는 소비자 없음 확인, `if (e.usage)`만 사용), B(유효 행 누적 합 초과 사례), G(해당 계정의 5xx 제한 존재를 확인한 뒤 그 계정 행만 삭제).

비차단 잔여:
- B 음성 대조를 user/account 집계별 단일 변형으로 분리; API 문서에 `totalTokens`=확인분 합(불완전 시 하한) 명시.
- C `siwc-fence-abort-contention`: 응답 상태·lock 해제(후속 요청 진행) 단언, "발송 후 취소 → aborted=1" 양성 대조 존재 확인.
- D 잘린 스트림 테스트에 같은 픽스처 완전판 성공 쌍 대조, 502·비브랜드 단언.
- F 동기 시작 실패가 로컬 SIWC 백오프를 건다는 사실을 해당 사례에서 직접 단언.
- G "제한 중 두 번째 실행은 발송 없이 503" 동작을 별도 사례로 고정; 레거시 쿨다운 행 무시 사례 별도 유지 여부 결정.
- H `adaptLegacySelect` 경로에서 스텁 호출 횟수 단언; 장기적으로 테스트가 `selectCandidate`를 직접 스텁하도록 이전.
- I 발송 시점 자격·revision이 변경 전 값이고 관리자 변경은 그 뒤 커밋됐다는 순서 단언.
- J 카운터 최댓값 상태 격리(finally 복원 외), 이후 요청에서 해당 계정 미선택 단언.
- K done 시점 `fetchCalls ≥ 1`, `terminal()` 정확히 1회 단언.
- ADR 0017 한계: 멈춘 취소의 소켓 회수(장시간·대량) 미검증.

## 기존 DB 업그레이드 경로 (ADR 0018, 2026-11-10)

Phase 4는 안전 스키마(429 v2, OPEN 표식)가 없는 기존 DB를 거부만 한다. 기존 DB를 계속 쓰려면 아래가 필요하다.
- 꺼져 있는 업그레이드 스크립트(`scripts/offline-429-upgrade.mjs`, `scripts/offline-open-upgrade.mjs`)를 v2 스키마와 `db:init` 방식에 맞춰 갱신. 업그레이드된 DB가 현재 `initDatabase`를 통과해야 함.
- 레거시 `account_429_cooldowns`의 미만료 쿨다운을 v2 제한으로 변환(1차 리뷰 6번 지적).
- 보류된 사례 13개 재활성화(마커 손상 거부 분리본 포함): `credential-revision-migration`, `state-revision-migration`(2), `siwc-acl-migration`, `siwc-routing-migration`, `phase2-quota-offline-cutover`, `migration-concurrent-regression`, `phase4-offline-open-upgrade`(5). 사유 상수는 `tests/helpers/upgrade-deferred.mjs`. 이 중 앞 세 파일 일부와 뒤 두 파일은 Windows EPERM도 겹쳐 있어 재활성화 시 별도 확인 필요.
- 스크립트 활성화(`OPERATIONALLY_ENABLED`)는 ADR 0013에 따라 별도 승인 필요.
- ADR 0018 리뷰(deleg_2c1c4d8d) 비차단 잔여: 프로비저닝 실패 시 파일 정리 경로 테스트(장애 주입), `db:init`이 실패해도 만든 상위 폴더는 남음, env.ts 단계에서 메모리·`file:` 경로 조기 거부 검토, skip된 업그레이드 성공 사례마다 "현재 클라이언트가 v2 없는 업그레이드 결과물을 변경 없이 거부" 대체 단언.
- 업그레이더 거부 테스트의 대조군 부재(재리뷰 deleg_e6dcab07): 현재 `offline-open-upgrade.mjs`는 손상되지 않은 v2 기준 DB도 같은 일반 메시지로 거부한다. 그래서 `phase4-offline-open-upgrade`의 마커 손상 거부 사례(분리본 포함)는 보류했다. 업그레이드 경로를 고칠 때 "손상 없는 사본은 성공" 대조군과 사례별 거부 사유를 함께 넣어 재활성화한다. 강제 종료로 커밋 전 0바이트 파일이 남은 경우 `db:migrate` 동작도 장애 주입 테스트로 확인한다.
- async-writer 메모리 분기 정리(재리뷰 deleg_69301280 S1): 운영에서 도달할 수 없는 `shared.name === ':memory:'` 분기를 제거하거나 불변식으로 throw하게 바꾼다. `db-lifecycle-reentrancy-memory`의 가짜 핸들을 임시 파일 기반으로 바꿔 이름이 설정 경로와 같게 하고, 모든 모드가 별도 writer 연결 경로(운영 경로)를 타게 한다. 그 전까지 해당 테스트의 `:memory:` 모드는 운영 writer를 검증하지 않는다.


## 종료 drain 리뷰 잔여 (2026-11-10, deleg_385d22f7)

비차단 지적 N2~N12. 상세는 `docs/db-producer-inventory.md` '남은 일'에 있다.
- `initDatabase` 종료 후 재초기화 거부 테스트
- 만료 스케줄러 `lockedNow` 비교 정리(도달 불가)
- 가짜 writer, 가짜 transaction, 가짜 safeIntegers 계약 보강
- 고정 대기 제거, keep-alive 503 사례
- (우선, deleg_c917dad4 N-c) keep-alive 유휴 연결 때문에 정상 종료가 5초 제한에 걸려 종료 코드 1이 될 수 있음. `closeIdleConnections()`와 drain 중 `Connection: close` 적용 및 테스트
- `phase1-server` 추적 라우트를 실제 `trackedRoute`로 교체, 'stalled token exchange' 불안정성 확인


## Phase 4 보류 테스트 → Phase 6 테스트 정리 (2026-11-10, 사용자 승인)

최종 확인은 run11이다. 264개 중 238개 통과, 새 실패 0개, 아래 26개 보류.
**E 묶음은 다음 Phase 시작 전에 가장 먼저 확인한다.** keep-alive 종료 지연(위 '종료 drain 리뷰 잔여')도 우선순위가 높다.

run10: 264개 파일 중 235개 통과. run9(228) 대비 새로 실패한 파일 0개. phase4-siwc-vertical은 run5에서도 같은 barrier timeout으로 실패했고, 단독 9회 중 1회 실패했다(간헐).
run10 이후 고친 것: admin-account-routing-validation 2/2(가짜 requestWork에 ownedDispatch 추가), phase4-siwc-reusable-gate 1/1(DATABASE_URL 합성 값).
보류 후보: 26개.

## A. 요청 처리·Express 연속성 이전 명세 (10)
request-work-capability, request-work-express4(timeout), request-work-lifecycle, request-work-ownership-regression(timeout), request-lease-express-red, controlled-ingress, controlled-ingress-errors, express-error-work(timeout), v1-local-error-terminal, application-shutdown-auth-continuation
사유: ADR 0009/0010 이후 설계(오류 원본 비노출, 종료 후 자식 작업 승인 차단)와 충돌하는 기대가 섞여 있다. 사례별로 현재 계약으로 옮겨야 한다. application-shutdown은 env 의존성을 넣자 timeout으로 바뀌어 되돌렸다.

## B. 실험 코드 (6)
experimental-429-coordinator(존재하지 않는 모듈을 기다리는 RED 테스트), experimental-429-scheduler-contention, experimental-429-scheduler-integration, experimental-atomic-429-app, experimental-atomic-429-settle-process, experimental-atomic-429-settle-rollback
사유: 운영 경로에서 쓰지 않는 실험 모듈이다.

## C. 가짜 better-sqlite3로 client.ts를 불러오는 테스트 (2)
ordinary-conflict-sqlite(21개 실패), sqlite-lifecycle-races(7개 실패)
사유: client.ts의 fileMustExist, 메모리 DB 거부(ADR 0018) 이후 가짜 DB 계약이 맞지 않는다.

## D. 레거시·업그레이드 경로 (3)
phase2-repository(레거시 재구성), real-app-429-compatibility(레거시 계획을 v2 저장소가 거부), phase2-quota-process(Windows EPERM, 레거시 UTC)
사유: ADR 0018에서 기존 DB 업그레이드를 보류했다.

## E. 운영 안전 속성 가능성 — 보류하되 우선 확인 표시 (5)
oauth-refresh-http-cancel(timeout), oauth-refresh-intent-boundary('unknown commit outcome remains fenced…'), phase2-quota-http(timeout), phase4-least-used-utc-http(테스트 하네스 자식 정리), phase4-ledger-quota-atomic('fails closed when commit is applied but its acknowledgement is lost')
사유: 실패 메시지는 결함 주입 지점에 도달하지 못했다는 내용이다. 테스트 하네스 문제로 추정하지만 확인하지 않았다. 커밋 결과 불명 시 fail-closed 속성이라 다음 Phase 시작 전에 먼저 본다.

## 간헐 (1)
phase4-siwc-vertical: 8초 barrier 안에 워커 2개를 띄우는 테스트. 부하 시 실패.


## Phase 5 전 게이트 리뷰 잔여 (2026-11-10, deleg_51f08aa9)

- **(우선) 토큰 갱신 응답 본문이 끝나지 않을 때 refresh flight가 무기한 대기할 수 있음.** `oauth-refresh-http-cancel` 조사 중 관찰했고 확인은 아직 안 했다. 그 계정의 요청이 모두 묶이고, 종료 시 drain이 5초 제한에 걸려 종료 코드 1이 된다. refresh fetch의 시간 제한이 본문 읽기까지 덮는지 확인한다.
- keep-alive 종료 보강 테스트를 추가한다.
  - (i) 종료 전에 이미 쉬고 있던 keep-alive 연결이 있을 때 빠르게 종료 코드 0으로 끝나는지
  - (ii) 종료 후 기존 keep-alive 소켓으로 보낸 요청이 503을 받고, 연결이 닫히고, 종료 코드 0인지
  - (iii) 느린 클라이언트의 큰 응답 본문이 다른 요청 종료 때문에 잘리지 않는지. 구현은 각 응답 자신의 소켓만 `end()`(버퍼를 비운 뒤 종료)하도록 바꿨다.
- writer 밖에서 쓰기를 시도하면 busy_timeout(5초) 동안 이벤트 루프가 동기로 막힌다. writer 밖 쓰기 경로를 막는 정적 검사나 테스트 가드를 둔다.
- `oauth-refresh-http-cancel`: 각 사례 뒤에 남은 refresh flight가 0인지 단언한다(사례 사이 오염 탐지).
- `phase2-quota-http` 사례 5: 공유 v2 5xx 제한이 기록됐는지 단언한다.
- `phase4-least-used-utc-http`: poison 워커가 ready 이후 비협조 상태에서 정리되는지 확인한다.

## Phase 5 이후 추가 개발 (2026-11-10, 사용자 결정, ADR 0019)

- **교차 공급자 변환(1B):** Claude Code(`/v1/messages`)로 OpenAI 계정, Codex(`/v1/responses`)로 Anthropic 계정 사용. Phase 5 완료 후 별도 ADR로 손실 범위(thinking 서명, 도구 형식, 캐시)와 완료 조건을 정하고 진행한다.
- `/v1/messages/count_tokens`, `/v1/models` 탐색, Codex WebSocket·원격 압축, SIWC 계정의 새 엔드포인트 사용, 10MB 초과 본문.

## Phase 5 1차 리뷰 잔여 (2026-11-10, deleg_aec37528)

- **(결정됨, ADR 0019 6번) 유료 서버 도구:** 막지 않고 그대로 전달한다. API 키 계정 비용은 구독마다 미리 지급된 크레딧 범위에서 나간다. 이전 메모 두 가지를 고친다. 이 도구들은 베타 헤더가 아니라 본문 `tools` 목록으로 켜진다. 사용자 한도는 토큰이 아니라 요청 횟수 기준이다. 남은 선택 과제: 응답 사용량(`usage.server_tool_use.*`, `web_search_call` 항목)으로 사용자별 도구 호출을 기록하고 상한 두기.
- **(ADR 0020으로 구현) 크레딧 소진 계정 처리:** API 키 계정이 `/v1/messages`·`/v1/responses`에서 소진 오류를 받으면 `error` 상태가 되고 소진 안내 문구가 남는다. 관리자가 직접 켜야 다시 쓰인다. 남은 일은 세 가지다.
  - `/v1/chat/completions` 경로는 오류 본문을 버리는 Phase 4 설계라 판정하지 않는다. 필요하면 짧은 시간 제한을 두고 본문을 읽어 판정한다.
  - 소진을 감지한 그 요청은 다른 계정으로 다시 보내지 않는다(ADR 0019 범위 밖).
  - 실제 소진 응답으로 판정 조건을 확인해야 한다(Anthropic 400 문구는 공식 문서에 없음).
  - (deleg_158084f8 C) 재활성화 때 429 제한을 풀지는 사람이 읽는 소진 문구를 정규식으로 맞춰 정한다. 문구를 바꾸면 해제가 조용히 꺼진다(테스트가 잡기는 한다). 나중에 `disabled_reason` 같은 구조화된 컬럼으로 옮긴다.
  - (deleg_158084f8 F, ADR 0008의 기존 공백) 무기한 429 제한(`duration_ms` NULL)을 관리자가 푸는 일반 경로가 없다. 지금은 소진으로 꺼진 계정을 다시 켤 때만 풀린다.
  - (deleg_91e457f2 D 잔여) `reactivate()` 안의 `update()`는 넘겨받은 `db`가 아니라 `getDb()`를 쓴다. 운영에서는 같은 연결이지만, 다른 연결을 넘기는 호출자가 생기면 트랜잭션 밖에서 실행될 수 있다. 또 PATCH 라우트는 현재 상태를 트랜잭션 밖에서 읽는다. 관리자 두 명이 동시에 수정하면 필드 변경이 빠진 채 200이 나가거나, `last_error`와 제한이 남을 수 있다. 상태 판정을 트랜잭션 안으로 옮기면 해결된다.
- 느린 클라이언트 때문에 `drain`을 300초 넘게 기다리면 무응답 제한이 발동하고, 계정이 60초 제한을 받는다. chat 경로도 같다.
- `/v1/messages/count_tokens`가 없어서 Anthropic 형식의 404가 아니라 서버 기본 404를 돌려준다. 클라이언트는 추정치로 대체해서 동작은 한다.
- 세션 친화성 없음: 대화 도중 계정이 바뀌면 `previous_response_id`, `encrypted_content`, thinking 서명이 다른 계정에서 거부될 수 있다. `x-claude-code-session-id`·`session_id` 기준으로 같은 계정에 고정하는 방안을 검토한다.
- Codex 구독 백엔드가 요구하는 본문 조건(`store:false` 등)은 실제 계정으로 확인해야 한다(완료 조건 6).
- 앞서 등록한 토큰 갱신 무기한 대기 의심 건: `refreshTokens`는 `AbortSignal.timeout(10_000)`을 걸고 `res.text()`까지 같은 signal 아래에서 읽는다. 그래서 실제 fetch에서는 10초로 끝날 가능성이 높다. 테스트에서 멈춘 건 가짜 fetch가 signal을 무시했기 때문으로 보인다. 아직 확인하지 않았다.
- (deleg_5fe04403) 본문을 읽는 단계(express.json)에서 난 오류(잘못된 JSON 400, 너무 큰 본문 413, 지원하지 않는 charset 415)는 `/v1/messages`에서도 Anthropic 형식이 아니라 `{error:{type,message}}` 형식으로 나간다. 상태 코드는 4xx로 맞다. 고치려면 server.ts 오류 처리기가 경로를 보고 형식을 고르게 한다(VM 테스트 의존성에 주의).
- 중복 키 검사 함수의 경계 검사는 JSON.parse 전제 때문에 테스트에서 도달하지 못한다. 경계 검사를 빼는 변형을 해도 테스트가 실패하지 않는다. 방어용으로 남겨 둔다.
- admin 종료 테스트 두 개(account, user)는 전체 실행 안에서 25~27초가 걸린다(혼자 돌리면 7~12초). 강제 종료 제한을 60초로 늘렸기 때문에 종료가 느려지는 회귀는 이 테스트로 잡기 어렵다.

## Claude API 키 종류 (2026-11-12, 실제 확인 중 발견)

- Console이 이제 개인 키(`sk-ant-usr-`)를 발급한다. 가져오기와 전송이 `sk-ant-api`만 받던 것을 `sk-ant-`로 시작하는 키 전체로 넓혔다. OAuth 토큰(`oat`, `ort`), claude.ai 세션 쿠키(`sid`), Admin 키(`admin`)는 제외한다. Claude 키를 OpenAI 계정으로 등록하거나 OpenAI로 보내는 것도 막았다. 서비스 계정 키의 접두사는 공식 문서에 없어서 확인하지 못했다.
- **워크스페이스를 지정하지 않은 키는 지원하지 않는다.** 공식 문서상 이런 키는 요청마다 `anthropic-workspace-id` 헤더가 필요하다. ShareAI는 클라이언트가 보낸 이 헤더를 차단하고(풀 계정 보호), 계정에 워크스페이스 ID를 저장하는 기능도 없다. 지금은 공급자의 400을 감지해 계정을 `error`로 바꾸고 안내 문구를 남긴다(ADR 0020 추가 항목). 필요하면 계정별 워크스페이스 ID를 저장해서 라우터가 헤더를 붙이게 한다.
- (deleg_76598e69) `/v1/chat/completions` 경로는 워크스페이스 미지정 키도 판정하지 않는다(오류 본문을 읽지 않는 Phase 4 설계). 그 경로만 쓰는 클라이언트에게는 400이 계속 나가고 계정은 켜진 채로 남는다. 현재 동작은 테스트로 고정했다.
- (deleg_76598e69) 전송 직전에 키 문자를 검사하므로, 예전에 검증 없이 저장된 Claude API 키(끝에 공백이 붙은 값 등)는 요청마다 라우터 400이 된다. 이 400은 계정 실패로 기록되지 않아 계정이 풀에 남는다. 운영 DB를 옮길 때 저장된 Anthropic `api_key` 자격증명을 새 규칙으로 한 번 점검한다.
- (deleg_617cf01e) 전체 일치는 공급자가 문구를 한 글자만 바꿔도 감지가 조용히 빠진다. 앞부분은 맞는데 전체가 다른 400을 상태 변경 없이 횟수만 세거나 경고로 남기면 알아챌 수 있다. 메시지 원문은 클라이언트가 정할 수 있으므로 기록하지 않고 빈도도 제한한다.
- (deleg_76598e69, deleg_7b488d6f) 소진·워크스페이스 400 판정은 공급자 메시지 전체 일치에 의존한다. 실제 400 본문을 받으면 상수와 테스트 픽스처를 그 전문으로 고정한다. 문구에 의존하지 않으려면, 의심스러운 400을 받았을 때 라우터가 고정 본문으로 직접 확인 요청을 보내 같은 오류가 재현될 때만 계정을 끄는 방법이 있다(구현 범위가 크다).
- (deleg_f1643676) 구독 계정 쪽에는 대칭 검사가 없다. `credentials.json` 형식 안의 `accessToken`에 API 키가 들어 있으면 Bearer와 OAuth 베타 헤더로 전송된다.
- 계정 이름 중복을 알려 주는 것은 `POST /admin/accounts/import`뿐이다(409 `account_name_taken`). 나머지 두 등록 경로는 그대로다.
  - 브라우저 로그인(`/admin/accounts/oauth/start` → `finish`): 이름이 이미 있어도 시작 단계에서 막지 않는다. 브라우저 로그인을 끝낸 뒤 저장 단계에서 실패하고, 사유 없이 `Login failed; ...`만 나온다. 시작 단계에서 이름을 먼저 확인하고, 저장 단계 실패에도 같은 사유 코드를 싣는다.
  - `POST /admin/accounts`: 이름이 중복되면 500 `Failed to process admin account request`가 나온다.
- 가져오기 형식 오류는 사유 코드가 하나(`credential_format_unrecognized`)다. JSON이 중간에 잘린 경우("파일 내용을 전부 복사했는지")처럼 파서가 구분하던 세부 사유는 응답에 나오지 않는다. 다시 헷갈리면 코드를 나눈다.
- 가져오기 사유 판정은 저장 단계 전체(DB 연결, 암호화, INSERT)를 한 단계로 본다. SQLite의 `UNIQUE constraint failed: upstream_accounts.name` 오류만 이름 중복으로 보고, 그 밖의 저장 실패는 계속 `Could not import credentials`(400)로 나간다. 서버 쪽 실패인데 400인 점은 그대로다.
- (실제 확인 2026-11-13) `/v1/chat/completions` 경로(`inference.ts`)도 `text/event-stream`이 아니면 502로 거부한다. Codex 구독 백엔드는 `Content-Type` 없이 스트림을 보내므로, 이 경로로 Codex 구독 계정을 쓰면 같은 이유로 실패할 것이다(실제 계정으로는 미확인). `/v1/responses`에만 예외를 넣었다(ADR 0019 7번).
- (실제 확인 2026-11-13) 공급자가 2xx로 답했는데 라우터가 응답을 읽지 못하면(형식 불일치, 깨진 스트림) 그 시도는 불확실한 것으로 남아 계정이 `open`으로 무기한 묶인다. 풀려면 서버를 끄고 `scripts/offline-open-recovery.mjs`를 써야 한다. 라우터가 스스로 끊은 요청처럼 60초 제한으로 바꿀지는 정책 결정이 필요하다(ADR 0008). → **2026-11-13 결정·구현:** 발송 뒤 네트워크 실패와 읽을 수 없거나 깨진 2xx 응답은 60초 제한으로 바꾼다(ADR 0008 개정).
- (ADR 0008 2026-11-13 개정의 남은 일) 서버를 끄지 않고 관리자가 OPEN을 푸는 기능이 없다. 전송 결과를 보지 못한 발송, 정산 실패, 프로세스 종료로 남은 OPEN은 여전히 `scripts/offline-open-recovery.mjs`가 필요하다. Phase 6(운영)에서 다룬다.
- (같은 개정의 알려진 단점) 공급자 쪽 원인이 계속되면 계정이 60초마다 돌아와 사용자 요청을 하나씩 더 실패시킨다. 연속 실패 backoff(최대 5분)는 프로세스별 메모리에만 있다. 같은 실패가 반복될 때 공유 제한을 늘리거나 관리자에게 알리는 방법을 검토한다. 실제 발생 빈도는 측정한 적이 없다.
- (같은 개정, 리뷰 deleg_dc079a81) 원인이 공급자가 아니라 요청일 수도 있다. 레거시 채팅 경로가 표현하지 못하는 출력(도구 호출, 오디오, reasoning)을 내는 요청은 어느 계정에서나 같은 방식으로 실패하므로, 한 클라이언트가 그 요청을 반복하면 계정을 하나씩 60초 제한에 넣는다. 요청 원인으로 판정할 수 있는 실패는 계정을 쉬게 하지 않는 방법을 검토한다.
- (같은 리뷰) 60초 제한으로 바꿀 때 공급자 연결을 확실히 끊지는 않는다. 스트림 검증기와 형식 거부 경로는 본문을 취소하지만 그 밖의 예외 경로는 보장이 없다. 전환 직전에 요청의 중단 신호를 거는 방법은 사용 기록의 중단 표시와 실패 기록 조건을 함께 바꾸므로 따로 설계한다.
- (같은 리뷰) 일반 계정 경로는 fetch가 응답 객체가 아닌 값을 돌려준 경우를 따로 거르지 않는다(SIWC 경로는 거른다). 실제 fetch에서는 생기지 않고 테스트용 가짜 fetch에서만 나온다.
- (같은 리뷰) 발송 단계에서 fetch가 동기적으로 예외를 내면 요청이 나가지 않은 것이 확실한데도 OPEN이 무기한 남는다(기존 동작).
- (같은 개정에서 확인) 발송 단계가 네트워크 호출을 시작한 뒤 실패하면 그 호출의 응답은 아무도 읽거나 취소하지 않는다(기존 동작). 이 경우 OPEN은 무기한으로 남는다.
- (실제 확인 2026-11-13) 계정 하나는 한 번에 요청 하나만 처리한다. Codex CLI는 질문 하나에 요청 두 개를 동시에 보내서(본 대화와 보조 스레드), 켜진 계정이 하나면 두 번째가 503을 받고 재시도한다. 계정당 동시 요청 허용은 Phase 4의 시도 단위 설계를 바꾸는 일이다.
- "쓸 수 있는 계정 없음" 503은 Claude Code 형식에서 오류 종류가 `overloaded_error`로 나간다(`routerErrorBody`). Claude Code는 이를 일시적 과부하로 보고 10번 재시도한 뒤 "Repeated 529 Overloaded errors"를 보여 준다. 계정이 `error`·`disabled`라서 기다려도 풀리지 않는 경우와 Esc 뒤 60초 제한처럼 곧 풀리는 경우를 구분해서 보낸다. 실제 확인 중 발견(2026-11-13). → **2026-11-14 구현(ADR 0019 8번):** 곧 풀리면 429 + Retry-After, 관리자가 고쳐야 하거나 5분을 넘으면 403. 클라이언트 화면 확인은 남음.
- (ADR 0019 8번의 남은 일) 끝나지 않는 OPEN이나 토큰 갱신 표식도 "5초 뒤 재시도"로 보인다. 429 v2 제한의 남은 시간은 추적하지 않아 걸린 시간 전체를 알려 준다. SIWC 계정을 직접 지정한 요청과 발송 직전 상태가 바뀐 요청은 여전히 503이다. `src/routes/routing-snapshot.ts`에는 SIWC 판정 사본이 따로 있어 공용 `siwcChecks`와 어긋날 수 있다.
- 접두사 규칙은 `oauth.ts`, `inference.ts`, `passthrough.ts` 세 곳에 같은 정규식으로 적혀 있다. VM 테스트의 의존성 허용 목록 때문에 공유 모듈로 빼지 않았고, 세 곳이 같은지는 테스트가 비교한다.
