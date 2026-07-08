process.env.PORT = '3009';

import db from '../src/config/database';
import config from '../src/config/env';
import { fetchAndCacheLeads } from '../src/services/data/apollo';
import { queueApprovedInvite } from '../src/services/linkedin/unipile';
import { outreachQueue } from '../src/services/queue/outreachQueue';
import { outreachWorker } from '../src/services/queue/workers';
import crypto from 'crypto';

const TEST_PORT = Number(config.PORT);

// Import Express app to spawn the server listener dynamically
import app from '../src/app';
console.log(`[verify-poc] Spawning Express server framework... app loaded: ${!!app}`);

async function runVerificationHarness() {
  console.log('==================================================================');
  console.log('🦁 [verify-poc]: Starting E2E Verification Harness (Day 2 POC) 🦁');
  console.log('==================================================================');

  try {
    // ==========================================
    // MILESTONE A: Apollo Ingestion & Caching
    // ==========================================
    console.log('\n[verify-poc] Testing Milestone A: Ingestion & Caching...');
    const criteria = {
      titles: ['Chief Sales Officer', 'VP of Sales'],
      geographies: ['US', 'India', 'United Arab Emirates'],
    };

    console.log('[verify-poc] Running Ingestion Pass 1...');
    const pass1 = await fetchAndCacheLeads(criteria);
    console.log('[verify-poc] Pass 1 Metrics:', pass1);
    if (pass1.totalProcessed === 0) {
      throw new Error('Milestone A Assertion Failed: Ingestion did not parse any leads.');
    }

    console.log('[verify-poc] Running Ingestion Pass 2 (Idempotency Cache Check)...');
    const pass2 = await fetchAndCacheLeads(criteria);
    console.log('[verify-poc] Pass 2 Metrics:', pass2);
    if (pass2.duplicatesSkipped !== pass2.totalProcessed) {
      throw new Error('Milestone A Assertion Failed: Duplicate cache checks did not skip all leads.');
    }
    console.log('✅ Milestone A: Apollo extraction and caching idempotency checks verified successfully.');

    // Retrieve a target lead for downstream checks
    const targetQuery = await db.query('SELECT id, email, metadata FROM prospects LIMIT 1');
    if (targetQuery.rowCount === 0) {
      throw new Error('Milestone B Assertion Failed: No prospects in PostgreSQL to verify outreach.');
    }
    const targetProspect = targetQuery.rows[0];
    
    // Ensure email is present
    if (!targetProspect.email) {
      targetProspect.email = `test_verification_${Date.now()}@example.com`;
      await db.query('UPDATE prospects SET email = $1 WHERE id = $2', [targetProspect.email, targetProspect.id]);
    }
    console.log(`[verify-poc] Selected Prospect ID: ${targetProspect.id} for downstream task staging.`);

    // ==========================================
    // MILESTONE B: Outreach & Queue Jitter Check
    // ==========================================
    console.log('\n[verify-poc] Testing Milestone B: Outreach Workers & Queue Jitter...');
    const stagedMetadata = targetProspect.metadata || {};
    stagedMetadata.staged_invite = "Hi, love your cloud operations. Let's connect!";
    stagedMetadata.unipile_provider_id = "mock_provider_verification_pipeline";
    stagedMetadata.invite_approved = true;

    await db.query('UPDATE prospects SET metadata = $1 WHERE id = $2', [JSON.stringify(stagedMetadata), targetProspect.id]);
    
    console.log('[verify-poc] Triggering queueApprovedInvite...');
    await queueApprovedInvite(targetProspect.id);

    // Verify job in BullMQ
    const queuedJobs = await outreachQueue.getJobs(['delayed', 'waiting']);
    const outreachJob = queuedJobs.find(job => job.data.prospectId === targetProspect.id);
    if (!outreachJob) {
      throw new Error('Milestone B Assertion Failed: Job was not correctly written to BullMQ.');
    }
    console.log(`[verify-poc] Outreach job successfully found in queue. ID: ${outreachJob.id}`);
    console.log(`[verify-poc] Job delay configurations: ${outreachJob.opts.delay}ms`);
    if (!outreachJob.opts.delay || outreachJob.opts.delay <= 0) {
      throw new Error('Milestone B Assertion Failed: Outreach job did not enforce delayed execution jitter.');
    }
    console.log('✅ Milestone B: BullMQ queue ingestion and delay jitter verified successfully.');

    // Clean up queued test job to keep BullMQ clean
    await outreachJob.remove();

    // ==========================================
    // MILESTONE B: Webhook Cryptographic Check
    // ==========================================
    console.log('\n[verify-poc] Testing Webhook Signature Verification...');
    const invitationId = `mock_verification_invite_${Date.now()}`;
    await db.query('UPDATE prospects SET unipile_invitation_id = $1 WHERE id = $2', [invitationId, targetProspect.id]);

    const webhookPayload = {
      event: 'invitation.accepted',
      invitation_id: invitationId
    };
    const rawBufferPayload = JSON.stringify(webhookPayload);
    const validSignature = crypto
      .createHmac('sha256', config.UNIPILE_WEBHOOK_SECRET)
      .update(rawBufferPayload)
      .digest('hex');

    console.log('[verify-poc] Sending valid webhook payload...');
    const validResponse = await fetch(`http://localhost:${TEST_PORT}/webhooks/unipile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-unipile-signature': validSignature
      },
      body: rawBufferPayload
    });

    console.log(`[verify-poc] Webhook HTTP Response Code: ${validResponse.status}`);
    if (validResponse.status !== 200) {
      throw new Error(`Milestone B Assertion Failed: Webhook rejected valid signature with HTTP ${validResponse.status}`);
    }

    const verifyStatus = await db.query('SELECT status FROM prospects WHERE id = $1', [targetProspect.id]);
    console.log(`[verify-poc] Database prospect status after accepted webhook: ${verifyStatus.rows[0].status}`);
    if (verifyStatus.rows[0].status !== 'LI_CONNECTED') {
      throw new Error('Milestone B Assertion Failed: Database prospect status did not transition to LI_CONNECTED.');
    }

    console.log('[verify-poc] Sending tampered signature webhook payload...');
    const invalidResponse = await fetch(`http://localhost:${TEST_PORT}/webhooks/unipile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-unipile-signature': 'tampered_signature_payload_token'
      },
      body: rawBufferPayload
    });
    console.log(`[verify-poc] Tampered webhook HTTP Response Code: ${invalidResponse.status}`);
    if (invalidResponse.status !== 401) {
      throw new Error(`Milestone B Assertion Failed: Webhook did not reject tampered signature with HTTP 401.`);
    }
    console.log('✅ Milestone B: Webhook cryptographic verification checks verified successfully.');

    // ==========================================
    // MILESTONE C: Gemini Intent Classification
    // ==========================================
    console.log('\n[verify-poc] Testing Milestone C: Gemini Intent Classification & Tracing...');
    const smartleadId = `mock_sl_verification_${Date.now()}`;
    await db.query('UPDATE prospects SET smartlead_id = $1 WHERE id = $2', [smartleadId, targetProspect.id]);

    const emailReplyPayload = {
      id: smartleadId,
      reply_body: 'This sounds fantastic Sarah. Can we connect on a video call next Tuesday at 2 PM?'
    };
    const rawSmartleadPayload = JSON.stringify(emailReplyPayload);
    const smartleadSignature = crypto
      .createHmac('sha256', config.SMARTLEAD_WEBHOOK_SECRET)
      .update(rawSmartleadPayload)
      .digest('hex');

    console.log('[verify-poc] Delivering Smartlead email reply webhook...');
    const smartleadResponse = await fetch(`http://localhost:${TEST_PORT}/webhooks/smartlead/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smartlead-signature': smartleadSignature
      },
      body: rawSmartleadPayload
    });

    console.log(`[verify-poc] Smartlead Webhook HTTP Response Code: ${smartleadResponse.status}`);
    if (smartleadResponse.status !== 200) {
      throw new Error(`Milestone C Assertion Failed: Smartlead webhook failed with HTTP ${smartleadResponse.status}`);
    }

    const emailStatusCheck = await db.query('SELECT status FROM prospects WHERE id = $1', [targetProspect.id]);
    console.log(`[verify-poc] Prospect status after Smartlead email reply update: ${emailStatusCheck.rows[0].status}`);
    const allowedStatuses = ['REPLIED_INTERESTED', 'NEW'];
    if (!allowedStatuses.includes(emailStatusCheck.rows[0].status)) {
      throw new Error(`Milestone C Assertion Failed: Database status (${emailStatusCheck.rows[0].status}) did not transition correctly.`);
    }

    const traceCheck = await db.query(
      'SELECT gemini_intent_tag, langfuse_trace_id FROM interaction_logs WHERE prospect_id = $1 ORDER BY created_at DESC LIMIT 1',
      [targetProspect.id]
    );
    if (traceCheck.rowCount === 0) {
      throw new Error('Milestone C Assertion Failed: Interaction logs did not write logs for webhook reply.');
    }
    const logItem = traceCheck.rows[0];
    console.log(`[verify-poc] Saved Intent Tag: ${logItem.gemini_intent_tag}`);
    console.log(`[verify-poc] Saved Langfuse Trace ID: ${logItem.langfuse_trace_id}`);
    const allowedIntents = ['INTERESTED', 'QUESTION'];
    if (!allowedIntents.includes(logItem.gemini_intent_tag)) {
      throw new Error(`Milestone C Assertion Failed: Gemini classified reply as ${logItem.gemini_intent_tag} instead of expected tags.`);
    }
    if (!logItem.langfuse_trace_id) {
      throw new Error('Milestone C Assertion Failed: Interaction logs do not reference a valid Langfuse trace ID.');
    }
    console.log('✅ Milestone C: Gemini responseSchema classification and Langfuse tracking verified successfully.');

    console.log('\n==================================================================');
    console.log('🎉 [verify-poc]: ALL E2E VERIFICATION HARNESS ASSERTIONS PASSED 🎉');
    console.log('==================================================================');

  } catch (err: any) {
    console.error('\n❌ [verify-poc]: E2E Verification Harness Failed:', err.stack || err.message);
    process.exit(1);
  } finally {
    console.log('[verify-poc] Closing handles and shutting down test server...');
    try {
      await outreachWorker.close();
      await db.close();
      console.log('✅ Connections closed. Test run complete.');
    } catch (cleanupErr: any) {
      console.error('[verify-poc] Cleanups encountered error:', cleanupErr.message);
    }
    process.exit(0);
  }
}

runVerificationHarness();
