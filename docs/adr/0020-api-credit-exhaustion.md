# ADR 0020: API 크레딧 소진 계정 자동 제외와 수동 복구

- 상태: **사용자 승인 (2026-11-10), 구현·리뷰 PASS (2026-11-11, deleg_0f47e6b6 → 158084f8 → 91e457f2).** 실제 소진 응답으로는 아직 확인하지 않았다. 사용자 결정: "소진 감지해서 해당 계정 api가 소진되었다고 표시하고 라우팅에서 뺀 뒤에, api 크레딧이 다시 들어오면 직접 켜게 만들면 될 것 같아."
- 관련: [ADR 0005](0005-retry-failover-policy.md), [ADR 0008](0008-new-request-account-429-policy.md), [ADR 0019](0019-phase5-client-compatibility-scope.md)

## 배경

- API 키 계정의 비용은 각 구독 계정에 미리 지급된 API 크레딧에서 나간다(ADR 0019 6번). 지급이 언제까지 이어질지는 모른다.
- 두 공급자 모두 잔고를 조회하는 공식 API가 없다. 그래서 공급자가 보내는 **소진 오류**로 판단한다.
- 기존 동작에는 두 가지 문제가 있다.
  - Anthropic은 소진되면 400을 보낸다. 400은 계정 실패로 기록되지 않아서, 소진된 계정이 계속 선택되고 요청이 매번 실패한다.
  - OpenAI는 429를 보낸다. 일반 429처럼 잠깐 쉬었다가 다시 시도하므로, 주기적으로 실패 요청이 생긴다.

### 공식 문서로 확인한 신호 (2026-11-10 조회)

| 공급자 | 상태 코드 | 판별 근거 | 출처 |
|---|---|---|---|
| Anthropic | 402 | `error.type = "billing_error"` (결제·지불 정보 문제) | [Errors](https://platform.claude.com/docs/en/api/errors) |
| Anthropic | 400 | `error.type = "invalid_request_error"`이고 문구가 `Your credit balance is too low ...` | 공식 문서에는 없다. 여러 사용자 보고와 SDK 이슈에서 같은 형태를 확인했다. |
| OpenAI | 429 | `error.code`가 `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded` 중 하나. 예전 코드 `insufficient_quota`도 포함한다(`error.type`이 `insufficient_quota`일 수 있음). | [Error codes](https://developers.openai.com/api/docs/guides/error-codes): "Retrying billing, spend, or quota errors won't restore API access." |

## 결정

1. **대상:** API 키 계정만 판정한다(`credential_type = 'api_key'`).
   - 구독 OAuth 계정의 429는 사용량 제한이라 시간이 지나면 풀린다. 기존 429 처리를 유지한다.
   - SIWC 계정은 대상이 아니다.
2. **판정 경로:** 공급자 오류 본문을 이미 들고 있는 원문 전달 경로만 판정한다.
   - `/v1/messages`·`/v1/responses`의 HTTP 오류 응답.
   - 200 스트림 안의 실패 프레임(Responses `response.failed`·`error`, Anthropic `error`).
   - `/v1/chat/completions`는 Phase 4 설계상 오류 본문을 읽지 않고 버린다. 그래서 이번 범위에서 빠진다(BACKLOG).
3. **표시:** 계정 상태를 기존 `error`로 바꾼다.
   - `last_error`에 `API 크레딧 소진(<코드>): 크레딧을 충전한 뒤 계정을 다시 켜세요`를 남긴다.
   - 새 상태 값을 만들지 않는다. 그래야 기존 테이블 CHECK 제약과 레거시 마이그레이션 검사를 건드리지 않는다.
   - `error`는 이미 라우팅 후보에서 빠지고, 자동으로 복구되지 않는다.
4. **복구:** 관리자가 `PATCH /admin/accounts/:id {status:"active"}`로 직접 켠다.
   - `active`가 아닌 계정을 켤 때는 `last_error`를 지우고 `state_revision`을 올린다.
     - `state_revision`을 올리면 이전 상태에서 보낸 요청의 결과가 다시 켠 계정을 바꾸지 못한다.
     - 프로세스 안의 실패 대기(backoff)도 함께 초기화된다.
   - 소진으로 꺼진 계정을 켤 때는, 같은 429 응답이 남긴 계정 제한(429 v2)도 해제한다. OpenAI는 본문을 읽기 전에 429만 보고 이 제한을 걸고, `Retry-After`에 따라 제한이 길거나 무기한일 수 있다. 다른 이유로 걸린 429 제한은 그대로 둔다.
   - 401/403으로 꺼진 계정을 자격증명을 고치지 않고 켜면, 원인 기록(`last_error`)도 함께 지워진다. 원래 오류 문구는 자격증명을 담고 있을 수 있어서 로그로도 남기지 않는다.
   - 자동 재시도나 주기적인 잔고 확인은 하지 않는다.
5. **클라이언트 응답:** 공급자 오류를 그대로 전달한다(ADR 0019 3B).
   - 소진을 감지한 그 요청은 다른 계정으로 다시 보내지 않는다. 요청 도중 재전송은 ADR 0019에서 범위 밖으로 정했다.
   - 다음 요청부터는 다른 계정이 선택된다.
6. **기록 시점:** 계정 상태는 기존 실패 기록(`recordFailureAsync`)과 같은 시점에 바꾼다.
   - 그 시점은 클라이언트에 오류를 쓴 직후다. 시도(OPEN)의 정산은 기존처럼 오류를 쓰기 전에 끝난다.
   - 기록은 관찰한 계정 상태(`state_revision`·자격증명)가 그대로일 때만 적용한다. 관리자가 그사이 키를 바꿨다면 적용하지 않는다.

## 결과와 위험

- 공급자가 오류 형식을 바꾸면 감지가 빠질 수 있다. 특히 Anthropic 400 문구는 공식 문서에 없는 형식이다. 감지가 빠지면 기존 동작으로 돌아갈 뿐 더 나빠지지는 않는다.
- 반대로 잘못 감지하면 정상 계정이 꺼진다. 그래서 판정 조건을 좁게 잡았다: 상태 코드, 오류 타입·코드, 문구를 모두 확인한다.
- OpenAI 지출 한도 코드도 포함한다. 이 코드들도 계정 주인이 한도를 바꾸기 전에는 풀리지 않는다. 표시에는 실제 코드를 남긴다.
- 실제 소진 응답은 아직 보지 못했다. 실제로 소진이 일어나면 `last_error`와 서버 로그로 판정이 맞았는지 확인한다.
