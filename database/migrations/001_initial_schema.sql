-- Create ENUM types for prospect status and outreach channel channel_type
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_status') THEN
        CREATE TYPE lead_status AS ENUM (
            'NEW', 
            'LI_INVITED', 
            'LI_CONNECTED', 
            'EMAIL_SENT', 
            'REPLIED_INTERESTED', 
            'REPLIED_NOT_INTERESTED', 
            'CALL_ESCALATED', 
            'DNC'
        );
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'channel_type') THEN
        CREATE TYPE channel_type AS ENUM (
            'LINKEDIN', 
            'EMAIL', 
            'VOICE'
        );
    END IF;
END $$;

-- Create prospects table to store lead details and lifecycle state
CREATE TABLE IF NOT EXISTS prospects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    apollo_id VARCHAR(255) UNIQUE NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255) UNIQUE,
    linkedin_url VARCHAR(500) UNIQUE,
    designation VARCHAR(150),
    geography VARCHAR(100),
    company_name VARCHAR(150),
    status lead_status DEFAULT 'NEW',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create a GIN (Generalized Inverted Index) on the metadata column using the jsonb_path_ops operator class.
-- jsonb_path_ops is optimized for hyper-fast containment (e.g. metadata @> '{"crm_id": "123"}') queries
-- while maintaining a significantly smaller index size on disk compared to the default jsonb_ops.
CREATE INDEX IF NOT EXISTS idx_prospects_metadata_path ON prospects USING gin (metadata jsonb_path_ops);

-- Create interaction_logs table to track full interaction history for each prospect
CREATE TABLE IF NOT EXISTS interaction_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
    channel channel_type NOT NULL,
    direction VARCHAR(10) NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    message_content TEXT,
    gemini_intent_tag VARCHAR(50),
    langfuse_trace_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
