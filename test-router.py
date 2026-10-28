"""
다계정 라우터 테스트 스크립트
"""
import requests
import json
import time

BASE_URL = "http://localhost:20100"
ADMIN_KEY = "admin_dev_key_change_in_production"

def print_section(title):
    print(f"\n{'='*60}")
    print(f"  {title}")
    print('='*60)

def pretty_print(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))

# 1. 사용자 생성
print_section("1. 사용자 생성")
resp = requests.post(
    f"{BASE_URL}/admin/users",
    headers={
        "Authorization": f"Bearer {ADMIN_KEY}",
        "Content-Type": "application/json"
    },
    json={
        "name": "테스트 사용자 1",
        "email": "user1@example.com",
        "tier": "pro",
        "dailyLimit": 1000
    }
)
user_data = resp.json()
pretty_print(user_data)
USER_API_KEY = user_data.get('apiKey', '')
print(f"\n✅ 사용자 API 키: {USER_API_KEY[:20]}...")

# 2. 두 번째 사용자 생성
print_section("2. 두 번째 사용자 생성")
resp = requests.post(
    f"{BASE_URL}/admin/users",
    headers={
        "Authorization": f"Bearer {ADMIN_KEY}",
        "Content-Type": "application/json"
    },
    json={
        "name": "테스트 사용자 2",
        "email": "user2@example.com",
        "tier": "free",
        "dailyLimit": 100
    }
)
user2_data = resp.json()
USER2_API_KEY = user2_data.get('apiKey', '')
print(f"✅ 사용자 2 API 키: {USER2_API_KEY[:20]}...")

# 3. Claude 계정 추가
print_section("3. Claude 계정 3개 추가")
claude_accounts = [
    {
        "name": "Claude-A",
        "provider": "anthropic",
        "credentialType": "cookie",
        "credentials": "__cf_bm=mock_cf_token_A; sessionKey=mock_session_A",
        "dailyQuota": 50,
        "priority": 1,
        "weight": 2
    },
    {
        "name": "Claude-B",
        "provider": "anthropic",
        "credentialType": "session_token",
        "credentials": "sk-ant-mock-session-B",
        "dailyQuota": 100,
        "priority": 2,
        "weight": 1
    },
    {
        "name": "Claude-C",
        "provider": "anthropic",
        "credentialType": "cookie",
        "credentials": "__cf_bm=mock_cf_token_C; sessionKey=mock_session_C",
        "dailyQuota": 0,  # 무제한
        "priority": 3,
        "weight": 1
    }
]

for acc in claude_accounts:
    resp = requests.post(
        f"{BASE_URL}/admin/accounts",
        headers={"Authorization": f"Bearer {ADMIN_KEY}"},
        json=acc
    )
    result = resp.json()
    print(f"✅ {result['account']['name']} 추가됨 (priority={result['account']['priority']}, quota={result['account']['dailyQuota']})")

# 4. ChatGPT 계정 추가
print_section("4. ChatGPT 계정 2개 추가")
gpt_accounts = [
    {
        "name": "GPT-A",
        "provider": "openai",
        "credentialType": "cookie",
        "credentials": "_cfuvid=mock_A; __Secure-next-auth.session-token=mock_A",
        "dailyQuota": 40,
        "priority": 1,
        "weight": 2
    },
    {
        "name": "GPT-B",
        "provider": "openai",
        "credentialType": "session_token",
        "credentials": "eyJhbGc.mock_jwt_token",
        "dailyQuota": 80,
        "priority": 2,
        "weight": 1
    }
]

for acc in gpt_accounts:
    resp = requests.post(
        f"{BASE_URL}/admin/accounts",
        headers={"Authorization": f"Bearer {ADMIN_KEY}"},
        json=acc
    )
    result = resp.json()
    print(f"✅ {result['account']['name']} 추가됨 (priority={result['account']['priority']}, quota={result['account']['dailyQuota']})")

# 5. 전체 통계 확인
print_section("5. 전체 통계 확인")
resp = requests.get(
    f"{BASE_URL}/admin/stats",
    headers={"Authorization": f"Bearer {ADMIN_KEY}"}
)
pretty_print(resp.json())

# 6. 계정 목록 확인
print_section("6. 계정 목록 확인")
resp = requests.get(
    f"{BASE_URL}/admin/accounts",
    headers={"Authorization": f"Bearer {ADMIN_KEY}"}
)
accounts = resp.json()['accounts']
print(f"\n{'Name':<20} {'Provider':<12} {'Status':<15} {'Used/Quota':<12} {'Priority':<8} {'Weight'}")
print("-" * 90)
for acc in accounts:
    quota_str = f"{acc['usedToday']}/{acc['dailyQuota']}" if acc['dailyQuota'] > 0 else f"{acc['usedToday']}/∞"
    print(f"{acc['name']:<20} {acc['provider']:<12} {acc['status']:<15} {quota_str:<12} {acc['priority']:<8} {acc['weight']}")

# 7. Claude 요청 테스트 (라운드로빈)
print_section("7. Claude 요청 5회 (round_robin 전략)")
for i in range(5):
    resp = requests.post(
        f"{BASE_URL}/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {USER_API_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "model": "claude-3-5-sonnet-20241022",
            "messages": [{"role": "user", "content": f"테스트 메시지 {i+1}"}],
            "router_options": {"strategy": "round_robin"}
        }
    )
    result = resp.json()
    print(f"  요청 {i+1}: {result.get('choices', [{}])[0].get('message', {}).get('content', '')[:50]}...")
    time.sleep(0.2)

# 8. ChatGPT 요청 테스트 (우선순위)
print_section("8. ChatGPT 요청 3회 (priority 전략)")
for i in range(3):
    resp = requests.post(
        f"{BASE_URL}/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {USER_API_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": f"Hello GPT #{i+1}"}],
            "router_options": {"strategy": "priority"}
        }
    )
    result = resp.json()
    print(f"  요청 {i+1}: {result.get('choices', [{}])[0].get('message', {}).get('content', '')[:50]}...")
    time.sleep(0.2)

# 9. 최소 사용 전략 테스트
print_section("9. Claude 요청 3회 (least_used 전략)")
for i in range(3):
    resp = requests.post(
        f"{BASE_URL}/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {USER2_API_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "model": "claude-3-5-haiku-20241022",
            "messages": [{"role": "user", "content": f"Least used test {i+1}"}],
            "router_options": {"strategy": "least_used"}
        }
    )
    result = resp.json()
    print(f"  요청 {i+1}: {result.get('choices', [{}])[0].get('message', {}).get('content', '')[:50]}...")
    time.sleep(0.2)

# 10. 스트리밍 테스트
print_section("10. 스트리밍 요청 테스트")
resp = requests.post(
    f"{BASE_URL}/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {USER_API_KEY}",
        "Content-Type": "application/json"
    },
    json={
        "model": "claude-3-5-sonnet-20241022",
        "messages": [{"role": "user", "content": "스트리밍 테스트"}],
        "stream": True
    },
    stream=True
)
print("스트리밍 응답:")
for line in resp.iter_lines():
    if line:
        line_str = line.decode('utf-8')
        if line_str.startswith('data: '):
            print(f"  {line_str}")
            if '[DONE]' in line_str:
                break

# 11. 계정별 사용 통계
print_section("11. 계정별 사용 통계")
resp = requests.get(
    f"{BASE_URL}/admin/accounts",
    headers={"Authorization": f"Bearer {ADMIN_KEY}"}
)
accounts = resp.json()['accounts']
print(f"\n{'Name':<20} {'Provider':<12} {'Status':<15} {'Used Today':<12} {'Last Used'}")
print("-" * 90)
for acc in accounts:
    last_used = acc['lastUsed'][:19] if acc['lastUsed'] else 'Never'
    print(f"{acc['name']:<20} {acc['provider']:<12} {acc['status']:<15} {acc['usedToday']:<12} {last_used}")

# 12. 최종 통계
print_section("12. 최종 통계")
resp = requests.get(
    f"{BASE_URL}/admin/stats",
    headers={"Authorization": f"Bearer {ADMIN_KEY}"}
)
pretty_print(resp.json())

print_section("✅ 모든 테스트 완료!")
print(f"""
요약:
- 사용자 2명 생성 (user1: pro/1000, user2: free/100)
- Claude 계정 3개 추가 (A, B, C)
- ChatGPT 계정 2개 추가 (A, B)
- 총 11회 요청 전송 (round_robin 5회, priority 3회, least_used 3회)
- 스트리밍 응답 테스트 완료

다음 단계:
1. 실제 Claude/ChatGPT API 연동 (src/adapters/ 구현)
2. 웹 대시보드 개발 (React + Chart.js)
3. 자동 할당량 리셋 cron 작업
4. 에러 재시도 및 폴백 로직 강화
""")
