#!/bin/bash
# 다계정 라우터 테스트 스크립트

BASE_URL="http://localhost:20100"
ADMIN_KEY="admin_dev_key_change_in_production"

echo "=== 1. 사용자 생성 ==="
USER_RESPONSE=$(curl -s -X POST "$BASE_URL/admin/users" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "테스트 사용자 1",
    "email": "user1@example.com",
    "tier": "pro",
    "dailyLimit": 1000
  }')
echo "$USER_RESPONSE" | jq .
USER_API_KEY=$(echo "$USER_RESPONSE" | jq -r .apiKey)
echo "사용자 API 키: $USER_API_KEY"
echo ""

echo "=== 2. Claude 계정 추가 (Mock) ==="
curl -s -X POST "$BASE_URL/admin/accounts" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Claude-Account-1",
    "provider": "anthropic",
    "credentialType": "cookie",
    "credentials": "__cf_bm=mock_cloudflare_token; sessionKey=mock_session_key",
    "dailyQuota": 50,
    "priority": 1,
    "weight": 2
  }' | jq .
echo ""

echo "=== 3. Claude 계정 추가 #2 ==="
curl -s -X POST "$BASE_URL/admin/accounts" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Claude-Account-2",
    "provider": "anthropic",
    "credentialType": "session_token",
    "credentials": "sk-ant-mock-session-token-12345",
    "dailyQuota": 100,
    "priority": 2,
    "weight": 1
  }' | jq .
echo ""

echo "=== 4. ChatGPT 계정 추가 ==="
curl -s -X POST "$BASE_URL/admin/accounts" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ChatGPT-Account-1",
    "provider": "openai",
    "credentialType": "cookie",
    "credentials": "_cfuvid=mock_cf; __Secure-next-auth.session-token=mock_session",
    "dailyQuota": 40,
    "priority": 1,
    "weight": 1
  }' | jq .
echo ""

echo "=== 5. 전체 통계 확인 ==="
curl -s "$BASE_URL/admin/stats" \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
echo ""

echo "=== 6. 계정 목록 확인 ==="
curl -s "$BASE_URL/admin/accounts" \
  -H "Authorization: Bearer $ADMIN_KEY" | jq '.accounts[] | {id, name, provider, status, usedToday, dailyQuota, priority, weight}'
echo ""

echo "=== 7. Claude 요청 테스트 (Non-streaming) ==="
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      {"role": "user", "content": "안녕하세요! 테스트 메시지입니다."}
    ],
    "router_options": {
      "strategy": "round_robin"
    }
  }' | jq .
echo ""

echo "=== 8. ChatGPT 요청 테스트 ==="
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "user", "content": "Hello GPT!"}
    ],
    "router_options": {
      "strategy": "least_used"
    }
  }' | jq .
echo ""

echo "=== 9. Streaming 요청 테스트 ==="
echo "Claude Streaming:"
curl -N -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "messages": [
      {"role": "user", "content": "스트리밍 테스트"}
    ],
    "stream": true
  }' 2>&1 | head -10
echo ""

echo "=== 10. 사용 통계 확인 ==="
curl -s "$BASE_URL/admin/stats" \
  -H "Authorization: Bearer $ADMIN_KEY" | jq .
echo ""

echo "✅ 테스트 완료!"
