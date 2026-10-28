import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(20100),
  HOST: z.string().default('127.0.0.1'),
  
  DATABASE_URL: z.string().refine(value => {
    if (!value.startsWith('sqlite:')) return false;
    const name = value.slice('sqlite:'.length);
    return name.trim().length > 0 && name === name.trim() && !name.startsWith('//') && !name.includes('\0');
  }, 'DATABASE_URL must be sqlite: followed by a file path or :memory:'),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes (64 hex chars)'),
  
  ADMIN_API_KEY: z.string().min(20).refine(value => value !== 'admin_your_secure_key_here', 'Replace the example administrator key'),
  
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_FREE: z.coerce.number().default(20),
  RATE_LIMIT_MAX_PRO: z.coerce.number().default(100),
  
  CORS_ORIGIN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
