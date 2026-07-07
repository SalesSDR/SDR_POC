import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import config from './env';

// Initialize a resilient database connection pool
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20, // Optimal max pool size for local dev and microservices
  idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
  connectionTimeoutMillis: 5000, // Return an error if connection takes > 5 seconds
});

// Capture unexpected errors on idle pool connections
pool.on('error', (err) => {
  console.error('[database]: Unexpected error on idle database client', err);
});

export const db = {
  /**
   * Execute a query against the connection pool. Use for single-shot queries.
   * Standardizes parameterized input values to safeguard against SQL injection.
   */
  async query<T extends QueryResultRow = any>(
    text: string,
    params?: any[]
  ): Promise<QueryResult<T>> {
    const start = Date.now();
    try {
      const res = await pool.query<T>(text, params);
      const duration = Date.now() - start;
      
      if (config.NODE_ENV === 'development') {
        console.log(`[database]: Executed query in ${duration}ms`, { 
          text: text.replace(/\s+/g, ' ').trim(), 
          rowCount: res.rowCount 
        });
      }
      
      return res;
    } catch (err: any) {
      console.error('[database]: Query execution failed', { 
        text: text.replace(/\s+/g, ' ').trim(), 
        error: err.message 
      });
      throw err;
    }
  },

  /**
   * Get an active client connection from the pool.
   * Essential for wrapping multi-query transactions.
   */
  async getClient(): Promise<PoolClient> {
    const client = await pool.connect();
    return client;
  },

  /**
   * Closes the connection pool. Invoked during process termination.
   */
  async close(): Promise<void> {
    console.log('[database]: Initiating connection pool shutdown...');
    await pool.end();
    console.log('[database]: Database connection pool closed successfully.');
  }
};

export default db;
