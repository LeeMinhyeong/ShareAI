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

## 5. 결과 기록 (이 표를 채워서 공유)

| 조합 | T1 | T2 | T3 | T4 | T5 | 오류 문구·관찰 |
|---|---|---|---|---|---|---|
| Claude Code × Claude 구독 | | | | | | |
| Claude Code × Claude API | | | | | | |
| Codex × Codex 구독 | | | | | | |
| Codex × OpenAI API | | | | | | |

실패가 있으면 다음도 함께 보낸다.
- 해당 시점의 `status` 출력
- 서버 창(A)의 오류 줄. 로그에는 자격증명이 기록되지 않도록 되어 있지만, 붙여넣기 전에 `sk-`·`user_`·`Bearer` 문자열이 없는지 확인한다.

## 6. 정리

- 창 C·D를 닫는다(환경 변수는 창을 닫으면 사라진다). 필요하면 `shareai.config.toml`을 지운다.
- 검증 DB `data/phase5-verify.db`에는 실제 자격증명이 암호화되어 저장돼 있다. 더 쓰지 않으려면 서버를 끄고 `data/phase5-verify.db*` 파일을 지운다.
- `login`으로 만든 구독 세션은 공급자 쪽 계정 설정에서 로그아웃하거나 폐기할 수 있다.

## 미확인 가정 (이 확인으로 판정할 것)

- Claude 구독 토큰(setup-token·OAuth)이 Claude Code 원문 요청에 OAuth 베타 병합만으로 응답하는지
- Codex 구독 백엔드(`chatgpt.com/backend-api/codex/responses`)가 Codex CLI 원문 본문을 받아들이는지(`store:false` 등)
- Codex CLI가 사용자 정의 공급자에 대해 `/v1/models` 같은 다른 엔드포인트를 요구하는지
- 실제 thinking 무음 시간이 무응답 제한 300초 안에 드는지
