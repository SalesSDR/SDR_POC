import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import config from '../../config/env';

// Initialize dedicated Redis connection for BullMQ
// BullMQ requires maxRetriesPerRequest to be null on the IORedis connection client
const redisConnection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  showFriendlyErrorStack: config.NODE_ENV === 'development',
});

redisConnection.on('error', (err) => {
  console.error('[redis]: Unexpected connection error', err);
});

redisConnection.on('connect', () => {
  if (config.NODE_ENV === 'development') {
    console.log('[redis]: Redis connection established successfully.');
  }
});

// Initialize the core BullMQ Queue
export const outreachQueue = new Queue('outreach-tasks', {
  connection: redisConnection as any,
  defaultJobOptions: {
    attempts: 3, // Retry failed jobs up to 3 times
    backoff: {
      type: 'exponential',
      delay: 5000, // Wait 5s, then 10s, then 20s...
    },
    removeOnComplete: true, // Auto-remove successful jobs to save memory
    removeOnFail: {
      age: 24 * 3600, // Keep failed jobs for up to 24 hours for debugging
    },
  },
});

console.log('[queue]: BullMQ outreach-tasks queue instance initialized.');

export default outreachQueue;
