# ADR 0022: 교차 공급자 변환 1단계 — Claude Code(`/v1/messages`) → OpenAI 계정

- 상태: **사용자 승인 (2026-11-14 결정 1·2·3·4·5), 구현 중 (2026-11-14).**
- 관련: [ADR 0019](0019-phase5-client-compatibility-scope.md) 1번(교차 변환은 범위 밖, 이 ADR이 일부를 연다), [ADR 0008](0008-new-request-account-429-policy.md), [ADR 0021](0021-per-account-concurrency.md)

## 배경

- 지금은 엔드포인트가 공급자를 정한다. `/v1/messages`(Claude Code)는 Anthropic 계정, `/v1/responses`(Codex)는 OpenAI 계정으로만 간다(ADR 0019 1번).
- 테스트 계정은 Claude 구독 6, Codex 구독 6, OpenAI API 키 1이다. Claude Code 사용자가 OpenAI 계정도 쓸 수 있으면 풀 전체를 더 쓸 수 있다.
- 두 형식은 1:1로 대응하지 않는다. thinking 서명, 서버 도구, 캐시 표시, 문서 블록은 OpenAI에 대응물이 없다.

## 결정 (사용자 승인)

1. **방향: Claude Code → OpenAI 계정(Codex 구독 OAuth, OpenAI API 키)만.** Codex → Anthropic은 다음 단계(별도 ADR). SIWC 계정은 지금처럼 `/v1/messages`에서 쓰지 않는다.
2. **교차 조건: 클라이언트가 고른 모델 이름.** `/v1/messages` 요청의 모델이 OpenAI 모델이면 OpenAI 계정으로 보낸다. 같은 공급자 계정이 다 찼다고 몰래 넘기지 않는다.
   - OpenAI 모델 판정(대소문자 무시, 접미사 제거 후): `gpt-`, `chatgpt-`, `codex-`로 시작하거나, `o` 뒤에 숫자로 시작(`o3`, `o4-mini` 등).
   - 그 밖의 모델은 지금처럼 Anthropic 계정으로 원문 그대로 전달한다(ADR 0019 그대로).
3. **추론 레벨: 자동 변환 + 모델 이름 접미사로 강제.**
   - 접미사: `모델(레벨)`, 레벨은 `none`·`minimal`·`low`·`medium`·`high`·`xhigh`(`max`는 `xhigh`로 취급). `xhigh`를 지원하지 않는 모델이면 공급자 400이 그대로 전달된다. 예: `gpt-5.1-codex(high)`. 접미사가 있으면 접미사가 이긴다. 공급자에는 접미사를 뗀 이름을 보낸다.
   - 자동 변환: `output_config.effort`가 위 레벨 중 하나면 그대로 쓴다. Anthropic의 최고 단계 `max`는 OpenAI 최고 단계 `xhigh`로 바꾼다(리뷰 반영, 결정 3의 해석). 없으면 `thinking.type === 'enabled'`의 `budget_tokens`를 1024 이하 `low`, 10240 이하 `medium`, 131072 미만 `high`, 그 이상 `xhigh`로 바꾼다(참고 구현 OmniRoute와 같은 구간).
   - 둘 다 없거나 thinking이 꺼져 있으면 `reasoning`을 보내지 않는다(공급자 기본값).
4. **OpenAI 추론 내용은 보여 주지 않는다.** reasoning 출력은 버리고 답변과 도구 호출만 변환한다. 대화 기록의 Anthropic `thinking`·`redacted_thinking` 블록은 OpenAI로 보낼 때 뺀다. 그래서 턴 사이에 OpenAI의 추론 맥락은 이어지지 않는다(품질 손실 가능, 받아들임).
5. **변환할 수 없는 기능:** 의미가 안 바뀌는 것은 빼고 진행하고, 내용을 잃는 것은 400으로 거부한다.
   - 빼는 것: `cache_control`, 서버 도구 정의(`type`이 있는 도구: web_search, web_fetch, bash, text_editor, computer, code_execution, memory 등), `metadata`, `temperature`·`top_p`·`top_k`, `service_tier`, `context_management`, 알 수 없는 최상위 필드, `anthropic-*` 헤더.
   - 400으로 거부하는 것: 문서(`document`) 블록, 서버 도구 기록(`server_tool_use`, `*_tool_result` 중 `tool_result`가 아닌 것), `search_result`·`container_upload` 등 알 수 없는 내용 블록, `stop_sequences`, `mcp_servers`, `container`.

## 구현 규칙 (리뷰 대상)

### 요청 변환 (Anthropic Messages → OpenAI Responses)

- 공급자 요청은 항상 `stream: true`, `store: false`다. 클라이언트가 `stream: false`면 라우터가 스트림을 모아 Anthropic 메시지 JSON 하나로 돌려준다.
- `system`(문자열 또는 text 블록 배열) → `instructions`. Claude Code의 과금 표식 블록(`x-anthropic-billing-header:`로 시작)은 뺀다. 비어 있고 Codex 구독이면 `You are a helpful assistant.`(기존 `/v1/chat/completions` 경로와 같음).
- 메시지 블록, 순서 유지:
  - user `text` → `input_text`, assistant `text` → `output_text`(연속된 블록은 메시지 하나로 묶음).
  - user `image`(base64·url) → `input_image`(`data:` URL 또는 원래 URL).
  - assistant `tool_use` → `function_call`(`call_id` = `tool_use.id`, `arguments` = `input`의 JSON).
  - user `tool_result` → `function_call_output`(`call_id` = `tool_use_id`). 내용이 text면 이어 붙이고, `is_error`면 앞에 `[tool error] `를 붙인다. 이미지가 있으면 연속된 도구 결과가 모두 끝난 뒤에 그 이미지들을 담은 user 메시지 하나를 추가한다.
- 도구: 일반 도구(`type` 없음 또는 `custom`) → `{type:'function', name, description, parameters: input_schema, strict:false}`.
  - 이름이 OpenAI 규칙(`^[A-Za-z0-9_-]{1,64}$`)에 맞지 않으면 앞 55자 + `_` + SHA-256 앞 8자로 바꾸고, 응답에서는 원래 이름으로 되돌린다. 같은 요청의 대화 기록 이름도 같은 규칙으로 바꾼다.
  - `tool_choice`: auto → `auto`, any → `required`, tool → `{type:'function', name}`, none → `none`. `disable_parallel_tool_use: true` → `parallel_tool_calls: false`. 남은 도구가 없으면(서버 도구만 있었으면) 둘 다 보내지 않는다.
- `max_tokens` → API 키는 `max_output_tokens`, Codex 구독은 보내지 않는다(기존 경로가 Codex 구독에 이 값을 보내지 않음).
- 헤더: 클라이언트 헤더는 보내지 않는다. Codex 구독은 기존 경로처럼 `originator: codex_cli_rs`와 `chatgpt-account-id`를 넣는다.

### 응답 변환 (Responses 스트림 → Anthropic 스트림)

- 공급자 스트림은 기존 검증(`relayFrames`, ADR 0019)을 그대로 거친다. 형식 오류, 종료 없는 끊김, 공급자 실패 이벤트의 처리(정산, 60초 제한, 429 판정)는 Responses 원문 기준으로 지금과 같다.
- `response.created` → `message_start`(모델 이름은 클라이언트가 보낸 이름, 입력 토큰은 아직 모르므로 0). 텍스트 델타 → `text` 블록(빈 델타로는 블록을 열지 않는다), 함수 호출 → `tool_use` 블록(인자 델타는 `input_json_delta`). 블록은 한 번에 하나만 열린다. reasoning 항목은 버린다. refusal 델타는 텍스트로 보여 준다.
- 함수 호출·메시지가 아닌 출력 항목(요청하지 않은 내장 도구 호출 등)이 오거나, 이미 닫힌 함수 호출 블록의 인자가 나중에 오면 502로 끝낸다(내용을 잃지 않게 실패로 닫음). 발송 뒤 종료 증거 없이 끝난 것으로 분류되어 계정이 60초 쉰다(보수적, 받아들임).
- 클라이언트에 보일 내용이 없는 동안(추론 중 등) 10초마다 `ping` 이벤트를 보낸다(중간 프록시의 무응답 끊김 방지).
- 종료: `response.completed` → 함수 호출이 있었으면 `tool_use`, 아니면 `end_turn`. `response.incomplete`의 이유가 `max_output_tokens`면 `max_tokens`, `content_filter`면 `refusal`, 그 밖은 `end_turn`. 이어서 `message_delta`(사용량)와 `message_stop`. `message_stop`은 정산 뒤에 보낸다(기존 규칙).
- 사용량: `input_tokens` = 전체 입력 − 캐시 적중, `cache_read_input_tokens` = 캐시 적중, `output_tokens` = 출력. 라우터 기록은 지금처럼 공급자 원문 기준이다.

### 오류

- 응답 헤더는 성공·오류 모두 `request-id`, `x-request-id`, `retry-after`, `x-should-retry`만 전달한다(`x-codex-*`, `x-ratelimit-*` 같은 풀 계정 사용률 헤더는 Claude Code에 쓸모가 없어 뺀다. 리뷰 반영).
- 공급자 HTTP 오류는 상태를 유지하고, 본문만 Anthropic 오류 형식으로 바꾼다(공급자 메시지 유지, ADR 0019 3B의 취지).
- 스트림 중 공급자 실패 이벤트는 Anthropic `event: error`로 바꿔 보낸다(공급자 메시지 유지). 라우터 자체 오류는 기존 Anthropic 형식 그대로다.

## 그대로인 것

- 계정 선택, OPEN 울타리, 동시 한도(ADR 0021), 429/5xx 제한, 시간 초과, 401 갱신 재시도, 사용량 기록, 종료 drain은 기존 파이프라인을 그대로 쓴다. 교차 요청은 공급자 `openai`, 모델은 접미사를 뗀 이름으로 선택·기록한다.
- Claude 모델 요청과 `/v1/responses`·`/v1/chat/completions`는 바뀌지 않는다.
- `/v1/messages/count_tokens`는 지금도 없고, 이번에도 만들지 않는다.

## 받아들인 위험

- Codex 구독 백엔드가 Codex CLI가 아닌 지시문·도구 구성을 받아 주는지 공식 근거가 없다. 실제 계정으로만 확인할 수 있다. ChatGPT 구독을 Codex CLI 밖에서 쓰는 것도 약관상 위험이 있다(README 참고).
- Claude Code가 `gpt-5.1-codex(high)` 같은 이름을 그대로 보내는지, 백그라운드 작업(제목 생성 등)에 쓰는 작은 모델이 무엇인지는 미확인이다. 작은 모델이 Claude면 그 요청은 Anthropic 계정으로 간다.
- Claude Code의 WebSearch처럼 서버 도구에 기대는 기능은 OpenAI 모델에서는 검색 없이 답한다(결정 5).
- 추론 맥락이 턴 사이에 이어지지 않아 Claude 모델이나 Codex CLI보다 품질이 낮을 수 있다(결정 4).
- 공급자 메시지를 그대로 보여 주므로, OpenAI 오류 문구에 담긴 키 끝자리·조직 ID·요금제 정보가 사용자에게 보일 수 있다(ADR 0019 3B와 같은 위험, 경로가 하나 늘었다).
- Claude Code가 `message_start`의 입력 토큰(0)을 쓰는지 `message_delta`의 값을 쓰는지 미확인이다. 컨텍스트 표시와 자동 압축이 틀릴 수 있다.
- 문맥 길이 초과 같은 이른 실패도 스트림 안의 오류 이벤트(HTTP 200)로 보인다. Claude Code가 상태 코드로 하는 복구가 동작하지 않을 수 있다.

## 완료 조건

1. 자동 테스트: 요청 변환(블록·도구·이름·추론 레벨·거부 목록), 응답 변환(텍스트·도구 호출·종료 사유·사용량·비스트림), 오류 변환, 파이프라인 HTTP(API 키·Codex 구독 URL, 정산·제한·취소). 기존 테스트에서 새로 실패하는 파일 0.
2. 실제 확인(사용자 실행): Claude Code에서 OpenAI 모델로 파일을 읽고 고치는 도구 대화 1회 성공 — OpenAI API 키 1회, Codex 구독 1회. 같은 세션에서 Claude 모델로 바꿔도 이어지는지 1회.
