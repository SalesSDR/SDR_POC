-- Migration: Add smartlead_id column and create index for fast reply webhook resolution
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS smartlead_id VARCHAR(255) UNIQUE;

-- Create index on smartlead_id to optimize response time for webhook lookups
CREATE INDEX IF NOT EXISTS idx_prospects_smartlead_id ON prospects(smartlead_id);
