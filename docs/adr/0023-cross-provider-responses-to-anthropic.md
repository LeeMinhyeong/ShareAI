# ADR 0023: 교차 공급자 변환 2단계 — Codex(`/v1/responses`) → Anthropic 계정

- 상태: **사용자 승인 (2026-11-15 결정 1~5), 구현 중 (2026-11-15).**
- 관련: [ADR 0022](0022-cross-provider-messages-to-openai.md)(1단계, 같은 원칙), [ADR 0019](0019-phase5-client-compatibility-scope.md), [ADR 0008](0008-new-request-account-429-policy.md), [ADR 0021](0021-per-account-concurrency.md)

## 배경

- 1단계(ADR 0022)로 Claude Code가 OpenAI 계정을 쓸 수 있다. 2단계는 반대로 Codex CLI가 Claude 계정(구독 OAuth, API 키)을 쓰게 한다.
- Codex의 요청에는 Anthropic에 없는 것이 많다: 자유형식 도구(`apply_patch`, 문법으로 입력을 정의), 네임스페이스 도구, 암호화된 추론 재전송, 호스팅 도구(web_search 등). Anthropic은 반대로 thinking 서명 재전송과 `cache_control` 표시를 요구한다.

## 결정 (사용자 승인)

1. **thinking을 켜고 서명을 Codex를 통해 돌려받는다.** Claude의 thinking 블록(서명 포함)과 redacted_thinking 블록을 Codex 추론 항목(`reasoning`)의 `encrypted_content`에 담는다(`srx1:` + base64 JSON, 만든 모델 이름 포함, 4MB 상한). Codex가 다음 요청에 그 항목을 다시 보내면 원래 블록으로 되살려 Anthropic에 그대로 보낸다. thinking 텍스트는 Codex 화면에 추론 요약으로 보인다. 라우터 표식이 없는 추론 항목(OpenAI가 암호화한 것)과 다른 Claude 모델이 만든 봉투는 버린다(서명이 모델별로 검증될 수 있어서, 리뷰 반영).
   - 도구 결과로 이어 가는 턴의 첫 assistant 메시지가 thinking으로 시작하지 않으면(GPT 턴의 기록, 버린 봉투) Anthropic이 thinking과 함께 받지 않으므로 그 요청만 thinking을 끈다. 다음 사용자 턴부터 다시 켠다. thinking을 끈 요청도 `output_config.effort`는 유지한다(재리뷰 반영, 레벨은 thinking과 별개).
2. **추론 레벨: Claude Code와 같은 형식.** `thinking: {type: 'adaptive'}` + `output_config.effort`. Codex 레벨 `minimal`·`low` → `low`, `medium` → `medium`, `high` → `high`, `xhigh` → `max`. 모델 이름 접미사(`claude-sonnet-4-5(high)`, 1단계와 같은 레벨 이름)가 있으면 접미사가 이긴다. `none`이면 thinking을 끈다. 레벨이 없으면 adaptive만 보낸다(모델 기본값).
3. **자유형식 도구는 입력 문자열 하나를 받는 일반 도구로 바꾼다.** 문법(형식과 정의)은 도구 설명 뒤에 붙인다. 응답의 도구 호출은 다시 Codex의 자유형식 도구 호출(`custom_tool_call`, 입력 문자열)로 되돌린다.
4. **라우터가 `cache_control`을 자동으로 붙인다(최대 4곳).** 도구 목록 마지막, 시스템 마지막 블록, 대화 마지막 메시지의 마지막 블록, 그 앞 마지막 user 메시지의 마지막 블록. thinking 블록에는 붙이지 않는다.
5. **Claude 구독 계정:** 기존 `/v1/chat/completions` 경로처럼 시스템 첫 블록에 `You are Claude Code, Anthropic's official CLI for Claude.`를 넣고, 같은 헤더(`anthropic-beta: claude-code-20250219`, `user-agent: claude-cli/2.1.0`)를 보낸다. 도구 이름 접두사(opencodex의 `custom_`)는 실제 확인에서 거부될 때만 추가한다.

## 1단계에서 이어받는 원칙 (ADR 0022)

- 교차 조건: `/v1/responses` 요청의 모델이 `claude-`로 시작하면(대소문자 무시, 접미사 제거 후) Anthropic 계정으로 보낸다. 그 밖은 지금처럼 OpenAI 계정으로 원문 전달.
- 의미가 안 바뀌는 것은 빼고 진행, 내용을 잃는 것은 400.
  - 빼는 것: 쓸 수 없는 도구 정의(web_search, local_shell, image_generation, file_search, tool_search 등), 웹 검색 기록(`web_search_call`, 결과는 뒤따르는 assistant 메시지에 있음), 빈 텍스트, `prompt_cache_key`, `text.verbosity`, `include`, `store`, `reasoning.summary`, `metadata`, `temperature`·`top_p`, `service_tier`, `truncation`, `user`, 알 수 없는 최상위 필드, 클라이언트 헤더.
  - 400: `input_file`·오디오 등 Anthropic이 받을 수 없는 입력, 구조화 출력(`text.format`이 text가 아님), 알 수 없는 `reasoning.effort`, 객체가 아닌 함수 매개변수 스키마, 호스팅 도구 기록(`local_shell_call`, `image_generation_call`, `tool_search_*`, `mcp_*`), 원격 압축 항목(`compaction`, `compaction_trigger`), `item_reference`, `previous_response_id`, `background`, 파싱할 수 없는 함수 인자.

## 구현 규칙 (리뷰 대상)

### 요청 (Responses → Anthropic Messages)

- 공급자 요청은 항상 `stream: true`. `max_tokens`는 `max_output_tokens`가 있으면 그 값, 없으면 32000(Claude Code 기본값).
- `instructions` → 시스템 text 블록. 첫 user·assistant 항목 앞의 `system`·`developer` 메시지도 시스템 블록으로, 그 뒤에 오는 것은 user text로 보낸다.
- 항목 변환(순서 유지, 같은 역할이 이어지면 한 메시지로 합침):
  - user 메시지: `input_text` → text, `input_image` → image(`data:` URL은 base64, 그 밖은 url). assistant 메시지: `output_text`·`refusal` → text.
  - `reasoning`(라우터 표식) → 다음 assistant 메시지 앞쪽의 thinking/redacted_thinking 블록.
  - `function_call` → `tool_use`(입력은 `arguments`의 JSON 객체), `custom_tool_call` → `tool_use`(입력 `{input: 문자열}`).
  - `function_call_output`·`custom_tool_call_output` → user `tool_result`(문자열, 또는 `input_text`·`input_image` 배열).
  - 도구 호출 id가 Anthropic 규칙(`^[A-Za-z0-9_-]+$`)에 맞지 않으면 결정적으로 바꾼다(호출과 결과에 같은 규칙).
- 도구: `function` → `{name, description, input_schema}`, `custom` → 결정 3, `namespace` → 하위 도구를 `네임스페이스__이름`으로 펼치고 응답에서 `namespace`와 원래 이름으로 되돌린다. 이름 규칙은 1단계와 같다(64자, 결정적 대체, 충돌 시 400).
- `tool_choice`: `auto` → auto, `required` → any, `none` → none, `{type:'function'|'custom', name}` → tool. `parallel_tool_calls: false` → `disable_parallel_tool_use: true`(`none`일 때는 생략). 매개변수 스키마에 `type`이 없으면 `object`를 채운다. 강제 도구 선택(any, tool)이면 Anthropic이 thinking과 함께 받지 않으므로 그 요청은 thinking을 끈다.
- 헤더: API 키는 `anthropic-beta: interleaved-thinking-2025-05-14`, 구독은 결정 5의 헤더에 같은 beta를 더한다. URL은 Claude Code처럼 `?beta=true`.

### 응답 (Anthropic 스트림 → Responses 스트림)

- 공급자 스트림은 기존 검증(`relayFrames`, Anthropic 규칙)을 그대로 거친다.
- `response.created`(모델은 클라이언트가 보낸 이름) → 블록마다 출력 항목:
  - thinking → `reasoning` 항목(요약 텍스트 델타, 완료 시 `encrypted_content`에 서명 포함 블록). redacted_thinking → 요약 없는 `reasoning` 항목.
  - text → `message` 항목(`output_text` 델타).
  - tool_use → `function_call`(인자 델타) 또는 자유형식 도구면 `custom_tool_call`(완료 시 입력 문자열). 네임스페이스 도구는 `namespace` 포함.
  - 서버 도구 블록 등 그 밖의 블록은 502로 끝낸다.
- 종료: `end_turn`·`tool_use`·`stop_sequence` → `response.completed`, `max_tokens` → `response.incomplete`(`max_output_tokens`), `refusal` → `response.incomplete`(`content_filter`), 그 밖 → `response.incomplete`. 사용량: 입력 = 비캐시 + 캐시 생성 + 캐시 적중, `cached_tokens` = 캐시 적중. 종료 이벤트는 정산 뒤에 보낸다.
- 이미 열린 스트림의 라우터 오류(잘림, 시간 초과, 변환 불가)도 `response.failed`(`server_error`)로 끝낸다. Codex는 이 이벤트를 읽는다.
- 오류: 공급자 HTTP 오류는 상태 유지, 본문을 Responses 오류 형식으로(공급자 메시지 유지). 스트림 중 공급자 `error` 이벤트는 `response.failed`(코드: 429 `rate_limit_exceeded`, 529·503 `server_is_overloaded`, 그 밖 `server_error`·`invalid_request_error`)로. 응답 헤더는 요청 id와 재시도 헤더만 전달.

## 그대로인 것

- 계정 선택, 울타리, 동시 한도, 429/5xx 제한, 시간 초과, 401 갱신, 사용량 기록, 종료 drain. 교차 요청은 공급자 `anthropic`, 모델은 접미사를 뗀 이름으로 선택·기록한다.
- GPT 모델의 `/v1/responses`, `/v1/messages`, `/v1/chat/completions`는 바뀌지 않는다.

## 받아들인 위험

- Claude 구독에 Claude Code인 척 요청하는 것은 약관 위험이 더 크다(결정 5). 구독이 비-Claude Code 도구 구성이나 adaptive·effort 형식을 받아 주는지는 실제 확인 전까지 모른다.
- Codex가 추론 항목을 `encrypted_content`·요약과 함께 다음 요청에 돌려보내는 것은 **확인했다**(2026-11-16, Codex 0.167.2를 가짜 Anthropic을 붙인 로컬 라우터에 연결: 도구 호출 → 결과 → 서명 재전송, `apply_patch`로 파일 생성까지). Codex는 `include: ["reasoning.encrypted_content"]`를 보낸다. 실제 Anthropic이 그 서명을 받는지는 실제 확인으로 남는다.
- Codex 전용 동작(원격 압축, 내장 도구 호출)은 Claude 모델에서 쓸 수 없다. Codex 0.167.2는 `claude-*` 모델 정보가 없으면 기본 구성으로 내려가 `apply_patch` 도구를 보내지 않고 `instructions` 없이 developer 메시지로 지시문을 보낸다(확인). 그래서 `scripts/phase5-verify.mjs codex-setup`이 사용자 PC의 Codex 모델 캐시에서 항목을 복제해 Claude 모델용 카탈로그(`model_catalog_json`)와 프로필 `shareai-claude`를 만든다: 자유형식 `apply_patch`, 추론 요약 `auto`, 레벨 low/medium/high/xhigh, 지시문의 `GPT-n` 표기는 `Claude`로. 저장소에는 OpenAI 지시문을 넣지 않는다.
- 자동 `cache_control`은 캐시 쓰기 비용이 있다(API 키). 구독은 한도 절약이 목적이다.
- **adaptive thinking과 `output_config.effort`(특히 `max`)를 받는 Claude 모델 범위는 미확인이다(리뷰 차단 지적 B).** 예전 세대 모델은 `enabled` + `budget_tokens`만 받을 수 있다. 실제 확인에서 거부되면 모델별 형식표를 둘지, 그 모델을 교차 경로에서 거부할지 정한다.
- 계정마다 서명이 통하는지(풀은 요청마다 계정을 바꾼다), Codex가 `response.incomplete`에서 재시도하는지(최대 토큰 반복 과금), 큰 `apply_patch`를 만드는 동안 Codex로 이벤트가 없어 무응답 시간 초과(기본 300초)에 걸리는지 미확인이다.
- 공급자 오류 문구를 그대로 보여 준다(ADR 0019 3B와 같은 위험). 공급자 401·403도 그대로 가므로 Codex가 사용자 자신의 키 문제로 보일 수 있다.

## 완료 조건

1. 자동 테스트: 요청 변환(역할·항목·도구·네임스페이스·자유형식·추론 왕복·캐시 표시·레벨·거부), 응답 변환(추론·텍스트·함수·자유형식·종료·사용량·비스트림), 오류 변환, 파이프라인 HTTP(API 키·구독 헤더, 정산·제한·취소). 기존 테스트에서 새로 실패하는 파일 0.
2. 실제 확인(사용자 실행): Codex에서 Claude 모델로 파일을 읽고 `apply_patch`로 고치는 도구 대화 여러 턴 1회 — Claude 구독 계정. 쓰려는 Claude 모델마다 adaptive·effort 요청이 받아들여지는지. thinking을 켠 도구 루프에서 중간 assistant가 thinking 없이 `tool_use`로 시작한 뒤 다음 요청이 받아들여지는지(이어 가기 판정이 턴 시작 assistant를 보는 것은 가정이다). Codex는 `codex-setup`으로 만든 프로필로 연결한다(리뷰가 권한 `model_supports_reasoning_summaries` 설정은 Codex 0.167.2에 없다).
