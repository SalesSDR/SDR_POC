import fs from 'fs';
import path from 'path';
import db from '../config/database';

async function runMigrations() {
  console.log('[database]: Starting database migrations...');

  try {
    // 1. Create schema_migrations table if not exists to track history
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        migration_name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Read migration files from database/migrations folder
    const migrationsDir = path.resolve(process.cwd(), 'database/migrations');
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migrations directory not found at: ${migrationsDir}`);
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Sort files to run them in correct numerical order

    console.log(`[database]: Found ${files.length} migration file(s) in directory.`);

    // 3. Apply pending migrations sequentially inside transactions
    for (const file of files) {
      const checkResult = await db.query(
        'SELECT 1 FROM schema_migrations WHERE migration_name = $1',
        [file]
      );

      if (checkResult.rowCount && checkResult.rowCount > 0) {
        console.log(`[database]: Migration ${file} is already applied. Skipping.`);
        continue;
      }

      console.log(`[database] Running migration ${file}...`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      // Acquire a dedicated connection client for transactional isolation
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
        console.log(`[database] Migration ${file} completed successfully.`);
      } catch (err: any) {
        await client.query('ROLLBACK');
        console.error(`[database] Migration ${file} failed. Rolled back transaction. Error: ${err.message}`);
        throw err;
      } finally {
        client.release(); // Return client back to pool
      }
    }

    console.log('[database] Schema migrations table synchronized.');
  } catch (err: any) {
    console.error('[database]: Migrations failed:', err.message);
    process.exit(1);
  } finally {
    // Shutdown database pool
    await db.close();
  }
}

// Execute migration execution immediately if executed directly via terminal commands
if (require.main === module) {
  runMigrations();
}

export { runMigrations };
export default runMigrations;
