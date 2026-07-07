import crypto from 'crypto';
import { Request, Response } from 'express';
import config from '../../config/env';
import db from '../../config/database';
import { outreachQueue } from '../queue/outreachQueue';
import { traceAIWorkflow } from '../ai/observability';
import { generateReasoning } from '../ai/gemini';

/**
 * Extracts the LinkedIn public vanity identifier from a profile URL.
 * Example: "https://www.linkedin.com/in/james-smith-cso" -> "james-smith-cso"
 */
export function extractLinkedInVanityId(url: string): string {
  try {
    const cleaned = url.replace(/\/$/, '').trim();
    const parts = cleaned.split('/in/');
    if (parts.length > 1) {
      const vanity = parts[1].split('/')[0].split('?')[0];
      if (vanity.length > 0) {
        return vanity;
      }
    }
  } catch (err: any) {
    console.error(`[unipile]: Error parsing LinkedIn URL: ${url}`, err.message);
  }
  throw new Error(`Failed to parse valid LinkedIn vanity ID from URL: ${url}`);
}

/**
 * Stage 1: Resolves the LinkedIn profile provider ID, drafts a hyper-personalized
 * connection request note under 200 characters, and writes them to the prospect's metadata staging area.
 */
export async function generateAndStageInvite(prospectId: string, modelOverride?: string): Promise<void> {
  console.log(`[linkedin-service]: Drafting tailored invite note for prospect ID: ${prospectId}`);

  // 1. Fetch prospect details from PostgreSQL
  const prospectResult = await db.query(
    'SELECT id, first_name, last_name, designation, company_name, linkedin_url, metadata FROM prospects WHERE id = $1',
    [prospectId]
  );

  if (prospectResult.rowCount === 0) {
    throw new Error(`Prospect not found in database: ${prospectId}`);
  }

  const prospect = prospectResult.rows[0];
  if (!prospect.linkedin_url) {
    throw new Error(`Prospect does not have a LinkedIn URL: ${prospectId}`);
  }

  const vanityId = extractLinkedInVanityId(prospect.linkedin_url);

  // 2. Lookup and resolve the Unipile internal provider ID
  let providerId = `mock_provider_${vanityId}`;
  let profileMetadata: any = { mock: true, resolvedAt: new Date().toISOString() };

  if (config.UNIPILE_ACCESS_TOKEN !== 'mock_unipile_token_here' && config.APP_ENV === 'production') {
    console.log(`[unipile]: Requesting profile resolution for vanity identifier "${vanityId}"...`);
    try {
      const url = `${config.UNIPILE_API_URL}/api/v1/users/${vanityId}?account_id=${config.UNIPILE_ACCOUNT_ID}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-API-KEY': config.UNIPILE_ACCESS_TOKEN,
          'Authorization': `Bearer ${config.UNIPILE_ACCESS_TOKEN}`,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Unipile user resolution returned status ${response.status}: ${response.statusText}`);
      }

      const body = (await response.json()) as any;
      providerId = body.provider_id || body.id;
      if (!providerId) {
        throw new Error('Unipile response did not return a provider_id or id parameter');
      }
      profileMetadata = body;
    } catch (err: any) {
      console.error(`❌ [unipile]: Live profile resolution failed for "${vanityId}":`, err.message);
      throw err;
    }
  } else {
    console.log('[unipile]: Mocking profile resolution path...');
  }

  // 3. Draft hyper-personalized invitation text nested in Langfuse trace
  await traceAIWorkflow('draft-linkedin-invite', prospect.id, async (trace) => {
    const prompt = `Draft a highly personalized, non-salesy LinkedIn connection invitation note under 200 characters for a prospect.
Name: ${prospect.first_name || ''} ${prospect.last_name || ''}
Designation: ${prospect.designation || ''}
Company: ${prospect.company_name || ''}
Target Business Pitch: Custom, enterprise-grade Agentic AI implementation services.
Rules: Do NOT sound generic or sell. Lead with business interest or connection. Keep the length STRICTLY under 200 characters including spaces.`;

    const draftedMessage = await generateReasoning(prompt, trace, modelOverride);
    
    // Enforce size rules (Unipile/LinkedIn character limits are strictly 200 for notes)
    const sanitizedNote = draftedMessage.substring(0, 199);

    const currentMetadata = prospect.metadata || {};
    const updatedMetadata = {
      ...currentMetadata,
      staged_invite: sanitizedNote,
      unipile_provider_id: providerId,
      invite_approved: false,
      resolved_profile_metadata: profileMetadata,
      drafted_at: new Date().toISOString()
    };

    // Update prospect details in database
    await db.query(
      'UPDATE prospects SET metadata = $1 WHERE id = $2',
      [JSON.stringify(updatedMetadata), prospect.id]
    );

    console.log('[database]: Staged invitation copy successfully inside metadata.');
  });
}

/**
 * Stage 2: Queue the approved prospect connection request using native BullMQ delayed jobs (jitter)
 */
export async function queueApprovedInvite(prospectId: string): Promise<void> {
  // Fetch prospect approval metadata parameters
  const result = await db.query('SELECT id, metadata FROM prospects WHERE id = $1', [prospectId]);
  if (result.rowCount === 0) {
    throw new Error(`Prospect not found: ${prospectId}`);
  }

  const prospect = result.rows[0];
  const metadata = prospect.metadata || {};

  if (metadata.invite_approved !== true) {
    throw new Error(`Outbound invite queue failed: Prospect ${prospectId} invite is not approved.`);
  }

  if (!metadata.unipile_provider_id || !metadata.staged_invite) {
    throw new Error(`Outbound invite queue failed: Missing resolved provider_id or staged invite for prospect ${prospectId}.`);
  }

  // Calculate randomized delay jitter to bypass bot-fingerprints
  let jitterMs = 0;
  if (config.APP_ENV === 'production') {
    // 8 to 25 minutes in milliseconds
    const minMin = 8;
    const maxMin = 25;
    const selectedMin = Math.floor(Math.random() * (maxMin - minMin + 1)) + minMin;
    jitterMs = selectedMin * 60 * 1000;
  } else {
    // 1 to 3 seconds for fast local test feedback loop execution
    const minSec = 1;
    const maxSec = 3;
    const selectedSec = Math.floor(Math.random() * (maxSec - minSec + 1)) + minSec;
    jitterMs = selectedSec * 1000;
  }

  // Push task to outreach Queue with BullMQ native delayed configuration
  await outreachQueue.add(
    'send-linkedin-invite',
    { prospectId },
    { delay: jitterMs }
  );

  console.log(`[queue]: Job added to outreach-tasks queue with active native delay metric: ${jitterMs}ms`);
}

/**
 * Stage 3: Handle Unipile Webhooks verifying incoming hashes and updating prospect states
 */
export async function handleUnipileWebhook(req: Request, res: Response): Promise<Response> {
  const signature = req.headers['x-unipile-signature'] as string;
  if (!signature) {
    console.warn('[webhook]: Webhook signature header "x-unipile-signature" missing.');
    return res.status(401).json({ error: 'Missing webhook signature verification header' });
  }

  // Verify HMAC SHA256 signature payloads
  const payloadString = JSON.stringify(req.body);
  const computedSignature = crypto
    .createHmac('sha256', config.UNIPILE_WEBHOOK_SECRET)
    .update(payloadString)
    .digest('hex');

  // Skip strict verification check in development if using default mock values
  const isMockSecret = config.UNIPILE_WEBHOOK_SECRET === 'your_webhook_signature_secret_here';
  if (!isMockSecret && signature !== computedSignature) {
    console.error('[webhook]: Invalid webhook HMAC signature verification failed.');
    return res.status(403).json({ error: 'Invalid webhook security signature matching verification' });
  }

  try {
    const { event, invitation_id, data } = req.body;
    
    // Resolve invitation ID either from root parameters or from nested payload maps
    const resolvedInviteId = invitation_id || data?.invitation_id || data?.id;

    if (event === 'invitation.accepted' && resolvedInviteId) {
      console.log(`[webhook]: invitation.accepted event received for Unipile ID: ${resolvedInviteId}`);

      // Perform indexed lookups to transition statuses to LI_CONNECTED
      const result = await db.query(
        "UPDATE prospects SET status = 'LI_CONNECTED', updated_at = CURRENT_TIMESTAMP WHERE unipile_invitation_id = $1 RETURNING id",
        [resolvedInviteId]
      );

      if (result.rowCount && result.rowCount > 0) {
        console.log(`[database]: Webhook state transition successful. Prospect ${result.rows[0].id} upgraded to 'LI_CONNECTED'.`);
      } else {
        console.warn(`[webhook]: No prospect record was found matching unipile_invitation_id: ${resolvedInviteId}`);
      }
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err: any) {
    console.error('[webhook]: Failed to process incoming webhook events:', err.message);
    return res.status(500).json({ error: 'Internal server webhook processing failed' });
  }
}
