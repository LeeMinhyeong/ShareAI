/**
 * 프로토콜 중간 표현 (IR) - opencodex 기반
 */

/**
 * 파싱된 요청 (형식 무관)
 */
export interface ParsedRequest {
  systemPrompt: string[];
  messages: Message[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: Tool[];
  
  // 제공자별 임시 상태 (어댑터가 사용)
  providerState?: Record<string, unknown>;
}

/**
 * 메시지 (역할 4가지로 정규화)
 */
export interface Message {
  role: 'user' | 'assistant' | 'developer' | 'toolResult';
  parts: MessagePart[];
}

/**
 * 메시지 파트 (텍스트, thinking, tool call)
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { 
      type: 'thinking';
      text: string;
      signature?: string;  // Anthropic thinking 서명
      redacted?: string[];  // 검열된 부분 마커
    }
  | {
      type: 'toolCall';
      id: string;
      name: string;
      args: unknown;
      thoughtSignature?: string;  // Gemini용
    };

/**
 * Tool 정의
 */
export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * 스트림 이벤트 (통합 타입)
 */
export type StreamEvent =
  | { type: 'heartbeat' }
  | { type: 'text_delta'; text: string; phase?: 'commentary' | 'final_answer' }
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_signature'; signature: string }
  | { type: 'redacted_thinking'; markers: string[] }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argsDelta: string }
  | { type: 'tool_call_end'; id: string; args: unknown }
  | { type: 'done'; finishReason: string; usage: TokenUsage }
  | { type: 'incomplete'; reason: string }
  | { type: 'error'; error: { type: string; message: string } };

/**
 * 토큰 사용량
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

/**
 * 디코더 인터페이스 (요청 형식 → IR)
 */
export interface Decoder {
  decode(request: unknown): ParsedRequest;
}

/**
 * 어댑터 인터페이스 (IR → 제공자 형식)
 */
export interface Adapter {
  buildRequest(parsed: ParsedRequest): ProviderRequest;
  parseStream(response: ReadableStream): AsyncIterable<StreamEvent>;
}

/**
 * 제공자 요청
 */
export interface ProviderRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 인코더 인터페이스 (이벤트 스트림 → 클라이언트 형식)
 */
export interface Encoder {
  encode(events: AsyncIterable<StreamEvent>): AsyncIterable<string>;
}
