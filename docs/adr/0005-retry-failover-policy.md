# ADR 0005: 안전한 다계정 요청 재시도와 장애 전환

- **상태:** 제안 — Phase 4 미완료, 구현·독립 리뷰·검증 필요. 아래 "총 120초 deadline 공유"는 [ADR 0016](0016-phase4-scope-freeze.md)의 첫 응답 + 무응답 제한 방향으로 대체됐다(2026-11-09).
- **작성일:** 2026-10-30
- **범위:** `/v1/chat/completions`의 단일 논리 요청 내 재전송 및 계정 전환. 계정 선택과 제공자 간 변경을 구분한다.
- **선행 결정:** [ADR 0002](0002-account-pool-access-control.md), [ADR 0003](0003-siwc-logout-fencing.md). 이 문서는 제공자 승인이나 약관 적합성을 주장하지 않는다.

## 배경과 현재 구현

관리자가 권한을 부여한 여러 계정을 여러 사용자가 사용할 수 있는 것이 제품 목표다. 이것은 **새 요청을 보내기 전** 적격 계정을 선택하는 것과, **이미 보낸 같은 요청**을 다른 계정에 다시 보내는 것이 같다는 뜻이 아니다. 후자는 중복 추론·과금, 외부 효과, 다른 결제 주체와 정책 제한 회피 위험이 있다. 사용자의 자동 선택 의사와 관리자의 공유 설정은 제공자의 허가를 대신하지 않는다.

현재 작업 트리의 `src/upstream/forward-chat.ts:38-112`는 자동 선택 시 한 후보를 고르고 다른 계정으로 재시도하지 않는다. 일반 OAuth 경로에는 최초 `infer`가 HTTP 401을 내고 refresh 가능할 때 **같은 계정**을 강제 refresh 후 한 번 재호출하는 별도 예외가 이미 있다. SIWC에는 이 예외가 없다. 이 기존 401 재전송도 아래 신규 안전 게이트와 예산에 맞게 별도 검토해야 하며, 현재 안전성이 검증됐다고 가정하지 않는다.

`infer`는 비정상 HTTP 응답의 본문을 취소하고 일반 메시지와 헤더만 전달하며, SSE 실패는 iterator 소비 중 발생한다(`src/upstream/inference.ts:46-70`). 스트리밍 응답은 iterator 소비 **전에** assistant role 프레임을 쓰므로 그 시점에 헤더와 바이트가 커밋된다(`forward-chat.ts:113-123`). `getCandidates`의 쿨다운과 라운드로빈은 프로세스 로컬이고, 전부 쿨다운이면 가장 이른 계정을 선택한다(`src/account-pool/manager.ts:31-33,66-70`). SIWC 선택은 접근 정책을 검사하지만 일반 후보는 `selectAccount`에서 `userId`를 필터에 사용하지 않는다(`manager.ts:81-124`); 일반 계정 ACL은 실제 의도와 스키마를 확인하고 보강해야 한다. SIWC 발송은 접근과 credential snapshot을 writer 안에서 다시 확인하고 시작한다(`forward-chat.ts:71-96`). 사용자 일일 quota는 인증 시 원자적으로 논리 요청당 예약된다(`src/auth/user-auth.ts:116-120`, `src/db/repositories/users.ts:104-119`); 물리 발송당 예산은 별도로 없다. 이 관찰은 구현 진행 중인 작업 트리의 한 시점이며 완성 보장이 아니다.

## 검토한 선행 구현과 근거

- OmniRoute의 `retryAfterInstant`는 미래 retry 힌트를 초 단위 대기와 ISO 시각으로 정규화하고, 없거나 잘못됐거나 과거이면 생략한다.[1] `classify429`는 본문 패턴과 일부 구조화된 delay로 rate limit과 quota exhaustion을 휴리스틱으로 구분하고, 불명확한 429는 rate limit으로 기본 분류한다.[2] **이 분류나 시간 힌트는 다른 계정 재발송의 허가 또는 미실행 증거가 아니다.** 패턴 오분류 가능성이 있고 본 프로젝트의 현재 HTTP 에러 경로는 분류에 필요한 본문을 보존하지 않는다.
- opencodex의 `generic-account-failover`는 2개 이상 등록된 OAuth 계정을 reactive 429 전환에 대한 운영자 의사로 취급하고, 요청당 failover와 계정 수를 제한하며 OpenAI와 Anthropic은 별도 경로로 제외한다.[3] 그 선택을 이 제품의 제공자 허가로 일반화하지 않는다. 별도 `request-resend-gate`는 관찰된 출력과 실행 불확실성을 구분하고, 불확실한 재전송에 한정된 운영자 예외를 모델링한다.[4] 본 결정은 그 예외도 채택하지 않는다.
- OpenAI SIWC 문서는 plan usage 오류가 추론을 중단하며 다른 결제 경로로 조용히 바꾸지 말라고 한다. 특히 `subscription_sharing_usage_limit_exceeded`는 사용자의 plan 요청을 일시 중지하고 usage 설정을 안내하며, 코드만으로 전체 plan 소진이나 reset 시각을 추정하지 말라고 명시한다.[5] 다계정 등록 및 사용자가 선택하는 account picker는 설명하지만, 이를 자동 429 전환의 허가로 읽지 않는다.[6]

## 결정

### 선택과 계약

1. **명시적인 계정 ID는 고정한다.** 해당 요청에서 계정 접근 거부, 미존재, 비활성, credential 오류, quota, timeout 또는 기타 실패 시 다른 계정이나 결제 경로로 전환하지 않는다. 권한 없는 ID와 미존재 ID는 존재를 노출하지 않는 동일한 응답으로 처리한다. 같은 계정의 재전송도 아래 게이트를 통과해야 하며, 현 401 refresh 예외를 무조건 승인하지 않는다.
2. 자동 모드의 **최초 발송 전**에는 관리자가 공유하고 사용자가 접근 가능한 활성 계정 중 동일 provider, 모델·옵션·프로토콜·자격 유형 및 정책에 적합한 계정을 기존 priority/round-robin/least-used 전략으로 선택할 수 있다. 다른 제공자, 모델, 결제 주체 또는 SIWC↔API key 변경은 호환성만으로 허가되지 않는다. SIWC 오류 뒤 다른 billing path 자동 전환은 금지한다.[5] 사용자 선택과 계정별 공유 설정은 별도 유지하며 SIWC의 계정 등록과 자격증명을 섞지 않는다.[6]
3. **같은 요청의 자동 계정 전환은 기본 비활성**이다. 관리자 opt-in은 필요조건일 뿐 충분하지 않다. 정확한 provider, endpoint, credential/billing 경계, 오류 signature별로 (a) 제공자 계약이 그 전환과 결제 경로를 허용하고 (b) 해당 실패가 원격 실행 전에 확정적으로 거절됐다는 근거를 문서화하고 (c) 요청이 재생 가능하며 (d) 아래 발송·커밋·ACL·quota 조건을 모두 만족하는 allowlist만 활성화한다. 현재 이 ADR에서 승인된 signature는 **없다**. 같은 계정 재시도도 (b)~(d)와 제공자 정책을 만족해야 한다. 제공자별 근거를 찾지 못하면 fail closed 한다.
4. 429는 자동 전환 허가가 아니다. 사용자 일일 quota 429는 업스트림 발송 자체를 하지 않는다. upstream 429, rate limit, billing/quota 및 SIWC limit은 원본에 맞는 제한을 사용자에게 전달하고 기다림 또는 명시적 사용자 조치를 안내한다. SIWC limit에 대해 다른 계정/결제 경로를 같은 요청에 투명하게 시도하지 않는다.[5] `Retry-After`는 신뢰 가능한 범위에서 대기 안내로만 사용하며 없거나 잘못된 경우 reset을 만들지 않는다. 힌트 자체는 재시도/전환의 권한이 아니다.[1]
5. HTTP 5xx 전체를 안전하다고 보지 않는다. 미래 allowlist에 등록한 **특정** 응답만 실행 전 거절이 문서로 입증되고 제공자 계약도 허락하면 재발송을 고려한다. 지금은 승인된 5xx가 없다. 400/403, 정책·권한 거부, 무효 요청, 알 수 없는 4xx, 파싱 오류는 전환하지 않는다. 401은 인증 회복을 별도 처리하되 실행 전 거절과 허용 범위가 입증되지 않으면 같은 계정 refresh 후에도 재발송하지 않는다. 5xx가 전송 전 확정이라는 주장, 429가 항상 계정별이라는 주장 모두 하지 않는다.
6. DNS/연결 실패라 해도 HTTP 클라이언트가 제공자 요청이 전혀 전달되지 않았음을 신뢰성 있게 증명하지 못하면 **실행 불확실**이다. timeout, reset, 응답 헤더 소실, 중간 프록시 오류, 취소, 비정상 SSE, 불완전 EOF는 기본적으로 불확실이며 재전송하지 않는다. 단순 네트워크 오류를 계정 자체의 장애로 기록하지 않는다. 원격 실행이 없었다는 확정 증거는 단순 오류명이나 무응답만으로 만들지 않는다.

### 발송 상태 기계와 예산

1. 논리 요청은 `PREPARE → DISPATCHED → RESPONSE_UNCOMMITTED → COMMITTED → DONE`으로 추적한다. 전송 시점부터 원격 실행 여부는 증명 전까지 불확실하다. 재전송 게이트는 오류 종류, 계약 allowlist, 실행 전 거절의 긍정적 증거, 요청 재생 가능성, 원격 영향, cancellation, ACL/credential, 예산을 **모두** 확인한다. 어느 하나라도 미확인이면 종료한다.
2. 클라이언트에 **헤더가 전송되거나 어떤 바이트라도 쓰인 순간** COMMITTED이고 이후 같은 논리 요청의 재시도·계정 전환은 절대 금지한다. role-only SSE 프레임, keepalive, 오류 프레임도 바이트다. 상류 SSE의 성공 헤더만으로는 미실행을 증명할 수 없다. 현 구현처럼 첫 role 프레임을 먼저 쓰면 이후 iterator 실패는 재시도 불가다. 재시도 가능 구간을 만들려면 클라이언트 헤더/첫 프레임을 게이트 판정까지 지연해야 하지만, 무조건 스트림을 버퍼링하면 메모리·지연·타임아웃이 증가한다. 비스트리밍도 클라이언트 출력 전이라는 사실만으로 상류 실행 불확실성을 해소하지 못한다. 커밋 후 오류는 프로토콜에 맞는 오류 프레임 또는 연결 종료로 표시하고 성공으로 위장하지 않는다.
3. 기본 물리 발송 상한은 최초 포함 **1회**. 미래 allowlist를 활성화하더라도 논리 요청 전체에 최초 포함 **최대 2회**, 서로 다른 계정 최대 2개, 각 계정 최대 1회로 제한한다. 같은 계정의 401 refresh 재발송도 총 2회에 포함하며 그 경우 계정당 1회 규칙에 대한 유일한 예외로 취급한다. 내부 SDK 재시도·리다이렉트 재전송도 예산 밖에서 발생하지 않게 차단하거나 동일 장부로 합산한다. 후보 제외 집합은 `(kind,id)`로 유지한다. 병렬/hedged 발송은 금지한다.
4. 인증·quota 예약부터 선택·refresh·backoff·모든 발송 및 응답 처리까지 단조 시계 기준 총 **120초** deadline을 공유한다. 각 작업은 남은 시간보다 길 수 없다. delay가 남은 시간을 소진하거나 예산/후보가 없으면 즉시 종료하며 무기한 대기하지 않는다. 명시적 계정은 대체 후보가 없다. retry delay는 제공자 힌트를 무시해 앞당기지 않고 범위·형식 검증, jitter 및 deadline을 적용한다. 모든 후보가 쿨다운이면 기존 earliest 강제 선택이 아니라 불가 응답과 검증된 경우에만 retry hint를 제공한다.
5. 클라이언트 disconnect, 명시적 취소, deadline 중 하나라도 발생하면 즉시 추가 발송·refresh·대기를 중단하고 upstream reader/응답과 타이머를 정리한다. 취소는 이미 발송된 원격 작업이나 과금을 취소했다는 보장이 아니다. DB commit 또는 fetch 결과가 불확실한 경우 보수적으로 발송된 것으로 계산하고 재발송하지 않는다.

### 프로세스 간 권한, quota와 기록

- 최초 요청의 사용자 일일 quota는 현 방식대로 **논리 요청당 한 번** 예약하며 실패·취소 시 환불하지 않는다. 별도로 물리 발송마다 원자적인 attempt 예약과 계정별 한도 예약을 둔다. 동일 논리 요청 ID+attempt 번호에 유일 제약을 두고 상태를 영속화해 중복 예약/발송을 막으며, 충돌·DB 실패·불확실한 commit은 fail closed 한다. 일일 경계와 quota 정의는 UTC로 명시한다. 실패 또는 결과 불확실한 발송도 소비된 것으로 취급하고 자동 환불하지 않는다. 서버 crash 후 재생하지 않는다. 이미 활성인 일일 계정 quota와 성공 기록을 attempt 예약에 맞춰 이중 집계하지 않도록 마이그레이션한다.
- 모든 프로세스는 동일 SQLite DB와 동일 fencing 구현을 사용해야 한다. 각 물리 발송 직전 직렬화된 쓰기 경계에서 사용자의 활성화와 현재 API 키, 공유 ACL, 계정 활성·credential 세대, 모델/옵션 호환성, cooldown 및 예산을 재검증하고 attempt 예약을 원자적으로 수행한다. ACL 및 사용자/계정 활성 변경은 같은 DB의 단조 증가 revision과 연결한다. refresh 등 await 후 snapshot은 폐기하고 다시 검사한다. 발송 시작과 정책 변경의 선후 관계를 SIWC의 기존 시작 fence처럼 같은 DB writer 경계에서 직렬화한다. 이는 발송 시작 이후의 권한 회수로 이미 전송된 요청을 되돌릴 수 있다는 뜻이 아니다. 외부 네트워크와 SQLite는 원자적이지 않으므로 실패·크래시의 불확실 구간은 중복 재발송 대신 보수적으로 소비한다. 일반 계정에도 동등한 ACL·fence를 구현해야 하며 현 SIWC 구현의 존재만으로 전체 경로가 안전하다고 볼 수 없다.
- 제한·쿨다운은 범위(account/model/provider 등)와 근거가 알려진 경우에만 해당 범위로 기록한다. cross-process 정책에 필요한 cooldown은 영속 공유하고 stale 상태 갱신은 계정/credential revision 조건으로 막는다. 정보가 불충분한 제한은 더 넓은 범위의 보수적 중지로 처리하며 다른 계정 사용을 암시하지 않는다. process-local 캐시는 권한이나 quota의 권위가 아니다.
- 논리 요청 ID와 attempt 번호, 계정의 안전한 내부 식별자, 정책 판정, 오류 분류·근거, 상태, 지연과 알려진 usage를 분리 기록한다. 실패/불확실 attempt도 기록하되 비밀·prompt·응답 본문을 로그에 남기지 않는다. 호출자에게 안전하게 공개 가능한 오류 코드와 request ID는 보존하고, SIWC의 원래 오류·상태 전달 요구를 만족하도록 현재 일반화된 오류 처리도 개선해야 한다.[5]

## 대안과 결과

- **모든 429/5xx에서 즉시 다음 계정:** 가용성은 높지만 실행 중복, quota·정책 회피 및 결제 주체 변경 위험 때문에 기각한다.
- **무조건 단일 계정만 사용:** 가장 단순하지만 사전 선택의 다계정 운영 목표를 포기하므로 기각한다. 요청 간 정상 선택과 명시적 사용자 계정 변경은 지원한다.
- **운영자가 불확실한 요청의 중복을 수락하면 retry:** opencodex식 제한된 예외를 참고했지만 이 단계에서는 기각한다. 대가를 명확하게 표시하더라도 계약·실행 안전성이 입증되지 않는다.[4]
- **provider별 명시적 허가 + 실행 전 거절 입증:** 채택 방향. 새 요청의 정상 분산은 계속 가능하지만, 현재 allowlist가 비어 있어 자동 재발송은 제공되지 않는다. 미실행 증명과 제공자 권한이 갖춰진 제한적 경우에만 추후 허용한다. 운영자는 오류를 받고 정책이 허용하는 범위에서 계정을 명시적으로 바꾸거나 나중에 새 요청을 제출할 수 있다. 이는 자동 재발송이 아니다.

## 미해결과 수용 기준

각 provider/endpoint의 실제 계약, 오류 signature와 실행 전 거절 보장, 정확한 quota 범위 및 각 billing 경계 전환 허가는 미확인이다. SIWC 다인 공유와 해당 사용 방식의 허용 여부도 별도 확인이 필요하다. 제공자별 문서·버전·근거 없는 signature는 등록하지 않는다. 로컬 시스템이 remote exactly-once를 보장할 수는 없다.

구현 전에는 기본 비활성 상태를 유지한다. 구현 후 격리 DB와 mock provider로 명시 ID 고정·권한 거부, 전 provider의 기본 429/5xx 차단, 분류된 허용/거부 signature, SIWC limit 및 billing 변경 금지, 401 refresh 예산, 전송 불확실성, 첫 SSE role/헤더 전후 오류, 비스트림 불확실성, malformed stream, timeout/disconnect, 예산·중복 후보·redirect·backoff, quota 중복 방지와 실패 소비를 검증한다. 별도 프로세스에서 ACL 철회·계정 비활성·credential 회전·로그아웃과 발송 경합, stale 결과·DB 잠금/commit 불확실·crash/restart를 검증하고 비밀 미노출과 오류 전달을 확인한다. 테스트는 실제 자격증명·운영 서비스가 아닌 모의 환경에서 수행한다. 결과와 독립 리뷰 전에는 Phase 4 완료로 표시하지 않는다.

## Sources

[1] https://raw.githubusercontent.com/cheaper-inference/OmniRoute/2319a84a/open-sse/utils/retryAfterInstant.ts
[2] https://raw.githubusercontent.com/cheaper-inference/OmniRoute/2319a84a/src/shared/utils/classify429.ts
[3] https://github.com/lidge-jun/opencodex/blob/83ec4f75/src/oauth/generic-account-failover.ts
[4] https://github.com/lidge-jun/opencodex/blob/83ec4f75/src/lib/request-resend-gate.ts
[5] https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
[6] https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
