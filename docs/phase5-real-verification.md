# Phase 5 실제 클라이언트·실제 계정 확인 체크리스트 (ADR 0019 완료 조건 6)

이 확인은 **사용자가 직접** 로그인하고 실행한다. 공급자 자격증명과 ShareAI 사용자 키는 채팅에 붙여넣지 말고, 결과(통과/실패, 오류 문구, `status` 출력)만 공유한다.

- 대상 조합 4개: Claude Code × (Claude 구독, Claude API 키), Codex CLI × (Codex 구독, OpenAI API 키)
- 도구: `scripts/phase5-verify.mjs` (로컬 관리자 API만 호출하고, 공급자 자격증명은 출력하지 않는다)
- 명령은 PowerShell 기준이다. bash에서는 `$env:X="..."` 대신 `export X=...`를 쓴다.

## 0. 시작 전에 알아둘 것

- **검증 전용 DB를 쓴다.** 기존 `./data/router.db`는 건드리지 않는다. 서버는 `.env`를 읽지만, 셸에 설정한 `DATABASE_URL`이 `.env` 값보다 우선한다(dotenv는 이미 있는 환경 변수를 덮어쓰지 않음).
- **구독 자격증명은 새로 로그인해서 얻는다.** `~/.claude/.credentials.json`이나 `~/.codex/auth.json`을 가져오면 PC의 Claude Code·Codex와 refresh token을 함께 쓰게 된다. 그러면 한쪽이 토큰을 갱신할 때 다른 쪽 로그인이 끊길 수 있다(추정: OAuth refresh token 회전 방식이고, 코드에도 `refresh_token_reused` 처리가 있다). 그래서 아래 방법을 권장한다.
  - Claude 구독: `claude setup-token`으로 만든 토큰(`sk-ant-oat...`, 갱신 없음)을 파일에 저장해 가져오기. 또는 `login anthropic`.
  - Codex 구독: `login openai`(별도 세션).
- **Esc 뒤 60초 제한:** Esc로 끊으면 그 계정은 60초 동안 쓰이지 않는다(ADR 0008). 활성 계정이 하나뿐이면 60초 안의 다음 요청은 503(적격 계정 없음)이 정상이다.
- **약관 위험:** 구독 계정을 게이트웨이로 쓰는 것은 공식 문서에 없는 사용법이고, 공급자가 거부하거나 계정을 제한할 수 있다(ADR 0001·0019).
- **요금제에 딸린 월간 API 크레딧은 대화형 Claude Code에 적용되지 않는다.** Console에 "프로모션 크레딧"으로 보이는 이 크레딧은 Claude API, Agent SDK, Playground, 관리형 에이전트에 적용된다([공식 문서](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)).
  - ShareAI는 Claude Code의 요청을 헤더까지 그대로 전달한다. 구매 크레딧이 없는 조직의 API 키 계정으로 대화형 Claude Code 요청을 보내면 공급자가 "credit balance is too low" 400으로 거절하고, ShareAI는 그 계정을 `error`로 바꾼다(ADR 0020). 2026-11-13에 Haiku 5.5와 Opus 5.5 모두 이렇게 거절됐다.
  - 비대화형 `claude -p`는 같은 키로 ShareAI를 거쳐도 적용된다(2026-11-13 확인). 그래서 Claude API 키 조합은 4번 끝의 `claude -p` 절차로 확인한다. 대화형으로 확인하려면 구매 크레딧이 필요하다.
  - 키는 워크스페이스를 지정해서 만든다. 범위를 "조직"으로 만든 키는 워크스페이스 미지정 키라서 ShareAI로는 쓸 수 없다.

## 1. 서버 준비 (창 A)

```powershell
cd C:\Users\Administrator\Desktop\Workspace\개발\라우터
$env:DATABASE_URL = "sqlite:./data/phase5-verify.db"
npm run db:init          # 처음 한 번. 파일이 이미 있으면 거부함(정상)
npm run dev              # 포트 20100. 이 창은 띄워 둔다
```

## 2. 사용자 키와 계정 등록 (창 B)

```powershell
cd C:\Users\Administrator\Desktop\Workspace\개발\라우터
$env:ADMIN_API_KEY = "<.env의 ADMIN_API_KEY 값>"
node scripts/phase5-verify.mjs status
node scripts/phase5-verify.mjs user tester          # 출력된 user_... 키를 메모(한 번만 보임)
```

계정 4개를 등록한다. 각 명령은 계정 ID를 출력한다.

```powershell
# Claude 구독: 방법 1 또는 2
claude setup-token                                   # 출력된 sk-ant-oat... 를 파일로 저장
node scripts/phase5-verify.mjs import anthropic claude-sub C:\경로\claude-token.txt
# node scripts/phase5-verify.mjs login anthropic claude-sub   # 방법 2: 브라우저 로그인 후 code#state 붙여넣기

# Claude API 키 (Console에서 만든 키. 개인 키는 sk-ant-usr-..., 예전 워크스페이스 키는 sk-ant-api03-... 형태)
# 키를 만들 때 워크스페이스를 지정한다. 지정하지 않은 키는 요청마다 워크스페이스 ID가 필요해서 ShareAI로는 400이 난다.
$env:P5_ANTHROPIC_KEY = "<Console에서 복사한 키>"
node scripts/phase5-verify.mjs import-env anthropic claude-api P5_ANTHROPIC_KEY

# Codex 구독 (브라우저 로그인. localhost:1455 콜백. Codex CLI 로그인과 동시에 하지 말 것)
node scripts/phase5-verify.mjs login openai codex-sub

# OpenAI API 키
$env:P5_OPENAI_KEY = "sk-..."
node scripts/phase5-verify.mjs import-env openai openai-api P5_OPENAI_KEY

node scripts/phase5-verify.mjs status                # 4개가 active / no_known_block 인지 확인
```

`import`·`import-env`가 거부되면 사유가 함께 나온다.

| 출력 | 뜻 | 할 일 |
|---|---|---|
| `409 An account with this name already exists. ...` | 같은 이름의 계정이 이미 있다(이름은 공급자와 무관하게 하나만) | `status`로 확인하고 다른 이름으로 등록 |
| `400 Credential format not recognized for this provider.` | 키나 파일 내용의 형식을 인식하지 못했다 | 값을 끝까지 복사했는지, 공급자를 맞게 골랐는지 확인 |
| `400 Admin API keys cannot run inference. ...` | Admin 키(`sk-ant-admin...`)다 | 일반 API 키를 발급 |
| `400 This is a Claude key. ...` | Claude 키를 `openai` 계정으로 등록하려 했다 | 공급자를 `anthropic`으로 |
| `400 Could not import credentials` | 그 밖의 저장 실패(사유는 응답에도 로그에도 남지 않는다) | 다시 시도하고, 같으면 그대로 보고 |

- 자격증명을 이름보다 먼저 검사한다. 둘 다 문제면 자격증명 사유가 먼저 나오고, 고친 뒤에 이름 사유가 나온다.
- 이름은 대소문자를 구분한다(`Claude-API`와 `claude-api`는 다른 이름).
- 응답 본문은 `{"error":{"code":"...","message":"..."}}`다. `code`는 사유를 알 때만 있고, 마지막 줄의 일반 응답에는 없다.

조합마다 **그 계정만 활성화**한 뒤 시험한다: `node scripts/phase5-verify.mjs only <계정ID>`

## 3. 클라이언트 설정

**Claude Code (창 C)**

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:20100"    # /v1 붙이지 않음
$env:ANTHROPIC_AUTH_TOKEN = "<user_... 키>"
claude
```

- `ANTHROPIC_AUTH_TOKEN`이 있으면 PC의 claude.ai 로그인은 전송되지 않는다(공식 문서).
- `/status`에서 API 연결 대상이 이 주소인지 확인한다.

**Codex CLI (창 D)**: 기본 설정을 바꾸지 않도록 프로필 파일을 쓴다. `%USERPROFILE%\.codex\shareai.config.toml`:

```toml
model = "<계정에서 쓸 수 있는 모델>"
model_provider = "shareai"

[model_providers.shareai]
name = "ShareAI"
base_url = "http://127.0.0.1:20100/v1"
env_key = "SHAREAI_API_KEY"
wire_api = "responses"
supports_websockets = false
capabilities.remote_compaction = "unsupported"
```

```powershell
$env:SHAREAI_API_KEY = "<user_... 키>"
codex --profile shareai
```

## 4. 조합별 시험 (조합 4개 × 항목 5개)

시험할 계정을 `only`로 활성화한 다음 각 항목을 실행한다. 항목이 하나 끝날 때마다 창 B에서 `status`를 실행한다.

| # | 할 일 | 통과 기준 |
|---|---|---|
| T1 | 간단한 질문 ("한 문장으로 자기소개") | 응답이 끝까지 표시됨. `status`에서 그 계정이 `no_known_block`이고, today usage가 늘어남 |
| T2 | 도구 사용 ("README.md 첫 줄 읽어줘") | 도구 호출 → 결과 → 최종 답변까지 한 번에 진행됨. 오류 없음 |
| T3 | thinking ("단계별로 생각해서 17×23 검산") Claude Code는 thinking 표시, Codex는 reasoning 요약 | 응답 완료, 오류 없음. 다음 턴도 정상(서명·`encrypted_content` 왕복) |
| T4 | 긴 답변을 요청하고 생성 중 Esc | 클라이언트가 중단됨. `status`에서 그 계정이 `restricted`(60초)이고 `open`이 아님 |
| T5 | T4 직후와 60초 뒤에 다시 질문 | 직후에는 503(활성 계정이 하나라 정상)이거나, 다른 계정이 있으면 그 계정으로 응답. 60초 뒤에는 `no_known_block`으로 돌아와 정상 응답 |

**실패로 볼 것:** 응답이 중간에 끊김 / "The response above may be incomplete" / 400·401 반복 / 시험 후 `status`에 `open`이 계속 남음 / 서버 창에 예외 스택.

**Claude API 키 조합은 `claude -p`로 확인한다** (월간 API 크레딧만 있는 경우, 0번 참고). 창 C에서 프로젝트 폴더로 옮겨 한 줄씩 실행한다.

```powershell
cd C:\Users\Administrator\Desktop\Workspace\개발\라우터
claude -p "한 문장으로 자기소개" --model claude-haiku-5-5                       # T1
claude -p "README.md 첫 줄 읽어줘" --model claude-haiku-5-5                     # T2
claude -p "단계별로 생각해서 17×23 검산" --model claude-haiku-5-5                 # T3
claude -p -c "방금 답을 한 줄로 요약해줘" --model claude-haiku-5-5                 # T3 다음 턴
claude -p "1부터 300까지 각 숫자에 대해 한 줄씩 설명해줘" --model claude-haiku-5-5   # T4: 5~10초 뒤 Ctrl+C
claude -p "안녕" --model claude-haiku-5-5                                       # T5: 60초 뒤
```

- `-p`는 답을 끝에 한꺼번에 출력하므로 T4에서는 화면에 아무것도 보이지 않는다. 기다렸다가 Ctrl+C를 누르고 `status`에서 `restricted`를 확인한다. Ctrl+C는 ShareAI 쪽에서 Esc와 같은 연결 끊김으로 처리된다(2026-11-13 확인).
- `claude.ai connectors are disabled ...` 경고는 `ANTHROPIC_AUTH_TOKEN`을 쓰고 있다는 안내이고 정상이다.
- 요청 하나에 입력이 약 4만 4천 토큰 나간다(Claude Code의 시스템 프롬프트와 도구 정의).

## 5. 결과 기록 (이 표를 채워서 공유)

| 조합 | T1 | T2 | T3 | T4 | T5 | 오류 문구·관찰 |
|---|---|---|---|---|---|---|
| Claude Code × Claude 구독 | ○ | ○ | ○ | ○ | ○ | 2026-11-13, 대화형, `setup-token` 계정. 사용자 보고로 전 항목 통과. 사용 기록: 요청 13건 중 성공 11건, 중단 2건(14:16, 14:31), 14:16 중단 73초 뒤 정상 응답, 미결 시도 없음 |
| Claude Code × Claude API | ○ | ○ | ○ | ○ | ○ | 2026-11-13, `claude -p`(비대화형)와 `sk-ant-usr-` 키로 확인. 대화형은 크레딧 미적용으로 400(0번). T2는 요청 2건(도구 호출, 최종 답) 성공. T3은 요청 성공만 확인했고 thinking 사용 여부는 미확인. T4는 Ctrl+C 뒤 `restricted`, 미결 시도 없음. T5는 60초 뒤 `no_known_block`과 정상 응답 확인, "직후 503"은 미관찰 |
| Codex × Codex 구독 | ○ | ○ | ○ | ○ | ○ | 2026-11-13, Codex CLI 0.167.2, `gpt-6.1-terra`. 사용자 보고로 전 항목 통과. 처음 두 번은 502로 실패했고(공급자가 `Content-Type` 없이 스트림을 보냄, ADR 0019 7번) 수정 뒤 새 계정으로 통과. 사용 기록: 요청 10건 중 성공 9건, 중단 1건, 117초 뒤 정상 응답. 실패한 두 계정(`codex-sub`, `codex-sub2`)은 `open`으로 남음 |
| Codex × OpenAI API | ○ | ○ | ○ | ○ | ○ | 2026-11-13, Codex CLI 0.167.2, `gpt-6.1-terra`. 사용자 보고로 전 항목 통과. 사용 기록: 요청 9건 중 성공 8건, 중단 1건, 그 뒤 정상 응답, 미결 시도 없음 |

실패가 있으면 다음도 함께 보낸다.
- 해당 시점의 `status` 출력
- 서버 창(A)의 오류 줄. 로그에는 자격증명이 기록되지 않도록 되어 있지만, 붙여넣기 전에 `sk-`·`user_`·`Bearer` 문자열이 없는지 확인한다.

## 6. 정리

- 창 C·D를 닫는다(환경 변수는 창을 닫으면 사라진다). 필요하면 `shareai.config.toml`을 지운다.
- 검증 DB `data/phase5-verify.db`에는 실제 자격증명이 암호화되어 저장돼 있다. 더 쓰지 않으려면 서버를 끄고 `data/phase5-verify.db*` 파일을 지운다.
- `login`으로 만든 구독 세션은 공급자 쪽 계정 설정에서 로그아웃하거나 폐기할 수 있다.

## 이 확인으로 판정한 가정 (2026-11-13)

- Claude 구독 토큰(`setup-token`)은 Claude Code 원문 요청에 OAuth 베타 병합만으로 응답한다. **확인.** `login anthropic`으로 만든 OAuth 계정은 시험하지 않았다.
- Codex 구독 백엔드는 Codex CLI 원문 본문을 받아들인다. **확인.** 다만 응답에 `Content-Type`이 없어서 라우터를 고쳐야 했다(ADR 0019 7번).
- Codex CLI는 ShareAI의 `/v1/responses`만으로 동작했다. 모델 목록은 `chatgpt.com`에 직접 요청했다(Codex 로그 기준).
- 실제 thinking 무음 시간이 무응답 제한 300초 안에 드는지는 **판정하지 못했다.** 짧은 질문만 시험했다.

남은 한계

- Claude API 키 조합은 비대화형(`claude -p`)으로만 확인했다.
- 각 조합의 T3에서 모델이 실제로 thinking·reasoning을 썼는지는 사용 기록으로 확인할 수 없다.
- 계정 하나로 요청 하나만 처리하는 제한과 Codex의 동시 요청이 부딪혀 재시도가 보였는지는 기록하지 않았다.
