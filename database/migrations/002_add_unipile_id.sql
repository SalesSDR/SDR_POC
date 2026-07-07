-- Migration: Add unipile_invitation_id column and create index for fast webhook resolution
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS unipile_invitation_id VARCHAR(255) UNIQUE;

-- Create an index to optimize sub-millisecond status update queries on webhook triggers
CREATE INDEX IF NOT EXISTS idx_prospects_unipile_invit_id ON prospects(unipile_invitation_id);
