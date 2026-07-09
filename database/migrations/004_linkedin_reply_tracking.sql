-- Migration: Add columns to track LinkedIn connection times and reply status for multi-channel sequencing
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS linkedin_connected_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS linkedin_replied BOOLEAN DEFAULT FALSE;
