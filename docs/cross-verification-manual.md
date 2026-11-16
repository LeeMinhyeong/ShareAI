# 실제 계정 확인 매뉴얼: 교차 변환·동시 한도 (ADR 0021·0022·0023)

이 확인은 **사용자가 직접** 실행한다. 공급자 자격증명과 ShareAI 사용자 키는 채팅에 붙여넣지 않는다. 공유할 것은 자동 확인 결과 파일(`data/verify-*.json`, 키·UUID·조직 ID가 가려져 있음)과 아래 결과표뿐이다.

- 소요 시간: 약 1시간 (자동 확인 15분, 클라이언트 확인 40분)
- 명령은 PowerShell 기준이다. 모든 명령은 **프로젝트 폴더에서** 실행한다(스크립트가 `.env`와 `data/`를 상대 경로로 찾음).
- 이전 확인(2026-11-13, Phase 5 기본 4조합)의 기록은 [phase5-real-verification.md](phase5-real-verification.md)에 있다.

## 무엇을 확인하나

| 항목 | 내용 | 확인 방법 |
|---|---|---|
| ADR 0023 | Codex에서 Claude 모델 사용(Claude 구독 계정) | 자동 `probe claude` + Codex 실사용 |
| ADR 0022 | Claude Code에서 GPT 모델 사용(Codex 구독, OpenAI API 키) | 자동 `probe gpt` + Claude Code 실사용 |
| ADR 0021 | 계정당 동시 한도 2에서 공급자가 429를 내지 않는지 | 자동 `probe parallel` |
| (가) | 계정이 없을 때 403 문구가 클라이언트에 보이는지 | 자동 `probe empty` + 클라이언트 화면 |

미리 알아둘 것:
- 실제 Claude Code 2.1.323과 Codex 0.167.2를 **가짜 공급자를 붙인 로컬 라우터**에 연결해 도구 대화·`apply_patch`·모델 전환·thinking 재전송까지 끝까지 동작하는 것은 확인해 두었다(2026-11-16). 이번에 확인할 것은 **실제 공급자가 받아 주는지**다.
- 구독 계정을 다른 클라이언트 형식으로 쓰는 것은 공식 사용법이 아니다. 특히 Codex→Claude 구독은 Claude Code인 척 요청한다(ADR 0023 결정 5). 공급자가 거부하거나 계정을 제한할 수 있다.
- 자동 확인은 짧은 요청을 모델 하나당 약 15번 보낸다. 구독 사용량이 조금 줄어든다. 다른 사람이 풀을 덜 쓰는 시간에 한다.
- 자동 확인 결과는 **그때 활성화된 계정 종류**에 대한 것이다. 그래서 단계마다 `only <ID>`로 한 계정만 켜고 실행한다.
- 서버가 이 PC가 아니면 모든 창에서 먼저 `$env:SHAREAI_URL = "http://<서버 주소>:20100"`을 설정한다(기본은 `http://127.0.0.1:20100`). `codex-setup`도 이 값으로 프로필을 만든다.

## 1. 서버 준비 (창 A)

기존 `data/router.db`는 예전 형식이라 서버가 기동을 거부한다. 확인 전용 새 DB를 쓴다.

```powershell
cd C:\Users\Administrator\Desktop\Workspace\개발\라우터
git pull
npm install
$env:DATABASE_URL = "sqlite:./data/verify-cross.db"
npm run db:init          # 처음 한 번. 파일이 이미 있으면 거부함(정상)
npm run dev              # 포트 20100. 이 창은 띄워 둔다
```

## 2. 사용자 키와 빈 서버 확인 (창 B)

```powershell
cd C:\Users\Administrator\Desktop\Workspace\개발\라우터
node scripts/phase5-verify.mjs status                 # 서버 up, 계정 (none)
node scripts/phase5-verify.mjs user monday --save     # 키를 data\verify-user.key에 저장(화면에 안 나옴)
node scripts/phase5-verify.mjs probe empty            # PASS 3개 기대
```

- 관리자 키는 `.env`에서 자동으로 읽는다. 직접 입력하지 않는다.
- `probe empty`는 계정이 하나도 없을 때만 의미가 있다. **계정을 등록하기 전에** 실행한다.

빈 서버에서 클라이언트 화면도 본다(새 창 C에서):

```powershell
cd $env:TEMP
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:20100"
$env:ANTHROPIC_AUTH_TOKEN = Get-Content C:\Users\Administrator\Desktop\Workspace\개발\라우터\data\verify-user.key
claude -p "안녕"
```

통과 기준: 관리자에게 계정 등록을 요청하라는 403 문구가 보인다. 창 C는 닫는다.

## 3. 계정 등록 (창 B)

각 명령은 계정 ID를 출력한다. 아래 결과표에 적어 둔다.

```powershell
# Claude 구독: setup-token으로 만든 토큰을 파일로 저장해 가져온다(claude-token.txt는 .gitignore 대상)
claude setup-token                                      # 출력된 sk-ant-oat... 를 claude-token.txt에 저장
node scripts/phase5-verify.mjs import anthropic claude-sub1 .\claude-token.txt

# Codex 구독: 브라우저 로그인(localhost:1455 콜백. Codex CLI 로그인과 동시에 하지 말 것)
node scripts/phase5-verify.mjs login openai codex-sub1

# OpenAI API 키: 화면에만 입력하고 채팅에는 붙여넣지 않는다
$env:P5_OPENAI_KEY = Read-Host "OpenAI API key"
node scripts/phase5-verify.mjs import-env openai openai-api P5_OPENAI_KEY
Remove-Item Env:P5_OPENAI_KEY

node scripts/phase5-verify.mjs status                   # 모두 active / no_known_block
```

## 4. 자동 확인 (창 B)

결과는 줄마다 `PASS`/`FAIL`/`SKIP`으로 나오고, 마지막 줄에 저장 파일 이름이 나온다. FAIL이 있으면 표 아래 "FAIL일 때"를 본다.

### 4-1. ADR 0023: Codex 형식 + Claude 모델 (Claude 구독)

```powershell
node scripts/phase5-verify.mjs only <claude-sub1 ID>
node scripts/phase5-verify.mjs probe claude claude-opus-5-5 claude-haiku-5-5
```

- 쓰려는 Claude 모델 이름을 모두 적는다. 두 개 이상이면 모델 전환 확인도 한다.
- 항목: `basic`, `effort low/medium/high/xhigh/none`, `tool call`, `tool result`(thinking 서명 재전송), `mid-loop no thinking`, `model switch`, `freeform tool`·`freeform result`(apply_patch 형식), `stream`.

### 4-2. ADR 0022: Claude Code 형식 + GPT 모델

```powershell
node scripts/phase5-verify.mjs only <codex-sub1 ID>
node scripts/phase5-verify.mjs probe gpt gpt-6.1-terra
node scripts/phase5-verify.mjs only <openai-api ID>
node scripts/phase5-verify.mjs probe gpt gpt-6.1-terra
```

- OpenAI API 키로 `gpt-6.1-terra`를 쓸 수 없으면 그 키로 되는 모델 이름을 넣는다.
- 항목: `messages basic`, `messages (high)`(이름 접미사), `messages tool call`·`tool result`, `chat completions`.

### 4-3. ADR 0021: 동시 한도 2

```powershell
node scripts/phase5-verify.mjs only <codex-sub1 ID>
node scripts/phase5-verify.mjs concurrency <codex-sub1 ID> 2
node scripts/phase5-verify.mjs probe parallel gpt-6.1-terra 2

node scripts/phase5-verify.mjs only <claude-sub1 ID>
node scripts/phase5-verify.mjs concurrency <claude-sub1 ID> 2
node scripts/phase5-verify.mjs probe parallel claude-haiku-5-5 2
```

통과 기준: `PASS ... (overlapping)` — 두 요청이 같은 계정에서 동시에 처리되고 둘 다 성공.

### FAIL일 때

| 항목 | 문구 예 | 뜻 | 할 일 |
|---|---|---|---|
| `effort ...` (none은 PASS) | `HTTP 400: ... adaptive ...`, `... effort ...` | 그 모델이 Claude Code 형식의 추론 레벨을 받지 않음(ADR 0023 리뷰 차단 지적 B) | 결과 파일 공유. 모델별 형식표를 둘지, 그 모델을 거부할지 정해야 함 |
| `basic`까지 FAIL | `HTTP 400/401/403 ...` | 구독이 이 형식 자체를 거부 | 결과 파일 공유 |
| `tool call`, `freeform tool` | `the model answered without calling the tool twice` | 모델이 도구를 안 씀(스크립트가 이미 한 번 다시 시도함) | 다시 실행. 또 나오면 공유 |
| `tool result` | `... signature ...` | 실제 API가 재전송한 thinking 서명을 거부 | 공유(중요) |
| `mid-loop no thinking` | `... thinking ...` | 이어 가기 판정 가정이 틀림. 라우터를 "마지막 assistant에 thinking이 없으면 그 요청은 끈다"로 바꿔야 함 | 공유(중요) |
| `effort none` | `thinking came back although it was turned off` | 라우터가 thinking을 끄지 못함 | 공유 |
| `basic` | `no OK in the answer` | 응답은 왔지만 내용이 이상함 | 결과 파일 공유 |
| `model switch` | 아무 400 | 모델 전환 후 이어 가기 실패 | 공유 |
| `stream` | `last event: ...` | 스트림이 정상 종료되지 않음 | 공유 |
| `parallel` | `#2 HTTP 429: ...` (공급자 문구) | 공급자가 동시 2개를 거부 | 공유. 그 공급자는 한도 1로 둔다 |
| `parallel` | `#2 HTTP 429 ... retry` (라우터 문구), `(did not overlap)` | 한도가 2로 안 올라감 | `status`에서 `x2` 확인 후 다시 |

## 5. 클라이언트 실사용

빈 Git 폴더를 하나 만들어 쓴다.

```powershell
mkdir $env:TEMP\sharetest; cd $env:TEMP\sharetest; git init
"첫 줄`n둘째 줄" | Set-Content notes.txt
```

### 5-1. Codex × Claude 모델 (ADR 0023, Claude 구독만 활성)

Codex는 `claude-*` 모델 정보를 모르면 `apply_patch` 없는 기본 구성으로 내려간다. 먼저 프로필을 만든다(창 B, 한 번만):

```powershell
node scripts/phase5-verify.mjs codex-setup claude-opus-5-5 claude-haiku-5-5
```

- `~\.codex\shareai-claude.config.toml`과 `shareai-claude-models.json`을 만든다. 기존 Codex 설정과 로그인은 건드리지 않는다.
- PC의 Codex 모델 캐시가 필요하다. 오류가 나면 Codex를 평소처럼 한 번 실행한 뒤 다시 한다.
- 모델의 컨텍스트 창은 기본 200000으로 적고, 자동 압축은 그 80%에서 시작하게 한다. 다르면 `--context 1000000`처럼 준다.
- Codex를 업그레이드하면 `--force`를 붙여 다시 만든다(모델 캐시 형식이 바뀔 수 있음).

창 D:

```powershell
cd $env:TEMP\sharetest
$env:SHAREAI_API_KEY = Get-Content C:\Users\Administrator\Desktop\Workspace\개발\라우터\data\verify-user.key
codex --profile shareai-claude
```

| # | 할 일 | 통과 기준 |
|---|---|---|
| X1 | "notes.txt 읽고 요약해줘" | 파일 읽기 도구 → 답변. 추론 요약이 보임 |
| X2 | "notes.txt 끝에 '셋째 줄'을 추가해줘" | `apply_patch`로 수정(승인 요청 시 승인) → 파일이 실제로 바뀜 |
| X3 | 이어서 두세 턴 더 수정·질문 | 매 턴 오류 없음(thinking 서명 재전송) |
| X4 | `/model`로 `claude-haiku-5-5`로 바꾸고 계속 | 오류 없이 이어짐 |
| X5 | 긴 작업을 시키고 Esc | 중단됨. 창 B `status`에서 `open`이 남지 않음 |

### 5-2. Claude Code × GPT 모델 (ADR 0022)

`only <codex-sub1 ID>`로 Codex 구독만 활성화하고 창 E에서:

```powershell
cd $env:TEMP\sharetest
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:20100"
$env:ANTHROPIC_AUTH_TOKEN = Get-Content C:\Users\Administrator\Desktop\Workspace\개발\라우터\data\verify-user.key
claude --model "gpt-6.1-terra(high)"
```

- "모르는 모델이라 컨텍스트 창을 1M으로 가정한다"는 경고는 정상이다.

| # | 할 일 | 통과 기준 |
|---|---|---|
| C1 | "notes.txt 읽어줘" | Read 도구 → 답변 |
| C2 | "notes.txt에 한 줄 추가해줘" | Edit 도구로 수정 |
| C3 | `/model claude-opus-5-5`로 바꾸고 질문 → 다시 `/model gpt-6.1-terra(high)` | 이 단계만 Claude 구독도 활성화(`enable <claude-sub1 ID>`). 전환 후에도 대화가 이어짐 |

C1·C2를 `only <openai-api ID>`로 한 번 더 한다(OpenAI API 키).

- 평소 쓰는 MCP 서버가 켜진 상태로 한 번 해 본다. 도구가 많으면 Claude Code가 도구 검색(ToolSearch)을 쓰는데, 그 결과가 GPT 모델로 제대로 넘어가는지 보려는 것이다.

## 6. 결과표 (채워서 공유)

| 구분 | 결과 | 메모 |
|---|---|---|
| 계정 ID | claude-sub1 / codex-sub1 / openai-api | |
| 클라이언트 버전 | `claude --version` / `codex --version` | |
| probe empty + 403 화면 | | |
| probe claude (모델별) | PASS 개수 / FAIL 항목 | |
| probe gpt (Codex 구독) | | |
| probe gpt (OpenAI API 키) | | |
| probe parallel (Codex 구독, Claude 구독) | | |
| Codex × Claude X1~X5 | | |
| Claude Code × GPT C1~C3 (Codex 구독) | | |
| Claude Code × GPT C1~C2 (OpenAI API 키) | | |

함께 보낼 것:
- `data\verify-*.json` 파일들(이미 가려져 있음)
- 실패가 있었으면 그때의 `status` 출력과 서버 창(A)의 오류 줄. 붙여넣기 전에 `sk-`·`user_`·`Bearer` 문자열이 없는지 확인한다.

## 7. 정리

```powershell
# 서버(창 A) Ctrl+C 후
Remove-Item .\data\verify-cross.db*, .\data\verify-user.key, .\claude-token.txt
Remove-Item $env:USERPROFILE\.codex\shareai-claude.config.toml, $env:USERPROFILE\.codex\shareai-claude-models.json
```

- `verify-cross.db`는 이번 확인 전용이다. 지우면 확인용 사용자와 키, 여기 등록한 계정(구독 토큰 포함, 암호화되어 저장됨)이 모두 없어진다. 실제 운영용 DB는 따로 `npm run db:init`으로 만들고 계정을 다시 등록한다.
- DB 파일을 지우면 확인용 사용자와 그 키도 함께 없어진다. `data\verify-user.key`는 풀에 접근할 수 있는 실제 키이므로 반드시 지운다(Windows에서는 파일 권한 대신 사용자 폴더 권한으로만 보호된다).
- 창 C~E를 닫으면 환경 변수도 사라진다.
- `login`으로 만든 Codex 구독 세션은 ChatGPT 계정 설정에서 로그아웃할 수 있다.
- 결과 파일(`data\verify-*.json`)은 공유한 뒤 지워도 된다.
