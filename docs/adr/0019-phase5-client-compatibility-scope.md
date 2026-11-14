# ADR 0019: Phase 5 클라이언트 호환 범위 고정

- 상태: **사용자 승인 (2026-11-10, 1A·2A·3B·4B). 구현·리뷰 완료, 실제 클라이언트·실제 계정 4조합 확인 완료 (2026-11-13, 사용자 실행).** 결과와 한계는 [확인 체크리스트](../phase5-real-verification.md) 5번 표에 있다. 교차 변환(1B)은 Phase 5 완료 후 추가 개발로 진행한다.
- 관련: [ADR 0005](0005-retry-failover-policy.md), [ADR 0008](0008-new-request-account-429-policy.md), [ADR 0010](0010-v1-authentication-scope-boundary.md), [ADR 0016](0016-phase4-scope-freeze.md), [ADR 0017](0017-best-effort-stream-disposal.md)

## 배경

Phase 5의 목표는 Claude Code와 Codex CLI가 ShareAI를 실제로 쓸 수 있게 하는 것이다. 사용자가 가진 계정은 Claude 구독, Codex(ChatGPT) 구독, Claude API 키, OpenAI API 키 네 종류다.

### 공식 문서로 확인한 클라이언트 요구 (2026-11-10 조회)

**Claude Code** — [Gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol), [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)

- `ANTHROPIC_BASE_URL`로 게이트웨이를 지정하면 Anthropic Messages 형식으로 통신한다. 필수 엔드포인트는 `POST /v1/messages`(실제 요청은 `/v1/messages?beta=true`)이고, `/v1/messages/count_tokens`는 선택이다. 없으면 문자 수 기반 추정으로 대체한다.
- 자격증명은 `Authorization: Bearer`(`ANTHROPIC_AUTH_TOKEN`)나 `x-api-key`(`ANTHROPIC_API_KEY`)로 보낸다. 게이트웨이 자격증명을 쓰면 클라이언트 PC의 claude.ai 로그인은 보내지 않는다.
- `anthropic-version`과 `anthropic-beta`는 그대로 전달해야 한다. 베타 값은 허용 목록으로 거르지 말고 열린 목록으로 다룬다. 요청 본문 필드도 바꾸지 말고 전달해야 한다. 베타 헤더와 본문 필드가 짝으로 다니기 때문에, 하나만 빠지면 400이 난다.
- `system` 배열은 받은 그대로 전달해야 한다. 첫 블록인 귀속(attribution) 블록의 순서를 바꾸거나 문자열로 합치면 안 된다. `cache_control`도 그대로 전달하지 않으면 프롬프트 캐시가 깨진다.
- 스트림은 버퍼링하지 말고 이벤트 단위로 즉시 전달해야 한다. `message_delta`·`message_stop` 전에 끝나면 Claude Code는 연결 끊김으로 처리한다. 긴 thinking 중에는 `ping`만 오가므로 이를 걸러내면 클라이언트의 무응답 타이머가 터진다.
- Claude Code의 자동 복구는 공급자 오류 문구를 보고 동작한다(thinking 형식 전환, 베타 값 제거, 시스템 메시지 재배치 등). 그래서 오류 본문을 바꾸지 않고 전달해야 한다.
- `retry-after`는 정수 초로 보낸다. 60보다 크면 클라이언트는 재시도하지 않고 바로 오류를 보여 준다. `anthropic-ratelimit-unified-*` 헤더는 구독 사용량 표시와 429 성격 구분에 쓰인다.
- 시작할 때 보내는 `HEAD /api/hello`는 거부해도 된다. `/v1/models` 탐색은 기본값이 꺼짐이다.

**Codex CLI** — [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)

- 사용자 정의 공급자는 `~/.codex/config.toml`의 `[model_providers.<id>]`에 `base_url`과 `env_key`를 적어 정의한다. `wire_api`는 **`responses`만 지원**하며 생략해도 이 값이 기본이다. 따라서 ShareAI에는 `POST /v1/responses`가 필요하다. 지금의 `/v1/chat/completions`로는 Codex가 동작하지 않는다.
- WebSocket 전송(`supports_websockets`)과 원격 압축(`capabilities.remote_compaction`)은 공급자별 선택 기능이다.
- 이 문서는 제3자 해설이 아니라 공식 페이지를 직접 읽어 확인했다. 단, Codex가 실제로 보내는 헤더와 본문 필드 전체는 문서에 다 나와 있지 않아 **미확인**이다.

### 현재 코드 상태 (정적 확인)

- `src/routes/v1.ts`: `/v1/messages`는 501을 반환하는 자리표시자이고 `/v1/responses`는 없다. `/v1/models`는 오래된 고정 목록을 돌려준다.
- `src/upstream/inference.ts`의 요청 형식은 `{role, content: string}[]`인 텍스트 전용 `ChatRequest`다. 그래서 도구 호출, thinking, 이미지, 캐시 표시, 시스템 블록 배열을 담을 수 없다. 이 형식을 거치면 위의 Claude Code·Codex 요구를 만족할 수 없다.
- `src/upstream/forward-chat.ts`의 `forwardChat`은 약 350줄짜리 단일 함수다. 계정 선택, 승인(OPEN) 울타리, 429/5xx 제한, 라우터 중단 전환, 시간 제한, 401 갱신, 사용량 기록, 종료 drain 소유권이 모두 이 안에 묶여 있다.
- 서버 본문 한도는 `express.json({limit:'10mb'})`, 사용자 인증은 Bearer와 `x-api-key`를 모두 받는다.

## 결정

### 1. 형식을 바꾸지 않는 전달(passthrough)로 구현한다

- `/v1/messages`는 Anthropic 계정(API 키, 구독 OAuth)으로만, `/v1/responses`는 OpenAI 계정(API 키, Codex 구독 OAuth)으로만 보낸다. 엔드포인트가 공급자를 결정하며, 모델 이름 정규식으로 판정하지 않는다.
- 요청 본문은 파싱해서 검증만 하고 **원문 그대로 전달**한다. 라우터가 바꾸는 것은 인증 헤더뿐이고, 구독 OAuth에서는 추가로 아래 2번의 최소 변경만 한다.
- 응답 스트림은 받은 바이트를 그대로 클라이언트에 전달한다. 라우터는 옆에서 SSE를 파싱해 종료 증거, 사용량, 스트림 안의 429만 관찰한다.
- **교차 변환(1B)은 이번 범위 밖이다.** Claude Code→GPT, Codex→Claude 같은 변환은 thinking 서명과 도구 형식이 손실될 수 있다. 사용자 결정에 따라 Phase 5 완료 후 **추가 개발**로 진행하며, 그때 별도 ADR로 손실 범위와 완료 조건을 정한다. 3번 파이프라인의 어댑터 경계는 이 확장을 고려해 설계한다.

### 2. 구독 OAuth 계정의 최소 변경

- **Claude 구독:** `anthropic-beta`에 `oauth-2025-04-20`이 없으면 덧붙이고, `Authorization: Bearer <풀 토큰>`을 넣는다. Claude Code가 보낸 `system` 배열은 건드리지 않는다. 기존 `/v1/chat/completions` 경로는 구독용 시스템 문구를 삽입하는데, 이 동작은 그 경로에만 남긴다.
- **Codex 구독:** `chatgpt.com/backend-api/codex/responses`로 보내고 `chatgpt-account-id`를 넣는다. 본문은 그대로 둔다.
- 두 경우 모두 공급자가 이 형태를 받아들이는지는 **실제 계정으로만 확인할 수 있다**(완료 조건 6).

### 3. 공통 dispatch 파이프라인으로 리팩터링한다

`forwardChat`의 안전 로직을 프로토콜 어댑터와 분리한다. 어댑터는 Chat Completions(기존), Anthropic Messages, Responses 세 가지다.

- 어댑터가 맡는 것: 업스트림 URL과 헤더 구성, 종료 증거 판정, 사용량 추출, 스트림 내 429 판정, 클라이언트 형식의 오류 생성.
- 파이프라인이 맡는 것: 사용자 인증과 한도(ADR 0010), ACL, 계정 선택과 재선택, OPEN 울타리, 429/5xx 공유 제한, 라우터 중단 60초 전환(ADR 0008), 첫 응답 60초·무응답 300초 제한, 401 갱신 재시도, 사용량 기록, 종료 drain 소유권.
- 대안인 `forwardChat`을 엔드포인트마다 복사하는 방식은 안전 로직이 세 벌로 늘어나 수정 누락 위험이 커서 기각한다.
- 기존 `/v1/chat/completions` 테스트에서 새로 실패하는 파일이 생기면 안 된다.

### 4. 오류 전달 정책 (사용자 결정 3B)

- 공급자가 보낸 오류 응답은 **상태와 본문을 바꾸지 않고 전달한다**(400·401·403·404·413·422·429·5xx 모두). Claude Code의 자동 복구가 공급자 문구를 쓰고, 사용자가 실제 원인을 볼 수 있게 하려는 선택이다.
- 라우터 내부 처리는 그대로 둔다. 구독 OAuth의 401은 먼저 토큰 갱신 후 한 번 재시도하고, 그래도 실패한 **마지막** 응답만 전달한다. 429·5xx의 공유 제한 기록과 OPEN 정산도 전달과 별개로 수행한다.
- 공급자 응답이 없는 **라우터 자체 오류**(인증·한도 초과·적격 계정 없음·정산 불확정·시간 초과 등)는 클라이언트 형식(Anthropic `{"type":"error","error":{...}}`, Responses `{"error":{...}}`)으로 라우터가 만든다. 라우터 오류의 `retry-after`는 정수 초로 보낸다.
- 스트림이 시작된 뒤의 실패: 공급자가 보낸 오류 이벤트는 그대로 전달한다. 공급자 없이 끊긴 경우(잘림·시간 초과)에는 프로토콜의 오류 이벤트(Anthropic `event: error`, Responses `error`)를 라우터가 만들어 보낸다. 가짜 성공 종료는 만들지 않는다.
- 결과: 공급자 오류 본문에 공유 계정의 조직 ID나 요금제 정보가 담겨 있으면 사용자에게 보인다(예: OpenAI 429 메시지). 3B 결정으로 받아들인 위험이다. 업스트림 401·403을 그대로 받은 Claude Code는 사용자 자신의 게이트웨이 키 문제로 오인해 재로그인을 안내할 수 있다(**미확인**, 실제 확인 때 관찰).

### 5. 응답 헤더 (사용자 결정 4B)

- 허용 목록으로 전달한다: `content-type`, `cache-control`, `request-id`, `x-request-id`, `retry-after`, `x-should-retry`, `openai-processing-ms`, `anthropic-ratelimit-*`, `x-ratelimit-*`, `x-codex-*`. 그 밖의 헤더는 전달하지 않는다. 여기에는 풀 계정의 `anthropic-organization-id`·`openai-organization`·`openai-project`, 쿠키, hop-by-hop·프레이밍 헤더가 포함된다. 독립 리뷰(2026-11-10) 지적에 따라 처음의 차단 목록 방식을 허용 목록으로 좁혔다. 4B의 대상인 사용량 헤더는 그대로 전달한다.
- 결과: Claude Code가 구독 사용량과 429 성격을 표시할 수 있다. 다만 그 값은 **이번 요청을 처리한 공유 풀 계정**의 것이다. 다음 요청은 다른 계정으로 갈 수 있어 표시가 요청마다 달라질 수 있고, 풀 계정의 사용량이 사용자에게 노출된다.

### 5-1. 구현 세부 (독립 리뷰 반영, 2026-11-10)

- **원문과 파싱 결과의 일치:** 라우터는 파싱 결과로 라우팅하고 원문 바이트를 전달한다. 그래서 다음 경우는 400으로 거부한다.
  - BOM이 없는 UTF-8이 아닌 본문
  - 최상위 키가 중복된 본문. 파서마다 어느 `model`을 쓸지 달라질 수 있기 때문이다.
- **Responses `background:true`는 400.** 대기 응답은 종료 판정을 할 수 없기 때문이다.
- **SSE 파싱:**
  - 알 수 없는 필드는 무시한다(SSE 명세).
  - BOM은 보존한다.
  - 프레임 하나의 상한은 32MB, 오류 본문 상한은 1MB, 비스트림 JSON 상한은 32MB다.
- **스트림 안의 공급자 실패 이벤트:** 정산을 먼저 하고, 그 뒤에 공급자 프레임을 그대로 쓴다. `message_stop`·`response.completed`와 같은 규칙이다.

### 6. 범위 밖 (백로그)

- 교차 공급자 변환 → Phase 5 완료 후 추가 개발(사용자 결정)
- `/v1/messages/count_tokens`(선택 엔드포인트이며, 없으면 추정치로 동작)
- `/v1/models` 탐색 갱신
- Codex WebSocket 전송과 원격 압축(설정 안내에서 끈다)
- SIWC 계정의 새 엔드포인트 사용
- 같은 요청의 다른 계정 재전송(ADR 0005 유지)
- 10MB를 넘는 본문

### 6. 유료 서버 도구 (사용자 결정, 2026-11-10)

- 웹 검색, 코드 실행, MCP 커넥터 같은 공급자 쪽 유료 도구를 **막지 않고 그대로 전달**한다. 본문을 고치지 않으므로 원문 전달 원칙도 그대로 유지된다.
- 이 도구들은 요청 본문의 `tools` 목록으로 켜진다. 베타 헤더와는 관계없다. Claude Code의 WebSearch는 Anthropic 서버 쪽 `web_search`를 쓰고, Codex는 웹 검색이 기본으로 켜져 있다(`web_search = "cached"`).
- 근거(사용자 설명): API 키 계정 비용은 각 구독 계정에 미리 지급된 API 크레딧에서 나간다. 그 범위 안에서 쓰는 것은 문제가 없다.
- 사용자 한도는 요청 횟수 기준이다. 요청 하나 안에서 도구를 여러 번 호출해도 1회로 센다. 사용자별 도구 호출 기록과 상한은 필요해지면 다시 검토한다(BACKLOG).
- 크레딧이 떨어진 계정을 어떻게 처리할지는 BACKLOG에서 다룬다.

### 7. Codex 구독 백엔드의 형식 없는 스트림 (실제 확인에서 발견, 2026-11-13)

- 관찰: 실제 ChatGPT(Codex) 구독 계정으로 `POST /v1/responses`를 보내면, 공급자(`chatgpt.com/backend-api/codex/responses`)가 200으로 답하면서 `Content-Type`, `Content-Encoding`, `Content-Length` 헤더를 하나도 보내지 않았다(계정 2개에서 같은 결과, 서버 로그의 `upstream` 항목으로 확인).
- 그전 동작: 라우터는 `text/event-stream`이나 `application/json`이 아니면 502(`Upstream returned an unsupported content type`)로 거부했다. 그래서 Codex 구독 계정의 요청이 전부 실패했다.
- 결정: 아래 조건이 모두 맞을 때만 그 응답을 이벤트 스트림으로 읽는다.
  - 상태 코드가 200이다.
  - `Content-Type` 헤더가 아예 없다(빈 값이나 다른 형식은 해당하지 않는다).
  - 클라이언트가 스트림을 요청했다(`stream: true`).
  - 요청이 Codex 구독 백엔드로 갔다(OpenAI API 키와 Anthropic은 해당하지 않는다).
- 프레임 검증은 그대로다. 검증에 실패한 바이트는 전달하지 않는다. 헤더는 첫 프레임을 읽기 전에 나가므로, 본문이 완결된 이벤트 스트림이 아니면 클라이언트는 200과 오류 이벤트를 받고 그 계정은 60초 제한 뒤 돌아온다(ADR 0008 2026-11-13 개정. 그전에는 OPEN으로 무기한 남았다). 형식 예외를 넣기 전에는 502 JSON이었다. 클라이언트에는 `Content-Type: text/event-stream`을 붙여 보낸다.
- `Content-Encoding`은 조건에 넣지 않았다. 형식이 적힌 스트림 경로도 검사하지 않고, 압축이 풀리지 않은 본문은 프레임 검증에서 걸린다.
- 진단: 형식 불일치로 거부할 때는 서버 로그의 `upstream`에 응답의 상태 코드, content-type, content-encoding, content-length, 본문 유무를 남긴다. 스트림 검증이 실패할 때는 `upstreamStream`에 실패한 규칙 이름, 받은 바이트 수, 프레임 수, 본문 첫 글자의 종류(고정 라벨)를 남긴다. 본문·쿠키·자격증명은 남기지 않는다.
- 확인: 수정 뒤 같은 구독의 새 계정으로 Codex CLI 0.167.2 요청 8건이 연속으로 성공했다(2026-11-13 15:12~15:14, 사용 기록 기준). 형식 없는 본문은 이벤트 스트림이었다.

### 8. 쓸 수 있는 계정이 없을 때의 응답 (사용자 결정, 2026-11-14)

- 문제: 계정을 고르지 못하면 이유와 상관없이 503을 보냈고, Claude 형식에서는 오류 종류가 `overloaded_error`였다. Claude Code는 과부하와 서버 오류를 최대 10번 재시도한 뒤 "Repeated 529 Overloaded errors. The API is at capacity"를 보여 준다(공식 오류 문서, 2026-11-14 조회). 실제 확인에서 크레딧 소진으로 계정이 빠졌을 때 사용자는 이 화면을 Anthropic 혼잡으로 읽었다.
- 결정: 고를 수 있는 계정이 없으면, 이 요청이 쓸 수 있는 계정 중 가장 빨리 풀리는 시간을 계산한다.
  - 그 시간이 5분 이하이면 **429**와 `Retry-After`(초, 최소 5)를 보낸다. 문구: `All upstream accounts for this request are busy or resting. Retry shortly.` Claude 형식의 오류 종류는 `rate_limit_error`다. Claude Code는 통합 한도 헤더가 없는 429를 "Server is temporarily limiting requests (not your usage limit)"로 보고 자동 재시도한다(같은 문서).
  - 그 밖에는 **403**을 보낸다. 문구: `No upstream account can serve this request now. Contact the administrator.` 오류 종류는 `permission_error`다. 이 요청이 쓸 수 있는 계정이 없거나(없음, 꺼짐, `error`), 모두 무기한으로 막혔거나, 가장 짧은 대기도 5분을 넘는 경우다.
  - 문구는 고정이고 계정 이름·개수·상태는 넣지 않는다(공유 사용자에게 풀 정보를 노출하지 않는다).
- 대기 시간 계산(조언용이고 선택과 마찬가지로 경쟁이 있을 수 있다). 선택과 설명은 계정 하나를 판정하는 같은 규칙(일반 계정 `upstreamChecks`, SIWC `siwcChecks`)을 쓴다. 판정은 "지금 사용 가능 / 몇 ms 뒤 / 관리자 필요" 셋 중 하나이고, 선택은 "지금 사용 가능"만 고른다. 그래서 선택이 거르는 이유가 대기 계산에서 빠질 수 없다(리뷰 지적 반영):
  - 다른 요청이 쓰는 중(OPEN), 이 요청 안에서 경쟁에 진 계정, Codex 토큰 갱신 중: 5초. 실제 끝나는 시각은 알 수 없다. 끝나지 않는 OPEN이나 갱신 표식도 같은 5초로 보인다.
  - 429 v2 제한: 걸린 시간 전체. 이미 지난 시간은 여기서 추적하지 않으므로 실제보다 길게 말할 수 있다. 기간이 없는(무기한) 제한은 대기로 치지 않는다.
  - 프로세스 안 연속 실패 backoff, `quota_exceeded`의 `resetAt`, SIWC 만료 토큰의 `earliestRefreshAt`: 남은 시간.
  - 일일 할당량 소진, 레거시 이전으로 모호한 오늘 행, 최대값 행: 다음 UTC 자정까지(대개 5분을 넘어 403).
  - 손상된 할당량 행(날짜 형식 오류, 미래 날짜, 잘못된 사용량)이나 잘못된 계정 할당량 설정: 관리자 필요(403).
  - 한 계정에 여러 이유가 겹치면 가장 긴 것, 계정 사이에서는 가장 짧은 것.
  - 이 요청이 절대 쓸 수 없는 계정(자격 형식 불일치, 생성 옵션을 못 받는 Codex 구독, 만료되고 갱신할 수 없는 토큰)은 세지 않는다. SIWC 계정은 사용자 접근 권한과 자격 상태를 같은 방식으로 본다.
- 하지 않은 것: SIWC 계정을 직접 지정한 요청(`router_options.siwc_account_id`)의 503, 선택 뒤 발송 직전 상태가 바뀐 경우의 503(`AccountQuotaUnavailable`)은 그대로다.
- 미확인: Claude Code와 Codex가 이 403을 재시도 없이 문구 그대로 보여 주는지, Codex가 이 429를 재시도하는지. 계정 없는 서버로 사용자가 화면을 확인한다. 기대와 다르면 상태 코드만 바꾼다.

## 완료 조건 (고정)

1. **`/v1/messages`**: Anthropic API 키와 구독 OAuth 두 경우 모두 다음을 실제 서버 경로 테스트(합성 공급자)로 확인한다.
   - 스트림과 비스트림
   - 도구 호출과 결과 왕복
   - thinking 블록과 서명의 바이트 보존
   - `system` 배열·`cache_control`·알 수 없는 본문 필드의 무변경 전달
   - `anthropic-beta`·`anthropic-version` 전달과 OAuth 베타 병합
   - `ping` 전달
   - 4번 오류 전달 정책과 5번 헤더 전달
2. **`/v1/responses`**: OpenAI API 키와 Codex 구독 OAuth 두 경우 모두 다음을 같은 방식으로 확인한다.
   - 스트림과 비스트림
   - function call과 결과 왕복
   - reasoning 항목(`encrypted_content`)과 `store:false` 보존
   - 4번 오류 전달 정책과 5번 헤더 전달
3. **안전 속성 승계:** 새 엔드포인트 두 개에서 다음을 실제 서버 경로 테스트로 확인한다.
   - 사용자 인증·한도, ACL
   - OPEN 울타리와 정산
   - 429/5xx 공유 제한
   - 클라이언트 중단(Esc) 시 60초 제한 전환
   - 첫 응답·무응답 제한
   - 401 갱신
   - 종료 drain
   - 프로토콜 이벤트에서 뽑은 토큰 사용량 기록
4. **엄격한 종료 판정:**
   - Anthropic: `message_start` → … → `message_delta` → `message_stop`이 모두 와야 완료다.
   - Responses: `response.completed`(status `completed`)가 와야 완료로 보고, `response.failed`·`response.incomplete`는 실패로 처리한다.
   - 잘린 스트림은 불확정 결과로 보고 OPEN을 유지한다. (2026-11-13: ADR 0008 개정으로 OPEN 대신 60초 제한으로 전환한다. 재전송하지 않는 것은 그대로다.)
5. **설정 안내:** README에 Claude Code(`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`)와 Codex(`config.toml`의 `model_providers`) 설정법과 확인 절차를 적는다.
6. **실제 클라이언트·실제 계정 확인 (사용자 실행):** Claude Code×(구독, API)와 Codex×(구독, API) 네 조합 각각에서 다음을 확인한다.
   - 간단한 질문
   - 파일을 읽는 도구 사용 턴
   - thinking이 있는 턴
   - Esc로 중단한 뒤 다음 요청
   - 체크리스트와 확인 스크립트는 내가 준비하고, 로그인과 실행은 사용자가 한다.
7. **절차:** 독립 리뷰와 재리뷰 PASS, `npm run build` 통과, 직전 전체 실행 대비 새로 실패하는 파일 0개.

## 결과와 위험

- 전달 방식이라 클라이언트의 새 기능을 대부분 자동으로 따라간다. 대신 라우터는 본문 내용을 해석하지 않으므로, 모델별 기능 제한은 공급자 오류로만 드러난다.
- **구독 계정 공유 위험:** 여러 사용자가 한 사람의 Claude·ChatGPT 구독을 나눠 쓰는 것은 각 공급자의 소비자 약관상 계정 공유·제3자 사용 금지에 걸릴 수 있다. 계정 정지 위험은 사용자가 이미 인지하고 선택했다(ADR 0001). 이 ADR은 약관 적합성을 증명하지 않는다.
- Anthropic 문서는 `ANTHROPIC_BASE_URL` 게이트웨이를 조직의 API 자격증명 사용 맥락으로 설명한다. 게이트웨이가 풀 구독 OAuth 토큰으로 대신 보내는 방식은 문서화된 사용법이 아니며, 공급자 쪽 거부나 변경 가능성이 있다(**미확인**).
- Codex 구독 백엔드(`chatgpt.com/backend-api/codex/responses`)는 공개 API가 아니다. 예고 없이 바뀔 수 있다.

## 미확인 가정

- Claude 구독 OAuth가 Claude Code 원문 본문을 베타 병합만으로 받아들이는지.
- Codex 구독 백엔드가 Codex CLI 원문 본문을 받아들이는지, 그리고 Codex가 보내는 식별 헤더(`originator`, `session_id`, 버전 등)가 필요한지.
- 실제 공급자의 `ping` 간격과 thinking 무음 시간이 무응답 300초 안에 드는지.
- Codex CLI가 사용자 정의 공급자에 대해 `/v1/models` 등 다른 엔드포인트를 호출하는지.
