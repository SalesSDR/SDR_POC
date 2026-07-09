import db from '../src/config/database';
import { generateAndStageInvite, queueApprovedInvite } from '../src/services/linkedin/unipile';
import { outreachQueue } from '../src/services/queue/outreachQueue';
import { outreachWorker } from '../src/services/queue/workers';
import { initiateOutboundCall } from '../src/services/voice/twilioVoice';
import express from 'express';
import router from '../src/routes/webhookRoutes';
import crypto from 'crypto';
import config from '../src/config/env';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStatus(prospectId: string, expectedStatus: string, timeoutMs: number = 20000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await db.query('SELECT status FROM prospects WHERE id = $1', [prospectId]);
    const status = res.rows[0]?.status;
    if (status === expectedStatus) {
      return status;
    }
    await delay(1000);
  }
  const finalRes = await db.query('SELECT status FROM prospects WHERE id = $1', [prospectId]);
  return finalRes.rows[0]?.status || 'UNKNOWN';
}

async function runE2EPipelineTest() {
  const toNumber = process.argv[2];

  if (!toNumber) {
    console.error('\n❌ ERROR: Phone number is required.');
    console.log('Usage: npx ts-node scripts/run_e2e_pipeline_test.ts <your_phone_number>');
    console.log('Example: npx ts-node scripts/run_e2e_pipeline_test.ts +15551234567\n');
    process.exit(1);
  }

  console.log('================================================================');
  console.log('🏁 STARTING END-TO-END AI SDR PIPELINE SEQUENTIAL TEST 🏁');
  console.log('================================================================');

  const testProspectId = `demo_live_${Date.now()}`;
  const mockEmail = 'myagenttest30@gmail.com';
  const mockLinkedin = 'https://www.linkedin.com/in/meenakshi-singh-2b45192a2/';
  let prospectId = '';
  let testServer: any = null;

  try {
    // -------------------------------------------------------------
    // STEP 1: Pipeline Initialization (LinkedIn Stage Ingestion)
    // -------------------------------------------------------------
    console.log('\n--- 📂 Step 1: Ingesting Demo Lead & Initializing LinkedIn State ---');
    // Clear any conflicting prospects to prevent unique constraint violations
    await db.query('DELETE FROM prospects WHERE email = $1 OR linkedin_url = $2', [mockEmail, mockLinkedin]);

    const insertResult = await db.query(
      `INSERT INTO prospects (
        apollo_id, first_name, last_name, email, linkedin_url, designation, company_name, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', $8) RETURNING id`,
      [
        testProspectId,
        'Meenakshi',
        'Singh',
        mockEmail,
        mockLinkedin,
        'Chief Sales Officer',
        'Acme Sales Corp',
        JSON.stringify({ phone: toNumber })
      ]
    );
    prospectId = insertResult.rows[0].id;
    console.log(`✅ Demo prospect Meenakshi Singh inserted successfully. ID: ${prospectId}`);

    // -------------------------------------------------------------
    // STEP 2: Personalized Invitation Draft Staging
    // -------------------------------------------------------------
    console.log('\n--- 📝 Step 2: Generating Tailored LinkedIn Note via Gemini ---');
    await generateAndStageInvite(prospectId, 'gemini-flash-latest');

    // Retrieve and assert invite staged in metadata
    const metadataCheck = await db.query('SELECT metadata FROM prospects WHERE id = $1', [prospectId]);
    const metadata = metadataCheck.rows[0].metadata || {};
    
    if (!metadata.staged_invite || !metadata.unipile_provider_id) {
      throw new Error('Verification failed: Staged invite draft metadata structure is malformed.');
    }
    console.log(`✅ LinkedIn connection note staged successfully: "${metadata.staged_invite}"`);

    // -------------------------------------------------------------
    // STEP 3: Staging Approval & Connection Dispatch
    // -------------------------------------------------------------
    console.log('\n--- 🚀 Step 3: Simulating Approval & Queueing LinkedIn Invitation ---');
    metadata.invite_approved = true;
    await db.query('UPDATE prospects SET metadata = $1 WHERE id = $2', [JSON.stringify(metadata), prospectId]);

    await queueApprovedInvite(prospectId);
    console.log('✅ Outreach job enqueued in BullMQ.');

    console.log('[test]: Waiting for BullMQ worker to process connection invite (polling)...');
    const status1 = await waitForStatus(prospectId, 'LI_INVITED', 20000);
    console.log(`[test]: Current Prospect status: ${status1}`);
    
    if (status1 !== 'LI_INVITED') {
      throw new Error(`Assertion failed: Status is '${status1}' (expected: LI_INVITED)`);
    }
    console.log('✅ Pipeline LinkedIn dispatch successfully validated.');

    // -------------------------------------------------------------
    // STEP 4: Email Escalation (No LinkedIn Reply Timeout)
    // -------------------------------------------------------------
    console.log('\n--- ✉️ Step 4: Simulating 24h Sequence Wait (Cold Email Escalation) ---');
    console.log('[test]: Waiting 5 seconds to simulate sequence follow-up timeout...');
    await delay(5000);

    const checkReply = await db.query('SELECT linkedin_replied FROM prospects WHERE id = $1', [prospectId]);
    if (checkReply.rows[0]?.linkedin_replied) {
      throw new Error('Assertion failed: Lead should not have replied yet.');
    }

    console.log('[test]: Dispatching evaluate_linkedin_to_email_sequence job...');
    const sequenceJob = await outreachQueue.add('evaluate_linkedin_to_email_sequence', { prospectId });
    console.log(`[test]: Enqueued sequence evaluation Job ID: ${sequenceJob.id}`);

    console.log('[test]: Waiting for BullMQ worker to process sequence evaluation (polling)...');
    const status2 = await waitForStatus(prospectId, 'EMAIL_SENT', 20000);
    console.log(`[test]: Current Prospect status: ${status2}`);
    
    const statusCheck2 = await db.query('SELECT status, smartlead_id FROM prospects WHERE id = $1', [prospectId]);
    const prospectAfterEmail = statusCheck2.rows[0];
    console.log(`[test]: Status: ${prospectAfterEmail.status}, Smartlead ID: ${prospectAfterEmail.smartlead_id}`);
    
    if (prospectAfterEmail.status !== 'EMAIL_SENT' || !prospectAfterEmail.smartlead_id) {
      throw new Error(`Assertion failed: Status is ${prospectAfterEmail.status} (expected: EMAIL_SENT)`);
    }
    console.log('✅ Pipeline Email escalation successfully validated.');

    // -------------------------------------------------------------
    // STEP 5: Inbound Reply Webhook and Intent Classification
    // -------------------------------------------------------------
    console.log('\n--- 💬 Step 5: Simulating Warm Email Response Webhook & Intent Classifier ---');

    // Spin up temporary Express server to mock webhook endpoint
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/webhooks', router);
    testServer = testApp.listen(3050);
    console.log('[test-setup] Temporary test server started on port 3050');

    const smartleadId = prospectAfterEmail.smartlead_id;
    const replyBody = "This sounds highly relevant to our CSO's goals. Let's talk over a call.";

    // Sign payload
    const webhookPayload = {
      id: smartleadId,
      reply_body: replyBody
    };
    const payloadString = JSON.stringify(webhookPayload);
    const webhookSignature = crypto
      .createHmac('sha256', config.SMARTLEAD_WEBHOOK_SECRET)
      .update(payloadString)
      .digest('hex');

    console.log('[test]: Emitting signed warm reply webhook to test server...');
    const webhookRes = await fetch('http://localhost:3050/webhooks/smartlead/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-smartlead-signature': webhookSignature
      },
      body: payloadString
    });

    if (!webhookRes.ok) {
      const errorBody = await webhookRes.text();
      throw new Error(`Smartlead webhook failed with status ${webhookRes.status}: ${errorBody}`);
    }
    console.log('✅ Smartlead webhook successfully accepted by route.');

    console.log('[test]: Waiting for Gemini intent classification (polling)...');
    const status3 = await waitForStatus(prospectId, 'REPLIED_INTERESTED', 20000);
    console.log(`[test]: Current Prospect status: ${status3}`);
    
    if (status3 !== 'REPLIED_INTERESTED') {
      throw new Error(`Assertion failed: Expected status REPLIED_INTERESTED, got: ${status3}`);
    }
    console.log('✅ Sentiment classified as INTERESTED and status upgraded.');

    // -------------------------------------------------------------
    // STEP 6: Outbound Call Placement
    // -------------------------------------------------------------
    console.log('\n--- 📞 Step 6: Triggering Outbound Voice Escalation ---');
    console.log('[test]: Waiting 5 seconds to simulate voice dial delay...');
    await delay(5000);

    console.log('[test]: Placing outbound Twilio call...');
    
    // Backup and temporarily assign public host if blank
    const hostBackup = config.SERVER_PUBLIC_HOST;
    if (!config.SERVER_PUBLIC_HOST) {
      (config as any).SERVER_PUBLIC_HOST = 'test-tunnel.ngrok-free.app';
    }

    await initiateOutboundCall(prospectId, toNumber);

    (config as any).SERVER_PUBLIC_HOST = hostBackup;
    console.log('✅ Voice call successfully placed.');

    console.log('\n================================================================');
    console.log('🎉 ALL PIPELINE E2E INTEGRATION TESTS COMPLETED SUCCESSFULLY! 🎉');
    console.log('================================================================');

  } catch (err: any) {
    console.error('\n❌ E2E PIPELINE RUN FAILED:', err.stack || err.message);
    process.exit(1);
  } finally {
    if (testServer) {
      console.log('\n[test]: Stopping temporary test server...');
      testServer.close();
    }

    
    console.log('[test]: Shutting down database connection pool and queue workers...');
    await outreachWorker.close();
    await outreachQueue.close();
    await db.close();
    console.log('[test]: Shutdown complete. Exiting.');
    process.exit(0);
  }
}

runE2EPipelineTest();
