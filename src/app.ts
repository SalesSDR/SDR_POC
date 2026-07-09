import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config/env';
import webhookRoutes from './routes/webhookRoutes';
import './services/queue/workers'; // Starts the BullMQ worker listener

const app = express();

// Standard middleware for secure headers, CORS, and request body parsing
app.use(helmet());
app.use(cors());
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = buf;
  }
}));

// Webhook endpoints
app.use('/webhooks', webhookRoutes);

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    environment: config.NODE_ENV,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

import db from './config/database';
import { outreachWorker } from './services/queue/workers';

const server = app.listen(config.PORT, () => {
  console.log(`[server]: Server is running securely at http://localhost:${config.PORT}`);
});

// Graceful shutdown handling
const gracefulShutdown = (signal: string) => {
  console.log(`[server]: Received ${signal}. Starting graceful shutdown...`);

  // Close server first, stops taking new requests
  server.close(async () => {
    console.log('[server]: Express server closed.');
    
    try {
      // Shutdown BullMQ worker listener
      console.log('[server]: Stopping BullMQ outreach workers...');
      await outreachWorker.close();
      
      // Close database connection pool
      await db.close();
    } catch (err: any) {
      console.error('[server]: Error during resources teardown:', err.message);
    }
    
    console.log('[server]: Graceful shutdown completed. Exiting process.');
    process.exit(0);
  });

  // Force exit if shutdown takes too long (e.g. 10s timeout)
  setTimeout(() => {
    console.error('[server]: Forced shutdown due to timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
