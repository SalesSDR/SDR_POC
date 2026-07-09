import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import config from '../config/env';
import db from '../config/database';
import { traceInboundAnalysis } from '../services/ai/observability';
import { classifyEmailIntent } from '../services/email/smartlead';
import { outreachQueue } from '../services/queue/outreachQueue';

const router = Router();

interface SmartleadWebhookBody {
  id?: number | string;
  lead_id?: number | string;
  reply_body?: string;
  message?: string;
  email_body?: string;
  lead?: {
    id?: number | string;
  };
}

/**
 * Express router path mapping webhook triggers for inbound replies.
 * POST /webhooks/smartlead/reply
 */
router.post('/smartlead/reply', handleSmartleadReplyWebhook);

/**
 * Express router path mapping webhook triggers for Unipile LinkedIn events.
 * POST /webhooks/unipile
 */
router.post('/unipile', handleUnipileWebhook);

export async function handleSmartleadReplyWebhook(req: Request, res: Response): Promise<Response> {
  console.log('[webhook-listener]: Inbound Smartlead event captured. Verifying signature hash...');

  const signature = req.headers['x-smartlead-signature'] as string;
  if (!signature) {
    console.warn('[webhook]: Smartlead signature header "x-smartlead-signature" missing.');
    return res.status(401).json({ error: 'Missing webhook signature verification header' });
  }

  // Calculate HMAC SHA256 payload signature
  const payloadString = (req as any).rawBody
    ? (req as any).rawBody.toString('utf8')
    : JSON.stringify(req.body);
  const computedSignature = crypto
    .createHmac('sha256', config.SMARTLEAD_WEBHOOK_SECRET)
    .update(payloadString)
    .digest('hex');

  const isBypass = config.APP_ENV === 'development' && (signature === 'test-sig' || signature === 'mock-signature');
  if (signature !== computedSignature && !isBypass) {
    console.error('[webhook]: Invalid Smartlead HMAC signature verification failed.');
    return res.status(401).json({ error: 'Invalid webhook security signature matching verification' });
  }

  try {
    const body = req.body as SmartleadWebhookBody;
    
    // Sequence parse the smartlead lead tracking ID
    const smartleadId = String(body.id || body.lead_id || body.lead?.id || '');
    const replyBody = body.reply_body || body.message || body.email_body || '';

    if (!smartleadId) {
      return res.status(400).json({ error: 'Missing smartlead identifier in payload body' });
    }

    console.log(`[webhook]: Inbound reply received for Smartlead ID: ${smartleadId}`);

    // Lookup the matching prospect in database
    const prospectResult = await db.query(
      'SELECT id, status FROM prospects WHERE smartlead_id = $1',
      [smartleadId]
    );

    if (prospectResult.rowCount === 0) {
      console.warn(`[webhook]: No prospect matches smartlead_id: ${smartleadId}`);
      return res.status(200).json({ warning: 'Smartlead lead ID not resolved to a database prospect' });
    }

    const prospect = prospectResult.rows[0];

    // Wrap execution context inside a Langfuse trace
    await traceInboundAnalysis(prospect.id, 'EMAIL', replyBody, async (trace) => {
      // Classify the reply text intent using gemini-1.5-flash
      const intent = await classifyEmailIntent(replyBody, trace);
      console.log(`[webhook]: Incoming reply received. Intent classified as '${intent}'. Prospect state updated.`);

      // Update prospect status based on intent
      let newStatus = prospect.status;
      if (intent === 'INTERESTED') {
        newStatus = 'REPLIED_INTERESTED';
      } else if (intent === 'NOT_INTERESTED') {
        newStatus = 'REPLIED_NOT_INTERESTED';
      } else if (intent === 'QUESTION') {
        newStatus = 'NEW';
      } else if (intent === 'OOO') {
        newStatus = 'EMAIL_SENT'; // Keep as emailed
      }

      // Update PostgreSQL ledger
      await db.query(
        "UPDATE prospects SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        [newStatus, prospect.id]
      );
      console.log(`[webhook-listener]: HMAC calculation matches header. Status updated successfully to '${newStatus}'.`);

      // Save record tracking detail to interaction logs
      await db.query(
        `INSERT INTO interaction_logs (prospect_id, channel, direction, message_content, gemini_intent_tag, langfuse_trace_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [prospect.id, 'EMAIL', 'INBOUND', replyBody, intent, trace.id]
      );
      console.log('[database]: Interaction tracking log recorded with trace_id lookup tags.');
    });

    return res.status(200).json({ status: 'ok' });
  } catch (err: any) {
    console.error('[webhook]: Failed to process incoming Smartlead webhook:', err.message);
    return res.status(500).json({ error: 'Internal server webhook processing failed' });
  }
}

export async function handleUnipileWebhook(req: Request, res: Response): Promise<Response> {
  console.log('[webhook-listener]: Inbound Unipile event captured. Verifying signature hash...');

  const signature = req.headers['x-unipile-signature'] as string;
  if (!signature) {
    console.warn('[webhook]: Webhook signature header "x-unipile-signature" missing.');
    return res.status(401).json({ error: 'Missing webhook signature verification header' });
  }

  // Calculate HMAC SHA256 payload signature
  const payloadString = (req as any).rawBody
    ? (req as any).rawBody.toString('utf8')
    : JSON.stringify(req.body);
  const computedSignature = crypto
    .createHmac('sha256', config.UNIPILE_WEBHOOK_SECRET)
    .update(payloadString)
    .digest('hex');

  const isBypass = config.APP_ENV === 'development' && (signature === 'test-sig' || signature === 'mock-signature');
  if (signature !== computedSignature && !isBypass) {
    console.error('[webhook]: Invalid webhook HMAC signature verification failed.');
    return res.status(401).json({ error: 'Invalid webhook security signature matching verification' });
  }

  try {
    const { event, invitation_id, data } = req.body;
    
    // Resolve invitation ID either from root parameters or from nested payload maps
    const resolvedInviteId = invitation_id || data?.invitation_id || data?.id;

    if (event === 'invitation.accepted' && resolvedInviteId) {
      console.log(`[webhook]: invitation.accepted event received for Unipile ID: ${resolvedInviteId}`);

      // Perform indexed lookups to transition statuses to LI_CONNECTED and record timestamp
      const result = await db.query(
        `UPDATE prospects 
         SET status = 'LI_CONNECTED', 
             linkedin_connected_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP 
         WHERE unipile_invitation_id = $1 
         RETURNING id`,
        [resolvedInviteId]
      );

      if (result.rowCount && result.rowCount > 0) {
        const prospectId = result.rows[0].id;
        console.log(`[database]: Webhook state transition successful. Prospect ${prospectId} upgraded to 'LI_CONNECTED'.`);
        
        // Push a delayed evaluation job into outreach-tasks BullMQ queue
        const delayMs = config.LINKEDIN_FOLLOWUP_DELAY_MS;
        await outreachQueue.add(
          'evaluate_linkedin_to_email_sequence',
          { prospectId },
          {
            delay: delayMs,
            jobId: `email_delay_${prospectId}`, // Enforce stateless uniqueness to prevent duplicate webhooks from queueing twice
          }
        );
        console.log(`[queue]: Enqueued 'evaluate_linkedin_to_email_sequence' job for prospect ${prospectId} with delay ${delayMs}ms.`);
      } else {
        console.warn(`[webhook]: No prospect record was found matching unipile_invitation_id: ${resolvedInviteId}`);
      }
    }

    if (event === 'chat.message.received') {
      const direction = data?.direction;
      if (direction === 'INBOUND') {
        const senderId = data?.sender_id;
        const messageText = data?.text || '';

        console.log(`[webhook]: chat.message.received INBOUND event captured. Sender ID: ${senderId}`);

        if (!senderId) {
          return res.status(400).json({ error: 'Missing sender_id in webhook payload data' });
        }

        // Look up the prospect by matching sender_id against unipile_provider_id stored in metadata
        const prospectResult = await db.query(
          "SELECT id, status FROM prospects WHERE metadata->>'unipile_provider_id' = $1",
          [senderId]
        );

        if (prospectResult.rowCount && prospectResult.rowCount > 0) {
          const prospect = prospectResult.rows[0];
          console.log(`[webhook]: Resolved inbound LinkedIn message to prospect ID: ${prospect.id}`);

          // Wrap intent analysis inside Langfuse trace
          await traceInboundAnalysis(prospect.id, 'LINKEDIN', messageText, async (trace) => {
            const intent = await classifyEmailIntent(messageText, trace);
            console.log(`[webhook]: Classified LinkedIn message intent as: ${intent}`);

            // Set replied to true and update status based on intent
            let newStatus = 'REPLIED_INTERESTED';
            if (intent === 'NOT_INTERESTED') {
              newStatus = 'REPLIED_NOT_INTERESTED';
            } else if (intent === 'QUESTION' || intent === 'OOO') {
              newStatus = 'LI_CONNECTED';
            }

            await db.query(
              `UPDATE prospects 
               SET linkedin_replied = TRUE, 
                   status = $1, 
                   updated_at = CURRENT_TIMESTAMP 
               WHERE id = $2`,
              [newStatus, prospect.id]
            );

            // Log interaction in interaction_logs table
            await db.query(
              `INSERT INTO interaction_logs (prospect_id, channel, direction, message_content, gemini_intent_tag, langfuse_trace_id)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [prospect.id, 'LINKEDIN', 'INBOUND', messageText, intent, trace.id]
            );
            console.log(`[database]: Logged LinkedIn interaction for prospect ${prospect.id}.`);
          });
        } else {
          console.warn(`[webhook]: No prospect record found with provider_id: ${senderId}`);
        }
      }
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err: any) {
    console.error('[webhook]: Failed to process incoming Unipile webhook event:', err.message);
    return res.status(500).json({ error: 'Internal server webhook processing failed' });
  }
}

export default router;
