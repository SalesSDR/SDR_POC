import dotenv from 'dotenv';
import { z } from 'zod';

// Load environmental variables from .env file
dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url("DATABASE_URL must be a valid PostgreSQL connection string URL"),
  REDIS_URL: z.string().url("REDIS_URL must be a valid Redis connection string URL"),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  LANGFUSE_PUBLIC_KEY: z.string().min(1, "LANGFUSE_PUBLIC_KEY is required"),
  LANGFUSE_SECRET_KEY: z.string().min(1, "LANGFUSE_SECRET_KEY is required"),
  LANGFUSE_HOST: z.string().url("LANGFUSE_HOST must be a valid URL").default("https://cloud.langfuse.com"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APOLLO_API_KEY: z.string().min(1, "APOLLO_API_KEY is required"),
  ALLOW_LIVE_APOLLO: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),
  APOLLO_SEARCH_LIMIT: z.coerce.number().default(5),
  ALLOW_LIVE_OUTREACH: z.preprocess((val) => val === 'true' || val === true, z.boolean()).default(false),
  APP_ENV: z.enum(["development", "production", "test"]).default("development"),
  UNIPILE_ACCESS_TOKEN: z.string().min(1, "UNIPILE_ACCESS_TOKEN is required"),
  UNIPILE_API_URL: z.string().url("UNIPILE_API_URL must be a valid URL"),
  UNIPILE_ACCOUNT_ID: z.string().min(1, "UNIPILE_ACCOUNT_ID is required"),
  UNIPILE_WEBHOOK_SECRET: z.string().min(1, "UNIPILE_WEBHOOK_SECRET is required"),
  SMARTLEAD_API_KEY: z.string().min(1, "SMARTLEAD_API_KEY is required"),
  SMARTLEAD_CAMPAIGN_ID: z.coerce.string().min(1, "SMARTLEAD_CAMPAIGN_ID is required"),
  SMARTLEAD_WEBHOOK_SECRET: z.string().min(1, "SMARTLEAD_WEBHOOK_SECRET is required"),
  SMARTLEAD_API_URL: z.string().url("SMARTLEAD_API_URL must be a valid URL").default("https://server.smartlead.ai/api/v1"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration errors details:");
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
export default config;
