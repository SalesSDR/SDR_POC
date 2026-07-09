import { Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import config from '../../config/env';
import db from '../../config/database';

import { enrollInCampaign } from '../email/smartlead';

// Initialize a dedicated Redis connection for the worker thread
const workerRedisConnection = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  showFriendlyErrorStack: config.NODE_ENV === 'development',
});

workerRedisConnection.on('error', (err) => {
  console.error('[worker-redis]: Unexpected connection error:', err);
});

/**
 * BullMQ Worker instance consuming 'outreach-tasks' job distributions.
 * The processing is designed to be completely stateless to survive restarts/retries.
 */
export const outreachWorker = new Worker(
  'outreach-tasks',
  async (job: Job<{ prospectId: string }>) => {
    const { prospectId } = job.data;

    // Handle delayed multi-channel follow-up evaluation
    if (job.name === 'evaluate_linkedin_to_email_sequence') {
      console.log(`[queue]: Evaluating multi-channel sequence logic for job ${job.id} (prospect: ${prospectId})`);
      
      // Perform live parameterized SQL lookup to prevent race conditions
      const result = await db.query(
        'SELECT id, linkedin_replied, status FROM prospects WHERE id = $1',
        [prospectId]
      );

      if (result.rowCount === 0) {
        console.warn(`[queue]: Prospect ${prospectId} not found in database. Exiting evaluation task.`);
        return { status: 'skipped', reason: 'prospect_not_found' };
      }

      const prospect = result.rows[0];

      // Guardrail 1: Suppression on message reply
      if (prospect.linkedin_replied) {
        console.log(`[sequence-suppression]: Prospect has already responded via LinkedIn. Suppressing email outreach.`);
        return { status: 'suppressed', reason: 'linkedin_replied_true' };
      }

      // Guardrail 2: Suppression on duplicate state outreach
      if (prospect.status === 'EMAIL_SENT' || prospect.status === 'REPLIED_INTERESTED') {
        console.log(`[queue]: Prospect status is already '${prospect.status}'. Suppressing duplicate outreach.`);
        return { status: 'skipped', reason: 'duplicate_outreach_suppressed' };
      }

      // Escalation Path: Enroll in cold email campaign
      console.log(`[queue]: No LinkedIn reply detected for prospect ${prospectId} after delay. Escalating to email...`);
      const smartleadId = await enrollInCampaign(prospectId);
      return { status: 'escalated', smartleadId };
    }

    if (config.ALLOW_LIVE_OUTREACH) {
      console.log(`[queue]: Processing live worker job channel sequences...`);
    } else {
      console.log(`[queue]: BullMQ worker processing task for prospect ID: ${prospectId}`);
    }

    // 1. Fetch pre-resolved Unipile details and staged text from prospect record
    const result = await db.query(
      'SELECT id, metadata, status FROM prospects WHERE id = $1',
      [prospectId]
    );

    if (result.rowCount === 0) {
      throw new Error(`Worker execution failed: Prospect ${prospectId} not found in database.`);
    }

    const prospect = result.rows[0];
    const metadata = prospect.metadata || {};
    const providerId = metadata.unipile_provider_id;
    const message = metadata.staged_invite;

    if (!providerId || !message) {
      throw new Error(`Worker execution failed: Prospect ${prospectId} is missing pre-resolved provider_id or staged message.`);
    }

    let invitationId = `mock_invite_${Date.now()}`;

    // 2. Execute outbound connection request call to Unipile
    if (config.ALLOW_LIVE_OUTREACH) {
      console.log(`[unipile-client]: Dispatched POST transaction request to api.unipile.com`);
      const isMockProvider = String(providerId).startsWith('mock_provider_');
      if (isMockProvider) {
        invitationId = `mock_invite_${Date.now()}`;
      } else {
        try {
          const url = `${config.UNIPILE_API_URL}/api/v1/users/invite`;
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-KEY': config.UNIPILE_ACCESS_TOKEN,
              'Authorization': `Bearer ${config.UNIPILE_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
              provider_id: providerId,
              account_id: config.UNIPILE_ACCOUNT_ID,
              message: message
            })
          });

          if (response.status === 429) {
            console.warn(`[unipile]: Rate limit (HTTP 429) encountered for job ${job.id}. Backing off...`);
            throw new Error('HTTP_429_RATE_LIMIT');
          }

          if (!response.ok) {
            const errText = await response.text();
            
            // Self-heal: If the recipient is already invited, mark it and bypass retries
            if (response.status === 422 && errText.includes('already_invited_recently')) {
              console.warn(`[unipile]: Prospect ${prospectId} has already been invited recently. Self-healing state to LI_INVITED.`);
              invitationId = 'already_invited_state_sync';
            } else {
              throw new Error(`Unipile connection request failed with status ${response.status}: ${errText}`);
            }
          }

          const body = (await response.json()) as any;
          invitationId = body.invitation_id || body.id;
          if (!invitationId) {
            throw new Error('Unipile response did not return a valid invitation_id or id parameter');
          }
        } catch (err: any) {
          if (err.message === 'HTTP_429_RATE_LIMIT') {
            throw err; // Trigger exponential backoff retry in BullMQ
          }
          console.error(`❌ [unipile]: Live Unipile connection request failed for prospect ${prospectId}:`, err.message);
          throw err;
        }
      }
    } else {
      console.log(`[unipile]: Mocking outreach delivery. Invite request sent successfully. Generated mock ID: ${invitationId}`);
    }

    // 3. Save invitation ID and transition prospect status to LI_INVITED
    await db.query(
      `UPDATE prospects 
       SET unipile_invitation_id = $1, 
           status = 'LI_INVITED', 
           updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2`,
      [invitationId, prospectId]
    );

    console.log(`[unipile]: Connection request sent successfully. Upgrading status to 'LI_INVITED' for prospect ${prospectId}.`);
    return { invitationId, prospectId };
  },
  {
    connection: workerRedisConnection as any,
    concurrency: 1, // Restrict concurrency to throttle outreach velocity
  }
);

outreachWorker.on('failed', (job, err) => {
  console.error(`❌ [queue]: Job ${job?.id} failed with error:`, err.message);
});

outreachWorker.on('completed', (job, result) => {
  if (config.NODE_ENV === 'development') {
    console.log(`[queue]: Job ${job.id} completed successfully. Result:`, result);
  }
});

console.log('[queue]: BullMQ outreach worker linked successfully to Redis container layer.');

export default outreachWorker;
