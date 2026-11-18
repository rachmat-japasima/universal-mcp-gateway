import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  console.error('Invalid environment configuration:', result.error.flatten());
  process.exit(1);
}

export const config = {
  host: result.data.HOST,
  port: result.data.PORT,
  logLevel: result.data.LOG_LEVEL,
} as const;
