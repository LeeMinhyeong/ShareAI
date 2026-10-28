# 다계정 AI 라우터

여러 사용자가 여러 AI 계정(Claude, GPT, Gemini)을 공유하여 사용할 수 있는 라우팅 서버입니다.

**OmniRoute**와 **opencodex** 분석을 기반으로 설계되었습니다.

## 🎯 핵심 기능

- ✅ **다계정 풀 관리**: A, B, C 계정을 여러 사용자가 공유
- ✅ **자동 로드밸런싱**: 라운드로빈, 우선순위, 최소 사용 전략
- ✅ **할당량 추적**: 계정별 일일 한도 자동 감지
- ✅ **사용자 격리**: 사용자별 API 키 및 사용량 추적
- ✅ **프로토콜 번역**: OpenAI Chat ↔ Anthropic Messages ↔ Responses
- ✅ **자동 폴백**: 429 에러 시 다른 계정으로 자동 재시도

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

```bash
# SQLite (개발용)
npm run db:migrate

# PostgreSQL (프로덕션)
# DATABASE_URL을 postgresql://...로 설정 후
npm run db:migrate
```

### 4. 서버 실행

```bash
# 개발 모드 (핫 리로드)
npm run dev

# 프로덕션 빌드
npm run build
npm start
```

서버가 `http://localhost:20128`에서 실행됩니다.

## 📚 사용법

### 계정 추가 (관리자)

```bash
curl -X POST http://localhost:20128/admin/accounts \
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

### 사용자 추가

```bash
curl -X POST http://localhost:20128/admin/users \
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
curl -X POST http://localhost:20128/v1/chat/completions \
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
- **[비교 분석 보고서](./OmniRoute-vs-opencodex-보고서.html)**: OmniRoute vs opencodex 코드 분석
- [OmniRoute GitHub](https://github.com/cheaper-inference/OmniRoute)
- [opencodex GitHub](https://github.com/lidge-jun/opencodex)

## 🛠️ 개발 로드맵

- [x] Phase 1: 설계 및 프로젝트 구조
- [ ] Phase 2: 데이터베이스 레이어 구현
- [ ] Phase 3: 계정 풀 관리 로직
- [ ] Phase 4: 프로토콜 번역 엔진
- [ ] Phase 5: 관리 대시보드
- [ ] Phase 6: 운영 및 모니터링

## 📜 라이선스

MIT License

---

**면책사항**: 이 프로젝트는 교육 및 개인 연구 목적입니다. 제3자 서비스 이용약관을 준수하는 것은 사용자의 책임입니다.
