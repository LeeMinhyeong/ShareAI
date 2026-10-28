import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * 계정 자격증명을 AES-256-GCM으로 암호화/복호화
 */
export class CredentialVault {
  private key: Buffer;

  constructor() {
    this.key = Buffer.from(env.ENCRYPTION_KEY, 'hex');
  }

  /**
   * 평문을 암호화
   * @returns "iv:authTag:ciphertext" 형식
   */
  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * 암호문을 복호화
   */
  decrypt(ciphertext: string): string {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format');
    }

    const [ivHex, authTagHex, encrypted] = parts;

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);

    let plaintext = decipher.update(encrypted, 'hex', 'utf8');
    plaintext += decipher.final('utf8');

    return plaintext;
  }
}

/**
 * API 키 생성
 */
export function generateApiKey(prefix: 'user' | 'admin'): string {
  const random = crypto.randomBytes(32).toString('base64url');
  return `${prefix}_${random}`;
}

/**
 * API 키 해시 (DB 저장용)
 */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}
