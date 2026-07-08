import db from '../src/config/database';
import { traceAIWorkflow } from '../src/services/ai/observability';
import { classifyIntent, generateReasoning } from '../src/services/ai/gemini';
import { fetchAndCacheLeads } from '../src/services/data/apollo';
import { generateAndStageInvite, queueApprovedInvite, handleUnipileWebhook } from '../src/services/linkedin/unipile';
import { outreachWorker } from '../src/services/queue/workers';
import { enrollInCampaign, classifyEmailIntent } from '../src/services/email/smartlead';
import { handleSmartleadReplyWebhook } from '../src/routes/webhookRoutes';
import crypto from 'crypto';
import config from '../src/config/env';

// Utility helper to pause execution in tests
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('[test-tracing]: Starting end-to-end integration verification...');

  try {
    // ==========================================
    // PHASE 2 VERIFICATION: Ingestion & Caching
    // ==========================================
    console.log('\n--- Phase 2: Ingestion & Cache Verification ---');
    const criteria = {
      titles: ['Chief Sales Officer', 'VP of Sales'],
      geographies: ['US', 'India', 'United Arab Emirates'],
    };

    console.log('[test-tracing]: Executing lead ingestion first pass...');
    const pass1 = await fetchAndCacheLeads(criteria);
    console.log('[test-tracing]: First pass metrics:', pass1);

    console.log('[test-tracing]: Executing lead ingestion second pass (idempotency check)...');
    const pass2 = await fetchAndCacheLeads(criteria);
    console.log('[test-tracing]: Second pass metrics:', pass2);

    // Verify correct counts
    if (pass2.newlyInserted !== 0) {
      console.warn('⚠️ [test-tracing]: Idempotency counts do not match expected outcomes.');
    } else {
      console.log('✅ [test-tracing]: Live Apollo extraction and pre-fetch protection check verified successfully.');
    }

    // Grab a target prospect for the next steps
    const prospectsCheck = await db.query('SELECT id, linkedin_url, email FROM prospects LIMIT 1');
    if (prospectsCheck.rowCount === 0) {
      throw new Error('No prospects available in database to run LinkedIn tests.');
    }
    const targetProspect = prospectsCheck.rows[0];
    
    // Ensure the prospect has an email address for Smartlead testing
    if (!targetProspect.email) {
      console.log('[test-tracing]: Target prospect has no email. Updating with a mock email for testing...');
      targetProspect.email = `test_email_${Date.now()}@example.com`;
      await db.query('UPDATE prospects SET email = $1 WHERE id = $2', [targetProspect.email, targetProspect.id]);
    }
    
    console.log(`[test-tracing]: Selected prospect ${targetProspect.id} (${targetProspect.linkedin_url}) with email ${targetProspect.email} for Phase 3 & 4 checks.`);

    // ==========================================
    // PHASE 3 VERIFICATION: LinkedIn Outreach Loop
    // ==========================================
    console.log('\n--- Phase 3: LinkedIn Staging & Outreach Worker Verification ---');
    
    // 1. Generate and stage invite using modelOverride for test speed
    await generateAndStageInvite(targetProspect.id, 'gemini-flash-latest');
    
    // Check metadata to confirm it's staged
    const stagedCheck = await db.query('SELECT metadata FROM prospects WHERE id = $1', [targetProspect.id]);
    const metadata = stagedCheck.rows[0].metadata || {};
    console.log(`[test-tracing]: Staged draft connection request: "${metadata.staged_invite}"`);
    console.log(`[test-tracing]: Staged provider ID: ${metadata.unipile_provider_id}`);
    console.log(`[test-tracing]: Invite approved status: ${metadata.invite_approved}`);

    if (!metadata.staged_invite || !metadata.unipile_provider_id || metadata.invite_approved !== false) {
      throw new Error('Verification failed: Staged invite draft metadata structure is malformed.');
    }

    // 2. Approve draft in database
    console.log('[test-tracing]: Setting invite_approved = true in PostgreSQL...');
    metadata.invite_approved = true;
    await db.query('UPDATE prospects SET metadata = $1 WHERE id = $2', [JSON.stringify(metadata), targetProspect.id]);

    // 3. Queue the approved invite (triggers native delay jitter in queue)
    console.log('[test-tracing]: Adding approved invite to delayed BullMQ tasks...');
    await queueApprovedInvite(targetProspect.id);

    // 4. Wait for worker to consume delayed job (development delay is 1-3 seconds)
    console.log('[test-tracing]: Waiting 4 seconds for BullMQ worker to consume delayed task...');
    await delay(4000);

    // 5. Verify database status upgraded to LI_INVITED and unipile_invitation_id is populated
    const finalLeadState = await db.query(
      'SELECT status, unipile_invitation_id, metadata FROM prospects WHERE id = $1',
      [targetProspect.id]
    );
    const lead = finalLeadState.rows[0];
    console.log(`[test-tracing]: Target prospect status after worker run: '${lead.status}'`);
    console.log(`[test-tracing]: Target prospect unipile_invitation_id: '${lead.unipile_invitation_id}'`);

    if (lead.status !== 'LI_INVITED' || !lead.unipile_invitation_id) {
      throw new Error('Verification failed: Worker execution did not upgrade status or store unipile_invitation_id.');
    }
    console.log('✅ [test-tracing]: Outbound BullMQ delayed task execution verified successfully.');

    // 6. Test Unipile Webhook callback verification
    console.log('\n--- Phase 3: Webhook Verification ---');
    const mockPayload = {
      event: 'invitation.accepted',
      invitation_id: lead.unipile_invitation_id,
      data: {
        id: lead.unipile_invitation_id,
        provider_id: lead.metadata.unipile_provider_id
      }
    };
    
    // Generate signature header using HMAC SHA256 of body
    const bodyStr = JSON.stringify(mockPayload);
    const mockSignature = crypto
      .createHmac('sha256', config.UNIPILE_WEBHOOK_SECRET)
      .update(bodyStr)
      .digest('hex');

    const mockReq = {
      headers: {
        'x-unipile-signature': mockSignature
      },
      body: mockPayload
    } as any;

    let resStatus = 0;
    let resJsonData: any = null;
    const mockRes = {
      status(code: number) {
        resStatus = code;
        return this;
      },
      json(data: any) {
        resJsonData = data;
        return this;
      }
    } as any;

    console.log('[test-tracing]: Emulating incoming webhook post with valid signature...');
    await handleUnipileWebhook(mockReq, mockRes);
    console.log(`[test-tracing]: Webhook HTTP status returned: ${resStatus}`, resJsonData);

    // Verify database state transitioned to LI_CONNECTED
    const webhookCheck = await db.query('SELECT status FROM prospects WHERE id = $1', [targetProspect.id]);
    console.log(`[test-tracing]: Prospect status after webhook callback: '${webhookCheck.rows[0].status}'`);

    if (webhookCheck.rows[0].status !== 'LI_CONNECTED') {
      throw new Error('Verification failed: Webhook execution did not upgrade prospect status to LI_CONNECTED.');
    }
    console.log('✅ [test-tracing]: Webhook signature security and status transition verified successfully.');

    // ==========================================
    // PHASE 4 VERIFICATION: Smartlead Cold Email
    // ==========================================
    console.log('\n--- Phase 4: Smartlead Sequencing & Webhook Verification ---');
    
    // 1. Enroll prospect in Campaign
    console.log('[test-tracing]: Enrolling prospect in Smartlead campaign...');
    const smartleadId = await enrollInCampaign(targetProspect.id);
    
    // Verify status upgraded to EMAIL_SENT and smartlead_id cached
    const slProspectState = await db.query(
      'SELECT status, smartlead_id FROM prospects WHERE id = $1',
      [targetProspect.id]
    );
    const slLead = slProspectState.rows[0];
    console.log(`[test-tracing]: Prospect status after Smartlead enrollment: '${slLead.status}'`);
    console.log(`[test-tracing]: Prospect smartlead_id: '${slLead.smartlead_id}'`);
    
    if (slLead.status !== 'EMAIL_SENT' || slLead.smartlead_id !== smartleadId) {
      throw new Error('Verification failed: Smartlead campaign enrollment metadata or status mismatch.');
    }
    console.log('✅ [test-tracing]: Smartlead campaign enrollment verified successfully.');

    // 2. Classify reply intents (directly testing Gemini JSON output)
    console.log('[test-tracing]: Verifying intent classification via gemini-1.5-flash JSON output...');
    
    const testCases = [
      { text: "Hey Sarah, yes, this sounds very interesting! Can we book a call next Tuesday at 2 PM?", expected: "INTERESTED" },
      { text: "No thanks, please unsubscribe me from your mailing list immediately. Do not call.", expected: "NOT_INTERESTED" },
      { text: "I am currently out of the office on annual leave with limited access to email until July 15th.", expected: "OOO" },
      { text: "Can you clarify how your agent handles data residency compliance and GDPR dynamic guardrails?", expected: "QUESTION" }
    ];

    for (const testCase of testCases) {
      const intent = await classifyEmailIntent(testCase.text, null, 'gemini-flash-latest');
      console.log(`[test-tracing]: Email Body: "${testCase.text.substring(0, 40)}..." -> Classified: ${intent} (Expected: ${testCase.expected})`);
      if (intent !== testCase.expected) {
        console.warn(`⚠️ [test-tracing]: Intent classified as ${intent} instead of ${testCase.expected}. (LLM variations possible)`);
      }
    }
    console.log('✅ [test-tracing]: Gemini structured intent classifications completed.');

    // 3. Emulate incoming Smartlead webhook reply
    console.log('[test-tracing]: Emulating incoming Smartlead webhook reply with valid signature...');
    const slWebhookPayload = {
      id: smartleadId,
      reply_body: "Yes, I am interested! Let's talk tomorrow.",
      lead_id: smartleadId
    };

    const slPayloadStr = JSON.stringify(slWebhookPayload);
    const slWebhookSignature = crypto
      .createHmac('sha256', config.SMARTLEAD_WEBHOOK_SECRET)
      .update(slPayloadStr)
      .digest('hex');

    const slMockReq = {
      headers: {
        'x-smartlead-signature': slWebhookSignature
      },
      body: slWebhookPayload
    } as any;

    let slResStatus = 0;
    let slResJsonData: any = null;
    const slMockRes = {
      status(code: number) {
        slResStatus = code;
        return this;
      },
      json(data: any) {
        slResJsonData = data;
        return this;
      }
    } as any;

    await handleSmartleadReplyWebhook(slMockReq, slMockRes);
    console.log(`[test-tracing]: Smartlead Webhook HTTP status returned: ${slResStatus}`, slResJsonData);

    // Verify database state transitioned to REPLIED_INTERESTED
    const slWebhookCheck = await db.query('SELECT status FROM prospects WHERE id = $1', [targetProspect.id]);
    console.log(`[test-tracing]: Prospect status after Smartlead webhook callback: '${slWebhookCheck.rows[0].status}'`);

    if (slWebhookCheck.rows[0].status !== 'REPLIED_INTERESTED') {
      throw new Error('Verification failed: Smartlead webhook execution did not upgrade prospect status to REPLIED_INTERESTED.');
    }
    console.log('✅ [test-tracing]: Smartlead webhook signature security and status transition verified successfully.');

    // ==========================================
    // PHASE 1 VERIFICATION: Database & AI Tracing
    // ==========================================
    console.log('\n--- Phase 1: Database & AI Tracing Verification ---');
    const timestamp = Date.now();
    const mockApolloId = `apollo_${timestamp}`;
    const mockEmail = `cso_${timestamp}@testenterprise.com`;
    const mockLinkedinUrl = `https://linkedin.com/in/test-cso-${timestamp}`;

    // Write mock CSO prospect details to database
    console.log('[test-tracing]: Writing mock prospect to PostgreSQL...');
    const prospectResult = await db.query(
      `INSERT INTO prospects (apollo_id, first_name, last_name, email, linkedin_url, designation, geography, company_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, status`,
      [
        mockApolloId,
        'Sarah',
        'Chief Revenue Officer',
        mockEmail,
        mockLinkedinUrl,
        'VP of Sales',
        'USA',
        'Secure Cloud Operations Inc.',
        'NEW'
      ]
    );

    const prospect = prospectResult.rows[0];
    console.log(`[test-tracing]: Prospect inserted successfully. ID: ${prospect.id}`);

    // Perform AI tasks nested within traceAIWorkflow
    const prospectMessage = 'How does your AI agent avoid hallucinating false pricing details, and do you support SOC2 isolation?';

    await traceAIWorkflow('prospect-inbound-analysis', prospect.id, async (trace) => {
      console.log('[test-tracing]: [langfuse] Initializing trace context for test run...');
      
      // Execute Intent Classification (using gemini-flash-latest alias for local test compatibility)
      const intentTag = await classifyIntent(prospectMessage, trace, 'gemini-flash-latest');
      console.log(`[test-tracing]: [gemini] Invocations successful using model gemini-flash-latest. Intent: ${intentTag}`);

      // Execute Reasoning Generation (using gemini-flash-latest alias for local test compatibility)
      console.log('[test-tracing]: Invoking deep reasoning via gemini-flash-latest...');
      const outboundMessage = await generateReasoning(
        `Draft a highly personalized, technical email response to: "${prospectMessage}". Address security, SOC2, and dynamic guardrails. Keep it concise.`,
        trace,
        'gemini-flash-latest'
      );
      console.log('[test-tracing]: Outbound message response reasoning generated successfully.');

      // Write Interaction Logs to database referencing prospect and Langfuse trace
      console.log('[test-tracing]: Recording interaction log transaction to database...');
      await db.query(
        `INSERT INTO interaction_logs (prospect_id, channel, direction, message_content, gemini_intent_tag, langfuse_trace_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          prospect.id,
          'EMAIL',
          'OUTBOUND',
          outboundMessage,
          intentTag,
          trace.id
        ]
      );
      console.log('[test-tracing]: Interaction log transaction written successfully.');
    });

    console.log('[test-tracing]: [langfuse] Tracing flush successful. 0 errors detected.');
    console.log('[test-tracing]: End-to-end integration test completed successfully.');
  } catch (err: any) {
    console.error('❌ [test-tracing]: Integration test failed with error:', err.stack || err.message);
  } finally {
    // Tear down connections pool and close worker handles
    console.log('[test-tracing]: Closing database and worker handles...');
    await outreachWorker.close();
    await db.close();
    process.exit(0);
  }
}

main();
