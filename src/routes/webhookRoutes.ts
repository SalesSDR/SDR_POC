import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import config from '../config/env';
import db from '../config/database';
import { traceAIWorkflow } from '../services/ai/observability';
import { classifyEmailIntent } from '../services/email/smartlead';

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

export async function handleSmartleadReplyWebhook(req: Request, res: Response): Promise<Response> {
  console.log('[webhook-listener]: Inbound event captured. Verifying signature hash...');

  const signature = req.headers['x-smartlead-signature'] as string;
  if (!signature) {
    console.warn('[webhook]: Smartlead signature header "x-smartlead-signature" missing.');
    return res.status(401).json({ error: 'Missing webhook signature verification header' });
  }

  // Calculate HMAC SHA256 payload signature
  const payloadString = JSON.stringify(req.body);
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
    await traceAIWorkflow('email-inbound-reply', prospect.id, async (trace) => {
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
    });

    return res.status(200).json({ status: 'ok' });
  } catch (err: any) {
    console.error('[webhook]: Failed to process incoming Smartlead webhook:', err.message);
    return res.status(500).json({ error: 'Internal server webhook processing failed' });
  }
}

export default router;
