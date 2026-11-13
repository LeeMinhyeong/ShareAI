# 다계정 AI 라우터

여러 사용자가 여러 AI 계정(Claude, GPT, Gemini)을 공유하여 사용할 수 있는 라우팅 서버입니다.

**OmniRoute**와 **opencodex** 분석을 기반으로 설계되었습니다.

## 🎯 핵심 기능

- ✅ **다계정 풀 관리**: A, B, C 계정을 여러 사용자가 공유
- ✅ **자동 로드밸런싱**: 라운드로빈, 우선순위, 최소 사용 전략
  - `least_used`는 일반/SIWC 계정별 완료 성공 로그를 동일한 UTC 날짜 범위로 비교하는 최선 노력 방식입니다. 로그는 응답 후 기록되므로 동시 요청, 기록 실패, 기존에 토큰 사용량 없이 성공해 로그가 남지 않은 요청으로 실제 성공 수보다 적을 수 있습니다. 과거 일반 계정 로그의 0은 측정된 0인지 미보고인지 알 수 없습니다. 새 작업본은 미보고와 측정된 0을 구분하지만 전환과 전체 검증은 미완료입니다. 할당량 예약과 무관하며 보안·과금·정확한 쿼터 집행에 사용하지 않습니다. `usedToday`는 이전 성공 기록으로 일일 초기화가 보장되지 않습니다. 계정 일일 한도의 집행은 별도의 `account_daily_reservations`에서 수행됩니다.
  - 일반/SIWC 혼합 후보의 `priority`는 우선순위를 먼저 적용하고 동률일 때만 양쪽의 같은 UTC 날짜 완료 성공 로그를 비교합니다. 이 최선 노력 동률 기준은 할당량 집행에 사용하지 않습니다. 일반 계정만 남은 경우 기존 `priority` 동작을 유지합니다.
  - 집계는 UTC 자정부터 선택 시점까지이며 미래 로그는 제외합니다. 실제 전송된 일반 요청의 실패 로그도 최선 노력으로 기록하며, 로그 시간은 벽시계, 지연은 단조 시계를 사용합니다. 기록은 응답 또는 정산과 원자적이지 않습니다. [상세](./docs/usage-completion-time.md)
- ✅ **할당량 추적**: 계정별 일일 한도 자동 감지
- ✅ **사용자 격리**: 사용자별 API 키 및 사용량 추적
- ✅ **프로토콜 번역**: OpenAI Chat ↔ Anthropic Messages ↔ Responses
- 🚧 **자동 전환**: 같은 요청의 다른 계정 재시도는 아직 구현·검증되지 않았습니다.

## 📐 아키텍처

```
사용자1, 2, N → 라우터 서버 (인증 + 계정 풀 관리) → 계정 A, B, C → Claude/GPT/Gemini
```

자세한 설계는 **[다계정-라우터-설계.md](./다계정-라우터-설계.md)** 참조.

## 🚀 빠른 시작

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경 변수 설정

```bash
cp .env.example .env
nano .env
```

**필수 설정:**
```bash
# 암호화 키 생성 (32바이트)
openssl rand -hex 32

# 관리자 키 생성
openssl rand -base64 48
```

### 3. 데이터베이스 초기화

> **현재 작업본 운영 적용 금지:** Phase 4의 안전 스키마(계정별 OPEN 표식, 429 v2)가 없는 기존 DB는 시작과 `npm run db:migrate`가 거부합니다. 기존 DB 업그레이드는 Phase 4 범위 밖이며 업그레이드 스크립트는 비활성 상태입니다([ADR 0018](./docs/adr/0018-fresh-database-creation.md), [ADR 0013](./docs/adr/0013-pre-429-historical-upgrade.md)). 아래 절차는 그 문제가 해결되기 전에는 기존 DB에 실행하지 마세요. 테스트는 격리된 신규 DB에서만 진행합니다. [ADR 0008](./docs/adr/0008-new-request-account-429-policy.md) 참고.

> **종료 안전성 미완료:** v1 인증 scope 경계를 일부 변경했지만 전체 요청·백그라운드 작업 drain 및 DB 종료 안전성은 검증되지 않았습니다. 운영 적용 금지는 유지됩니다. [ADR 0010](./docs/adr/0010-v1-authentication-scope-boundary.md) 참고.

현재 SQLite 파일 DB만 지원합니다. 메모리 DB(`sqlite::memory:`)는 지원하지 않습니다.

새 DB는 `npm run db:init`으로만 만듭니다([ADR 0018](./docs/adr/0018-fresh-database-creation.md)). 이 명령은 `DATABASE_URL` 경로에 파일이 **없을 때만** 새 파일(필요하면 상위 폴더 포함)을 만들고 안전 스키마와 전체 스키마를 넣습니다. 빈 파일을 포함해 이미 있는 경로는 거부합니다. 서버 시작과 `npm run db:migrate`는 DB를 만들지 않으므로, 경로를 잘못 적으면 조용히 빈 DB가 생기지 않고 시작이 실패합니다.

```bash
npm run db:init      # 최초 1회: 새 DB 생성
npm run db:migrate   # 이후: 기존(이 버전으로 만든) DB의 스키마 확인·갱신
```

서버 시작 시에도 listen 전에 스키마 초기화가 실행되어 DB가 변경될 수 있습니다. 중요한 데이터는 백업하세요. **아래 내용은 현재 작업본에 대한 운영 승인 절차가 아닙니다.**

#### 기존 DB 할당량 마이그레이션: 역사적 설명 (실행 금지)

**아래는 실행 절차가 아니며 전환, 배포, 시작, 트래픽 재개 또는 복원을 승인하지 않습니다.** 현재 작업본을 기존 DB나 운영 환경에 적용하지 마세요. 안전한 운영 마이그레이션과 복구 경로는 아직 구현·검증되지 않았습니다. 실험용 도구의 제한은 [오프라인 OPEN 스키마 문서](./docs/offline-open-upgrade.md)를 참고하세요.

이전 전환 구상은 요청 유입과 모든 writer의 중지, 일관된 백업, 할당량 대조 및 이후 배포를 전제로 했지만, 그 전제는 자동으로 확인되지 않으며 안전성을 입증하지 않습니다. 마이그레이션은 기존 성공 `usage_logs`를 사용자·UTC 날짜별 할당량에 한 번만 반영합니다. 이후 구버전이나 진행 중이던 요청이 성공 로그를 추가하면 누락분은 재실행으로 반영되지 않을 수 있습니다. DB 잠금도 구버전의 추후 접근을 막지 못합니다.

마이그레이션된 DB에 구버전을 연결하는 것은 안전한 롤백이 아닙니다. 백업 복원도 이후 요청·할당량 사용, 계정 변경 및 외부 제공자 토큰 회전과 불일치할 수 있으며 복구 가능성이나 데이터 무손실을 보장하지 않습니다.

### 4. 서버 실행

```bash
# 개발 모드 (핫 리로드)
npm run dev

# 프로덕션 빌드
npm run build
npm start
```

서버가 `http://localhost:20100`에서 실행됩니다. `GET /health`는 프로세스의 liveness 확인이며 DB 상태나 외부 제공자 연결을 검사하는 readiness 검사가 아닙니다.

**종료 안전성 미완료:** 정상 종료는 모든 인증·라우트·응답 후 작업과 독립 refresh/callback의 완료를 증명하지 못합니다. 임시 방어로 등록된 작업이 drain된 이후에도 DB 연결을 프로세스 종료까지 유지하고 5초 제한 타이머는 `unref()`합니다. 활성 핸들이 없으면 미완료 Promise가 있어도 프로세스가 종료될 수 있으며, 활성 핸들이 있으면 제한시간에 오류 코드로 강제 종료될 수 있습니다. 명시적 DB close·checkpoint나 graceful shutdown을 보장하지 않습니다. 운영 적용하지 마세요. [ADR 0009](./docs/adr/0009-shutdown-deadline-database.md).

## 📚 사용법

### 계정 추가 (관리자)

```bash
curl -X POST http://localhost:20100/admin/accounts \
  -H "Authorization: Bearer admin_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Claude-A",
    "provider": "anthropic",
    "credentialType": "api_key",
    "credentials": "sk-ant-api03-...",
    "dailyQuota": 1000,
    "priority": 0
  }'
```

일반 계정의 생성(`POST /admin/accounts`) 또는 수정(`PATCH /admin/accounts/:id`) 시 제공하는 `priority`는 0 이상의 안전한 정수, `weight`는 1 이상의 안전한 정수여야 합니다. 문자열, null, 소수 및 안전한 정수 범위를 벗어난 값은 HTTP 400으로 거부됩니다. 생성 시 생략하면 각각 0과 1을 사용합니다. 기존의 유효하지 않은 저장값을 자동 수정하지 않으며, 해당 필드를 생략한 다른 수정은 계속 허용합니다. 기존 저장값의 라우팅 fallback 동작도 변경하지 않습니다. 이는 신규 제출에 대한 호환성 변경입니다.

### 사용자 추가

```bash
curl -X POST http://localhost:20100/admin/users \
  -H "Authorization: Bearer admin_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "사용자1",
    "email": "user1@example.com",
    "tier": "pro",
    "dailyLimit": 500
  }'

# 응답에서 apiKey를 저장
```

### AI 요청 보내기

```bash
# OpenAI Chat 형식
curl -X POST http://localhost:20100/v1/chat/completions \
  -H "Authorization: Bearer user_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      {"role": "user", "content": "안녕하세요"}
    ],
    "stream": true
  }'
```

`/v1/chat/completions`의 선택적 `router_options`는 객체여야 합니다.
`strategy`는 `priority`, `least_used`, `round_robin` 중 하나이며 생략 시
서버의 제공자별 설정을 사용합니다. `siwc_account_id`는 OpenAI 모델에만
사용할 수 있는 비어 있지 않은 문자열이며 `strategy`와 함께 지정할 수 없습니다.
`null` 같은 잘못된 값, 알 수 없는 필드 및 미구현 `prefer_accounts`, `fallback`은
무시하지 않고 HTTP 400으로 거부합니다. 이 필드는 [초기 설계](./다계정-라우터-설계.md)의
제안일 뿐 현재 기능이 아닙니다.

## 🔒 보안 고려사항

⚠️ **중요**: 이 프로젝트는 교육 및 연구 목적입니다.

### 안전한 사용

✅ **권장**:
- API 키 기반 제공자만 사용 (공식 API)
- 개인 또는 소규모 팀 내부에서만 사용
- HTTPS 필수 (프록시 또는 Let's Encrypt)

❌ **위험** (약관 위반 가능성):
- Claude Pro/ChatGPT Plus 구독 웹 세션 사용
- 공식 클라이언트 User-Agent 사칭
- 공개 프록시로 서비스 제공

자세한 내용은 [다계정-라우터-설계.md § 6. 약관 준수](./다계정-라우터-설계.md#6-약관-준수-가이드라인) 참조.

## 🗂️ 프로젝트 구조

```
multi-account-router/
├── src/
│   ├── server.ts              # 서버 진입점
│   ├── config/
│   │   └── env.ts             # 환경 변수
│   ├── auth/                  # 인증
│   ├── account-pool/          # 계정 풀 관리
│   │   └── manager.ts
│   ├── protocol/              # 프로토콜 번역
│   │   ├── types.ts
│   │   ├── decoders/
│   │   ├── adapters/
│   │   └── encoders/
│   ├── db/                    # 데이터베이스
│   │   └── schema.ts
│   └── utils/
│       ├── logger.ts
│       └── encryption.ts
├── 다계정-라우터-설계.md      # 📖 설계 문서
├── OmniRoute-vs-opencodex-보고서.html
└── package.json
```

## 📖 참고 자료

- **[설계 문서](./다계정-라우터-설계.md)**: 전체 아키텍처 및 구현 가이드
- **[ADR 0001: ChatGPT 구독 연동](./docs/adr/0001-chatgpt-subscription-integration.md)**: SIWC 우선 및 Codex 호환 경로 결정
- **[ADR 0002: 계정 풀 공유 범위](./docs/adr/0002-account-pool-access-control.md)**: 관리자 공유 설정과 사용자 접근 제어
- **[ADR 0003: SIWC 로그아웃](./docs/adr/0003-siwc-logout-fencing.md)**: 토큰 갱신 경합 및 원격 폐기 불확실성 처리
- **[ADR 0004: 계정별 일일 할당량 예약](./docs/adr/0004-account-quota-reservations.md)**: UTC 기준 원자적 예약 제안과 오프라인 전환 전제 (구현 중)
- **[ADR 0005: 안전한 요청 장애 전환](./docs/adr/0005-retry-failover-policy.md)**: 재발송 안전 조건과 미확인 제공자 정책 (제안)
- **[ADR 0006: 공유 쿨다운과 불확정 요청 보호](./docs/adr/0006-shared-cooldown-fencing.md)**: 다중 프로세스 제한 상태와 장애 복구 설계 (제안·미구현)
- **[ADR 0007: 복구 근거 기록 실험](./docs/adr/0007-recovery-evidence-experiment.md)**: 복구 권한을 부여하지 않는 격리 실험
- **[ADR 0008: 429 이후 새 요청의 계정 선택](./docs/adr/0008-new-request-account-429-policy.md)**: 사용자가 결정한 다계정 선택 방향과 제공자 정책의 불확실성
- **[ADR 0009: 종료 기한과 DB 작업](./docs/adr/0009-shutdown-deadline-database.md)**: 종료 기한과 DB 작업 소유권의 안전 경계
- **[ADR 0010: v1 인증 소유권](./docs/adr/0010-v1-authentication-scope-boundary.md)**: 인증과 요청 작업의 소유권 경계
- **[ADR 0011: 일반 요청의 알 수 없는 토큰 사용량](./docs/adr/0011-ordinary-token-usage-unknown.md)**: 측정값과 출처를 알 수 없는 기존 기록의 구분
- **[ADR 0012: 확인된 추론 5xx의 공유 계정 제한](./docs/adr/0012-shared-5xx-restriction.md)**: 5xx 제한과 OPEN 정산, 공유 범위와 검증 한계
- **[ADR 0013: 429 도입 이전 DB의 오프라인 전환](./docs/adr/0013-pre-429-historical-upgrade.md)**: 과거 스키마 인식과 별도 출처 확인, 안전 전제
- **[ADR 0014: 오프라인 전환·복구 하드링크 검사](./docs/adr/0014-offline-hard-link-checks.md)**: 링크 수 확인과 남은 파일 경합 한계
- **[ADR 0015: 리스너 확보 후 DB 초기화](./docs/adr/0015-listener-before-database.md)**: bind 실패 전 DB 변경 방지와 readiness 게이트의 한계
- **[ADR 0016: Phase 4 완료 범위 고정](./docs/adr/0016-phase4-scope-freeze.md)**: 새 요청 전환, 핵심 종료 drain, 시간 제한 방식, 중단된 OPEN 처리
- **[ADR 0017: 공급자 스트림 정리는 best-effort](./docs/adr/0017-best-effort-stream-disposal.md)**: 취소 완료를 기다리지 않고 오류 분류로 OPEN 유지
- **[ADR 0018: 새 DB 생성과 기존 DB·메모리 DB 범위](./docs/adr/0018-fresh-database-creation.md)**: `db:init` 전용 생성, 기존 DB 업그레이드 보류, 메모리 DB 미지원
- **[비교 분석 보고서](./OmniRoute-vs-opencodex-보고서.html)**: OmniRoute vs opencodex 코드 분석
- [OmniRoute GitHub](https://github.com/cheaper-inference/OmniRoute)
- [opencodex GitHub](https://github.com/lidge-jun/opencodex)

## 🛠️ 개발 로드맵

코드 리뷰에서 분리한 개선 사항과 미검증 항목은 **[개선 백로그](./BACKLOG.md)**에서 관리합니다.

현재 작업 초점은 **Phase 4 라우팅과 자동 전환**입니다. Phase 3의 실제 구독 계정 검증은 완료되지 않았으며, 다른 Phase의 일부 기능은 병행 개발된 상태입니다.

각 Phase는 **개발 → 코드 리뷰 및 발견 사항 처리 → 테스트 → 완료** 순서로 진행합니다. 테스트 전에 코드 리뷰를 수행하고, 리뷰에서 발견한 문제를 처리한 뒤 해당 Phase의 완료 기준에 따른 테스트를 실시합니다. 구현만 끝났거나 리뷰·테스트가 남아 있는 Phase는 완료로 표시하지 않습니다. 상태는 미착수 → 구현 중 → 코드 리뷰 중 → 테스트 중 → 완료로 관리합니다.

| Phase | 목표 | 완료 기준 | 현재 상태 |
|---|---|---|---|
| **1. 기반 구조** | 서버, 프로젝트 구조, 기본 설정 | 서버 기동·빌드·헬스체크 통과 | 완료: 독립 리뷰 및 격리 테스트 확인 |
| **2. 저장소와 인증** | DB, 계정·사용자 관리, 자격증명 암호화 | CRUD·마이그레이션·인증·암호화 테스트 통과 | 완료: 독립 리뷰 및 격리 테스트 확인 |
| **3. 구독 계정 연결** | Claude·ChatGPT 계정 로그인, 가져오기, 토큰 갱신 | 각 제공자의 실제 구독 계정으로 로그인하고 요청 성공 | 구현 중 / 리뷰 지적 및 실제 계정 검증 미완료 |
| **4. 라우팅과 자동 전환** | 전략 선택, 계정 상태·할당량, 429/5xx 전환 | 다중 계정 테스트에서 선택·쿨다운·자동 전환 확인 | 일부 구현 / 자동 전환 미완료 |
| **5. 클라이언트 호환** | Claude Code·Codex 요청/응답, 스트리밍, thinking, tool call | 각 CLI/App에서 실제 작업과 스트리밍·도구 호출 검증 | 일부 구현 / 대부분 미검증 |
| **6. 대시보드와 운영** | 계정·사용자·통계 UI, 모니터링, 배포·보안 | UI 연동, 사용량·상태 표시, 재시작·보안·운영 테스트 통과 | 대시보드 기본 구현 / 운영 검증 미완료 |

> 기존 설계 문서의 4단계 로드맵은 초기 구상입니다. 현재 진행 관리는 위 6단계를 기준으로 합니다.

### Phase 1. 기반 구조

**목표:** 서버, 프로젝트 구조, 기본 설정을 마련합니다.  
**현재 상태:** 완료. 별도 에이전트의 코드 리뷰와 지적 사항 수정 후, `npm test` 95건 통과 및 `npm run build` 성공을 확인했습니다. 테스트는 격리 DB와 모의 업스트림을 사용했으며 헬스체크는 의존성 준비 상태가 아닌 서버 응답성(liveness)만 확인합니다. 실제 구독 계정 검증은 Phase 3에 남아 있습니다.

- 서버 진입점과 프로젝트 디렉터리 구조 구성
- 환경 변수와 기본 서버 설정 구성
- **완료 기준:** 서버 기동·빌드·헬스체크 통과

### Phase 2. 저장소와 인증

**목표:** DB, 계정·사용자 관리, 자격증명 암호화를 구현합니다.  
**현재 상태:** 완료. 별도 에이전트의 코드 리뷰 및 지적 사항 수정과 수정 범위 재리뷰 후, 격리 환경에서 전체 `npm test` 145건 통과 및 `npm run build` 성공을 확인했습니다. 이는 현재 작업본의 기존 운영 DB 전환이 안전함을 뜻하지 않으며, 위 설명은 실행 절차가 아닙니다. 레거시 평문 또는 복호화할 수 없는 자격증명은 자동 신뢰·변환하지 않아 관리자의 재등록이 필요합니다. 실제 구독 계정 검증은 Phase 3에 남아 있습니다.

- 계정·사용자 및 사용 기록을 저장하는 DB 구성
- 계정과 사용자 관리 기능 및 인증 처리
- 자격증명 암호화와 기존 데이터 마이그레이션 처리
- **완료 기준:** CRUD·마이그레이션·인증·암호화 테스트 통과

### Phase 3. 구독 계정 연결

**목표:** Claude·ChatGPT 계정 로그인, 자격증명 가져오기, 토큰 갱신을 지원합니다.  
**현재 상태:** 구현 중 / 실제 계정 검증 미완료. Codex 가져오기와 별도의 공식 SIWC 흐름을 개발하고 로그아웃·갱신 경합에 대한 독립 재리뷰를 진행했습니다. 사용자가 실행한 격리 백엔드 전체 `npm test`는 283건 통과했습니다. 기존 Codex 경로를 공식 SIWC 흐름으로 간주하지 않으며, 실제 구독 계정 로그인과 추론 성공은 검증되지 않았습니다.

**제공자 정책 주의:** Anthropic은 제3자 애플리케이션의 Claude.ai 로그인 제공, Free/Pro/Max 자격증명을 통한 사용자 대신의 요청 라우팅, Claude.ai 자격증명 또는 세션 토큰의 수집·보관·중개를 허용하지 않는다고 명시합니다. 이 프로젝트의 현재 구독 공유 방식은 해당 정책과 충돌할 수 있으며, 계정 제재 위험이 있습니다. 실제 사용 전 [Anthropic 정책](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)을 확인하십시오. OpenAI의 [오픈소스 앱용 ChatGPT 플랜 사용 문서](https://developers.openai.com/siwc/token-sharing-open-source)는 별도의 인증 흐름과 조건을 정의합니다.

- Claude 및 ChatGPT 구독 계정 로그인 흐름 구현
- 기존 자격증명 가져오기와 토큰 갱신 처리
- 각 제공자별 실제 계정 로그인 및 추론 요청 검증
- **완료 기준:** 각 제공자의 실제 구독 계정으로 로그인하고 요청 성공

### Phase 4. 라우팅과 자동 전환

**목표:** 전략 선택, 계정 상태·할당량 관리, 429/5xx 자동 전환을 구현합니다.  
**현재 상태:** 완료 (2026-11-10, [ADR 0016](./docs/adr/0016-phase4-scope-freeze.md) '완료 판정'). 고정된 네 항목은 격리 파일 DB와 합성 공급자를 쓰는 실제 서버 프로세스 테스트로 확인했습니다. 전체 테스트는 238/264 통과했고 새로 실패한 파일은 없습니다. 나머지 26개는 사용자 승인을 받아 BACKLOG 'Phase 4 보류 테스트'로 넘겼습니다. 실제 제공자, 실제 구독 계정, 운영 DB로는 아직 검증하지 않았습니다. 아래 '미완료 및 운영 차단' 목록은 Phase 4 진행 중 기록이며, 이후 범위로 넘긴 항목이 포함되어 있습니다.

**미완료 및 운영 차단:**
- 선택하신 정책에 따라 A의 429 이후 **새 요청**은 적격 B를 선택할 수 있습니다. 이미 발송한 동일 요청의 429/5xx 자동 재발송은 구현되지 않았습니다. 제공자 정책상 허용과 제한 범위는 미확인입니다.
- 확인된 추론 HTTP 5xx는 기존 v2 공유 제한 저장소에 기록하고 OPEN 정리와 같은 트랜잭션에서 처리하도록 연결했습니다. 수정 후 일반 계정의 별도 프로세스·파일 SQLite 집중 테스트는 Node 집계 10/10, SIWC 메모리 SQLite 집중 테스트는 5/5 통과했습니다. 모의 요청·응답과 합성 제공자를 사용했으며 실제 제공자·SIWC 다중 프로세스·디스크 장애는 검증하지 않았습니다. 제한은 공유되지만 연속 실패 횟수는 프로세스별 메모리에 남고, `429`라는 기존 테이블 이름에 5xx도 저장되므로 행만으로 원인을 구분할 수 없습니다. [ADR 0012](./docs/adr/0012-shared-5xx-restriction.md).
- 새 유한 429 제한은 선택·발송 및 일부 응답 처리 경로에 단조 관찰 기반 v2 저장소를 연결했습니다. 일반 계정의 인증·합성 제공자·메모리 SQLite 경로에서는 시계 변경과 관찰자 재생성 후 전체 대기 재시작을 확인했습니다. 사용자가 별도 세션에서 실행한 SIWC 인증 경로 집중 테스트는 HTTP 유한·기한 불명 제한과 제공자 스트림 429의 세 사례 모두 통과했다고 보고했습니다. 해당 검증은 합성 제공자, 메모리 SQLite, 비스트리밍 클라이언트 요청이며, 실제 프로세스 재시작·파일 DB 동시성·클라이언트 스트리밍 및 제한 기록 실패 시 롤백은 검증하지 않았습니다.
- 불확정 OPEN은 자동 만료되지 않습니다. 기존 429 제한과 정수형 사용량을 함께 전환하는 코드가 있으나 직접 실행 CLI는 비활성 상태입니다. Windows 테스트 소유 파일에서 전환·재개방, 별도 연결 락, 중간 SQL 오류 롤백 및 기존·전환 중 생성된 하드링크 검사를 확인했습니다(외부 1/1·내부 10개). 별도 OPEN 전환·복구 도구도 기존 하드링크 거부와 정상 경로를 확인했습니다. 저장된 `740df93` 초기화 스키마의 합성 파일에서 OPEN 및 429 전환 후 별도 프로세스의 현재 DB 초기화도 확인했습니다(1/1). 과거 DB 출처는 스키마만으로 입증할 수 없으며 별도 운영자 확인이 필요합니다. 파일 교체 경합·실제 디스크 장애는 미검증이고, 정수가 아닌 기존 사용량은 전환하지 않고 거부합니다. 기존 운영 DB에 이 작업본을 적용하지 마세요. [검증 범위](./docs/offline-open-upgrade.md).
- DB 시작 시 사용량 스키마를 쓰기 잠금 안에서 재검사합니다. 사용자가 별도 세션에서 같은 메모리 DB 연결의 테이블 삭제를 주입한 집중 테스트는 통과했으나, 두 프로세스 간 파일 DB 경합과 디스크 내구성은 미검증입니다. 이 `.cjs` 테스트는 기본 `npm test` 검색 대상에 포함되지 않습니다.
- 요청 종료 후 DB를 사용할 수 있는 작업의 전역 종료 대기는 아직 증명되지 않았습니다. 별도 격리 루프백 시험에서는 합성 공급자 응답 후 지연된 사용량 기록과 요청 drain 누락 변형을 확인했고, 별도 자식 프로세스에서는 유휴 종료와 활성 핸들이 있을 때 5초 제한을 확인했습니다. 동일 사용량 기록의 직접 라우터 경로 회귀도 새 DB 유지 정책으로 갱신해 정상·drain 누락 변형을 포함한 외부 1/1이 통과했습니다(메모리 SQLite·가짜 리스너·테스트 전용 서버 소스 계측). 스케줄러와 명시적으로 등록된 합성 작업의 종료 회귀는 독립 리뷰 후 17/17 통과했고, 별도의 요청 소유권 종료 회귀는 24/24, DB 시작 실패·종료 합성 회귀는 3/3 통과했습니다. 이들 시험은 모의 의존성과 타이머를 사용하며 스케줄러 시험은 메모리 SQLite와 테스트 전용 소스 계측도 사용했습니다. 끊긴 v1 인증의 요청 소유권 집중 시험은 실제 Express 경로와 가상 스트림·모의 DB로 2/2 통과했습니다. 토큰 갱신의 진입 차단·저장·오류 처리 drain 집중 시험은 합성 저장소·제공자·타이머로 10/10 통과했습니다. 종료 관련 최상위 테스트 6개 파일을 함께 실행한 결과도 41/41 통과했습니다. 별도 OAuth 종료 재시도 시험은 모의 콜백 리스너·합성 환경으로 21/21 통과했습니다. 이들은 전체 `npm test`가 아닌 별도 선택 실행입니다. 실제 제공자·운영 DB·OS 신호와 전체 작업 소유권은 검증하지 않았습니다. 다른 기존 종료 회귀 테스트에는 이전 DB close 정책의 기대값이 남아 있어 전체 테스트를 통과한 상태가 아닙니다.
- 출처 불명 토큰 사용량은 측정된 0과 구분하도록 작업 중입니다. 사용자가 별도 세션에서 수정·실행한 집중 테스트는 외부 1/1 통과, 내부 5개 사례 완료로 보고됐습니다. 합성 공급자와 메모리 SQLite를 사용했으며 실제 파일 DB, 제공자 및 관리자 HTTP 경로는 검증하지 않았습니다. 별도 리뷰는 제어 흐름과 사례 요약을 대상으로 했고 모든 내부 assertion을 독립 검증한 것은 아닙니다.
- HTTP 리스너의 치명적 오류에서도 OAuth·SIWC 중단을 시도하도록 보강했습니다. 독립 리뷰 후 합성 시작·종료 테스트 28/28 및 별도 종료·OAuth 회귀 33/33이 통과했습니다. 실제 보조 리스너 종료나 전역 작업 drain을 입증한 것은 아닙니다. [ADR 0009](./docs/adr/0009-shutdown-deadline-database.md).
- SIWC 로그아웃은 종료 시작 후 신규 요청을 거부하고 진행 중인 핸들러를 최종 DB 검증·응답 호출까지 추적합니다. 별도 정적 리뷰 후 합성 writer·직접 핸들러 테스트 1/1과 타입 검사가 통과했으며, 실제 DB·관리자 인증·소켓 및 원격 폐기는 미검증입니다. [ADR 0009](./docs/adr/0009-shutdown-deadline-database.md).
- SIWC 계정 목록·라우팅 설정·접근 정책의 다섯 동기 DB 경로도 종료 소유권에 연결했습니다. 합성 DB·직접 핸들러 회귀와 로그아웃 회귀의 선택 실행은 12/12이며 실제 인증·SQLite·소켓과 전역 종료 안전성은 미검증입니다. [ADR 0009](./docs/adr/0009-shutdown-deadline-database.md).
- `least_used`와 오늘 통계는 UTC 기준의 best-effort 사용 기록이며 정확한 quota 예약 수치가 아닙니다. Codex의 reasoning·도구 호출 등은 미지원입니다.

**검증 상태:** 사용자 인증 HTTP·합성 제공자·독립 SQLite 프로세스에 대한 여러 집중 테스트와 TypeScript 타입 검사가 보고됐고 각 변경 범위는 별도 정적 리뷰를 거쳤습니다. snapshot 서버 기본 테스트는 환경 상속과 port 0을 제거한 뒤 Windows named pipe·합성 파일 DB에서 1/1 통과했습니다(실제 TCP와 POSIX는 미검증). 이는 실제 제공자 호환성이나 전체 테스트 통과를 뜻하지 않습니다. 기본 테스트 실행의 확인된 안전성 차단 항목은 [테스트 실행 안전성 문서](./docs/phase4-test-execution-safety.md)를 참고하세요.

- 우선순위·라운드로빈·최소 사용 전략 선택
- 계정 상태 및 할당량을 고려한 후보 선택과 쿨다운 처리
- 429 및 5xx 오류 후 **새 요청**의 다른 계정 전환 (같은 요청 재전송은 범위 밖)
- **완료 기준:** 다중 계정 테스트에서 선택·쿨다운·자동 전환 확인

**고정된 완료 체크리스트 ([ADR 0016](./docs/adr/0016-phase4-scope-freeze.md), 2026-11-09 사용자 승인):**
- [x] 새 요청 전환: 격리 파일 DB를 공유하는 라우터 두 프로세스·합성 공급자에서 A의 429 1회, 다른 프로세스의 다음 요청 B 선택, 재시작 후 제한 유지, 고정 SIWC 비전환 확인
- [x] 종료: DB 사용 경로 전체 목록화 및 요청 처리·정산·토큰 갱신·SIWC/OAuth 작업의 종료 소유권 확인 (정상 DB close는 Phase 6) — [DB 생산자 목록](./docs/db-producer-inventory.md), 종료 drain 인수 테스트 4/4, 리뷰 PASS. keep-alive 유휴 연결 때문에 종료가 늦어지는 문제는 BACKLOG에 우선순위 높음으로 등록
- [x] 시간 제한: 120초 전체 제한을 첫 응답 60초 + 무응답 300초 제한으로 대체 — 독립 리뷰 3회(최종 PASS), 집중 테스트 12/12
- [x] 중단된 OPEN: 취소·시간 초과 후 OPEN 잔존 재현 및 처리 정책 구현 (ADR 0008 개정) — 독립 리뷰·재리뷰 완료, 집중 테스트 9/9
- [x] 별도 에이전트 리뷰·재리뷰, `npm run build` 통과, 격리 전체 테스트 238/264(새 실패 0개, 보류 26개는 사용자 승인). 완료 기준은 2026-11-10 사용자 승인으로 '전체 통과'에서 '새 실패 0개 + 보류 승인'으로 바꿨습니다

### Phase 5. 클라이언트 호환

**목표:** Claude Code·Codex의 요청/응답, 스트리밍, thinking, tool call을 지원합니다.  
**현재 상태:** 구현·리뷰 완료, **실제 클라이언트·실제 계정 4조합 확인 완료(2026-11-13, 사용자 실행)**. 범위와 완료 조건은 [ADR 0019](docs/adr/0019-phase5-client-compatibility-scope.md)에 고정했습니다(2026-11-10 사용자 승인). 실제 확인의 결과와 한계는 [확인 체크리스트](docs/phase5-real-verification.md) 5번 표에 있습니다. Claude API 키 조합은 비대화형(`claude -p`)으로만 확인했습니다.

- [x] 공통 dispatch 파이프라인 분리(기존 `/v1/chat/completions` 새 실패 0, run18)
- [x] `/v1/messages`: Anthropic API 키·구독 OAuth, 원문 전달(스트림·비스트림, 도구, thinking, `system`·`cache_control`, 베타 헤더). 합성 공급자 테스트만 함
- [x] `/v1/responses`: OpenAI API 키·Codex 구독 OAuth, 원문 전달(스트림·비스트림, function call, reasoning, `store:false`). 합성 공급자 테스트만 함
- [x] Phase 4 안전 속성 승계(인증·한도·ACL·OPEN·429/5xx 제한·Esc 전환·시간 제한·401 갱신·종료 drain·사용량)
- [x] 프로토콜별 엄격한 종료 판정, 공급자 오류·헤더 전달(사용자 결정 3B·4B. 헤더는 리뷰에 따라 허용 목록 방식)
- [x] README 클라이언트 설정 안내
- [x] 실제 클라이언트×실제 계정 4조합 확인(사용자 실행, 2026-11-13). 확인 중 고친 것: Claude 개인 API 키(`sk-ant-usr-`) 지원, Codex 구독 백엔드의 `Content-Type` 없는 스트림 수용 — 절차: [docs/phase5-real-verification.md](docs/phase5-real-verification.md), 도구: `scripts/phase5-verify.mjs`
- [x] 독립 리뷰·재리뷰 PASS(deleg_aec37528 → b02008e9 → 5fe04403), 격리 전체 테스트 246/267(새 실패 0, 보류 21)
- **완료 후 추가 개발:** 교차 공급자 변환(Claude Code→OpenAI 계정, Codex→Anthropic 계정)

#### 클라이언트 연결 방법 (Phase 5)

ShareAI 관리자 화면이나 Admin API로 만든 **ShareAI 사용자 키**를 클라이언트의 자격증명으로 씁니다. 공급자 계정(구독·API 키)은 서버에만 있고 클라이언트로 전달되지 않습니다.

**Claude Code** — Anthropic 계정(구독 OAuth 또는 API 키)으로 라우팅됩니다.

```bash
export ANTHROPIC_BASE_URL=http://<ShareAI 호스트>:20100   # /v1 은 붙이지 않음
export ANTHROPIC_AUTH_TOKEN=<ShareAI 사용자 키>            # Authorization: Bearer 로 전송
claude
```

- `ANTHROPIC_AUTH_TOKEN`이 있으면 PC에 저장된 claude.ai 로그인은 전송되지 않습니다(공식 문서). `ANTHROPIC_API_KEY`(→ `x-api-key`)로 넣어도 됩니다.
- 응답의 `anthropic-ratelimit-unified-*` 헤더는 이번 요청을 처리한 **공유 풀 계정**의 값입니다(ADR 0019 결정 4B).

**Codex CLI** — OpenAI 계정(Codex 구독 OAuth 또는 `sk-` 키)으로 라우팅됩니다. `~/.codex/config.toml`(사용자 수준; 프로젝트 `.codex/config.toml`의 공급자 설정은 무시됨):

```toml
model = "<사용할 모델>"
model_provider = "shareai"

[model_providers.shareai]
name = "ShareAI"
base_url = "http://<ShareAI 호스트>:20100/v1"
env_key = "SHAREAI_API_KEY"
wire_api = "responses"
supports_websockets = false
capabilities.remote_compaction = "unsupported"
```

```bash
export SHAREAI_API_KEY=<ShareAI 사용자 키>
codex
```

- `wire_api`는 공식 문서상 `responses`만 지원합니다. WebSocket 전송과 원격 압축은 ShareAI가 지원하지 않으므로 끕니다.
- 공급자 오류는 상태·본문 그대로 전달됩니다(결정 3B). 공급자가 없는 라우터 자체 오류(인증, 한도, 적격 계정 없음 등)는 각 프로토콜의 오류 형식으로 반환됩니다.

### Phase 6. 대시보드와 운영

**목표:** 계정·사용자·통계 UI, 모니터링, 배포 및 보안을 갖춥니다.  
**현재 상태:** 대시보드 기본 구현 / 운영 검증 미완료. 대시보드 빌드는 확인했지만 전체 UI 연동과 운영 환경 검증은 남아 있습니다.

- 계정·사용자 관리 및 통계 UI와 백엔드 연동
- 계정 상태·사용량 모니터링
- 서버 재시작, 배포 설정 및 보안 점검
- **완료 기준:** UI 연동, 사용량·상태 표시, 재시작·보안·운영 테스트 통과

라우팅 스냅샷 UI는 동일 출처의 `/api/admin/routing-snapshot`을 요청합니다. 백엔드는 이 정확한 경로를 기존 관리자 인증 경로의 별칭으로 처리하지만, 대시보드 정적 파일과 백엔드를 별도로 제공한다면 동일 출처 게이트웨이가 해당 경로를 백엔드로 전달해야 합니다. Vite 개발 프록시는 `/api`를 제거해 기존 경로로 전달합니다. 이는 배포 설정의 검증이나 운영 준비 완료를 의미하지 않습니다.

Phase 2 검증은 Phase 3과 병행하며, 이미 작성된 다른 단계의 기능도 유지합니다. 실제 Claude·ChatGPT 구독 계정 추론 성공, 다중 계정 자동 전환, 클라이언트 호환성은 아직 완료로 확인되지 않았습니다.

## 📜 라이선스

MIT License

---

**면책사항**: 이 프로젝트는 교육 및 개인 연구 목적입니다. 제3자 서비스 이용약관을 준수하는 것은 사용자의 책임입니다.
