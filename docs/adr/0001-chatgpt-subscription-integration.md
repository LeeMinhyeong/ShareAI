# ADR 0001: ChatGPT 구독 계정 연동 및 계정 풀 방향

- **상태:** 채택 — 구현 및 실제 계정 검증 진행 전/진행 중
- **작성일:** 2026-10-29
- **범위:** Phase 3 ChatGPT 구독 계정 연결, Phase 4 계정 풀 및 라우팅과의 경계

## 배경

ShareAI의 목표는 2~5명이 여러 Claude 및 ChatGPT 구독 계정을 라우터를 통해 편리하게 사용하도록 하고, 계정 관리와 라우팅 전략을 제공하는 것이다. 구독 계정은 API 키 기반 과금과 구분한다.

OpenAI의 Sign in with ChatGPT(SIWC) 문서는 오픈소스·로컬 앱이 사용자의 동의를 얻어 해당 사용자의 ChatGPT 플랜을 적격 Responses API 요청에 사용하는 경로를 명시한다. 다만 그 문서는 여러 개인 계정의 플랜을 여러 사람의 요청에 자동 배분하는 공유 풀 전체가 허용된다고 명시하지 않는다. 개인용 이용약관은 계정 자격증명 공유와 계정을 타인에게 이용 가능하게 하는 행위 및 제한 우회에 관한 제약을 둔다. 실제 적용 약관과 운영 모델은 별도 확인이 필요하다. [1][2]

OmniRoute와 opencodex의 로컬 소스에서 확인한 ChatGPT 구독 경로는 Codex OAuth 및 ChatGPT 백엔드 기반이다. `dynamic_agent_client`, `ext_agent_host_id`, `chatgpt.tokens.use.direct`를 검색한 범위에서는 이 SIWC 동적 등록 표식을 찾지 못했다. 검색 결과가 다른 구현의 부재를 증명하는 것은 아니다.

## 결정

1. **공식 SIWC를 ChatGPT 구독 계정의 우선 연결 방식으로 채택한다.** 계정 소유자가 직접 로그인하고 플랜 사용에 동의한다. OAuth에 성공했다고 해서 플랜 사용 권한이 자동 부여된 것으로 간주하지 않는다.
2. **ShareAI의 다계정 풀과 선택 가능한 라우팅 전략이라는 제품 목표는 유지한다.** SIWC 등록 계정도 풀에 통합하는 것을 목표로 한다. 다만 여러 사람의 요청을 개인 계정 풀에 배분하는 운영 방식은 공식 문서에서 허용 여부를 확인하지 못했으므로, 자동으로 공식 지원 또는 약관 준수라고 주장하지 않는다. 실제 사용 전 해당 제품·배포 방식에 적용되는 조건을 확인한다.
3. **기존 Codex OAuth/가져오기 방식은 별도 호환 경로로 유지하고 검증한다.** SIWC와 Codex는 별도 인증·자격증명·추론 어댑터로 취급한다. 토큰, 클라이언트 ID, 스코프, 엔드포인트와 헤더를 서로 혼용하지 않는다. 호환 경로의 실제 지원 여부나 정책 적합성을 보장하지 않는다.
4. **OmniRoute와 opencodex의 유사 기능을 우선 검토해 재사용 또는 이식한다.** 계정 관리, OAuth 콜백, 토큰 회전 직렬화, 스트리밍 변환 및 오류 처리 등이 후보이다. 각 프로젝트의 라이선스와 출처 표시를 확인하고, Codex 전용 동작을 SIWC에 그대로 적용하지 않는다.
5. **자동 전환은 실패 원인을 구분한다.** 일시적 네트워크 장애 등과 공급자 사용 한도·정책 제한을 구별한다. 제공자의 한도나 정책 제한을 회피하기 위한 무조건적인 계정 전환은 조건 확인 전 구현하지 않는다. 전환 동작은 Phase 4에서 별도 설계·테스트한다.

## SIWC 구현 요구사항

- 최초 등록은 `client_id=dynamic_agent_client`와 호스트별로 안정적으로 보존되는 불투명한 `ext_agent_host_id`를 사용한다. 발급받은 client ID는 사용자·workspace 등록과 함께 보관하고 이후 재인증과 토큰 갱신에 사용한다. 각 로그인 시도는 새 state, nonce 및 PKCE를 사용한다. [3]
- 계정별 등록 정보와 토큰을 분리·보호한다. ID 토큰의 서명, issuer, audience, 만료와 nonce를 검증하고, 반환된 `chatgpt.tokens.use.direct` 권한이 없는 경우 플랜 추론을 실행하지 않는다. refresh token 회전 시 동일 세션의 동시 갱신을 직렬화한다. [3][4]
- SIWC 추론은 `https://api.openai.com/v1/responses`를 사용한다. HTTP 요청은 `store: false`, `stream: true`로 보내고 `response.completed`를 받아야 성공으로 판단한다. 미지원 필드·도구와 오류를 문서에 맞춰 검증하며 Codex 백엔드 경로를 사용하지 않는다. [5][6]
- 계정 소유자와 관리자가 연결 상태·플랜 사용 여부·오류를 확인할 수 있게 하고, 사용량 관리 및 동의 철회 경로를 제공한다. 인증 정보는 로그와 소스 관리에 남기지 않는다. [4][7]
- 개인용 로컬 환경을 우선하되, 유료 또는 원격 호스팅 형태에 대해서는 OpenAI가 안내하는 별도 절차와 적용 조건을 확인한다. 원격 VM으로 인증 정보를 안전하게 이전하는 공식 절차가 존재한다는 사실을, 모든 원격 서비스 또는 다인 공유의 승인으로 해석하지 않는다. [1][8]

## 검토한 대안

| 대안 | 판단 |
|---|---|
| 기존 Codex OAuth만 사용 | 호환성은 유지하지만, 공식 SIWC의 앱별 동의·플랜 사용 경로를 우선하지 못하므로 단독 기본 방식으로 채택하지 않는다. |
| SIWC만 사용하고 Codex 경로 제거 | 기존 계정 가져오기와 호환 요구를 충족하지 못할 수 있어 채택하지 않는다. |
| API 키만 사용 | 구독 계정 중심이라는 제품 목표와 다르므로 대체안으로 채택하지 않는다. |
| 웹 세션·쿠키만 사용 | 공식 SIWC에 비해 세션 보안·변경 대응 및 지원 여부가 불확실하므로 우선 경로로 채택하지 않는다. |

## 결과 및 남은 검증

- 공식 SIWC를 기본으로 하면서도 Codex 호환 경로를 분리해 유지하므로 구현과 테스트 범위가 늘어난다.
- 각 계정의 동의·등록·갱신과 해지 상태를 구분해야 하며, 사용자별 계정 접근 및 감사 정책이 필요하다.
- 공식 프리뷰의 모델·입력·도구·요청 필드 제한은 CLI 호환성에 영향을 줄 수 있다. 실제 서비스의 응답과 사용 가능한 모델은 계정별로 검증한다.
- **실제 OpenAI 계정 로그인·추론 성공, 계정 풀 자동 선택, 다인 공유의 정책 적합성은 이 ADR 작성 시점에 검증 완료로 간주하지 않는다.**
- Phase 3 완료는 개발 → 별도 에이전트 코드 리뷰 → 지적 처리 → 격리 테스트 → Claude와 ChatGPT 각각 실제 구독 계정 로그인 및 요청 성공을 확인한 후에만 처리한다. Phase 4 전환은 별도 완료 기준을 따른다.

## 참고 자료

1. [OpenAI: ChatGPT plan usage 개요](https://developers.openai.com/siwc/token-sharing-open-source)
2. [OpenAI: 개인용 이용약관](https://openai.com/policies/terms-of-use/)
3. [OpenAI: 등록 및 로그인](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
4. [OpenAI: 계정 및 세션](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
5. [OpenAI: 모델 및 추론](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
6. [OpenAI: 프리뷰 제한사항](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
7. [OpenAI: UI/UX 가이드](https://developers.openai.com/siwc/ui-ux-guidelines)
8. [OpenAI: Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
