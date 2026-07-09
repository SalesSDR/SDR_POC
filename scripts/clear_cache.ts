import db from '../src/config/database';
import IORedis from 'ioredis';
import config from '../src/config/env';

async function clearCache() {
  console.log('🧹 STARTING FRESH: CLEARING ALL CACHES & LEDGERS 🧹');
  console.log('===================================================');

  try {
    // 1. Clear Redis Cache (BullMQ queues and keys)
    console.log('[redis] Connecting and flushing all Redis keys...');
    const redis = new IORedis(config.REDIS_URL);
    await redis.flushall();
    await redis.quit();
    console.log('✅ Redis cache successfully cleared.');

    // 2. Truncate PostgreSQL ledgers
    console.log('[postgres] Truncating prospects and interaction_logs tables...');
    await db.query('TRUNCATE prospects, interaction_logs CASCADE');
    console.log('✅ PostgreSQL tables successfully truncated.');

    console.log('\n✨ Fresh start ready! All cached leads, jobs, and interaction logs have been cleared.');
  } catch (err: any) {
    console.error('❌ Error during cache clearing:', err.message || err);
  } finally {
    await db.close();
    process.exit(0);
  }
}

clearCache();
