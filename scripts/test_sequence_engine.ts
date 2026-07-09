// Override environment configurations BEFORE any imports are loaded
process.env.PORT = '3009';                       // Port override to prevent conflict with running dev server
process.env.LINKEDIN_FOLLOWUP_DELAY_MS = '3000'; // 3 seconds delay for testing
process.env.ALLOW_LIVE_OUTREACH = 'false';       // Use mock API endpoints
process.env.APP_ENV = 'development';             // Allow test signature bypass

import db from '../src/config/database';
import config from '../src/config/env';
import '../src/app'; // Boot Express server inline
import { outreachQueue } from '../src/services/queue/outreachQueue';
import outreachWorker from '../src/services/queue/workers';

// Utility helper to pause execution
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  console.log('================================================================');
  console.log('🧪 Starting Multi-Channel Sequence Engine Integration Tests 🧪');
  console.log('================================================================');
  
  const baseUrl = `http://localhost:${config.PORT}`;
  console.log(`[test]: Targeting server baseUrl: ${baseUrl}`);

  try {
    // -------------------------------------------------------------
    // Clean previous test records
    // -------------------------------------------------------------
    console.log('[test]: Cleaning previous test prospects...');
    await db.query("DELETE FROM prospects WHERE apollo_id LIKE 'test_seq_%'");

    // -------------------------------------------------------------
    // TEST PATH A: Suppression (Inbound reply suppresses cold email)
    // -------------------------------------------------------------
    console.log('\n--- 📂 Test Path A: Suppression (Connection -> Reply -> Suppress Cold Email) ---');
    
    const apolloIdA = `test_seq_a_${Date.now()}`;
    const emailA = `test_suppress_${Date.now()}@example.com`;
    const inviteIdA = `invite_a_${Date.now()}`;
    const providerIdA = `provider_a_${Date.now()}`;

    // 1. Insert test prospect
    const prospectResultA = await db.query(
      `INSERT INTO prospects (
        apollo_id, first_name, last_name, email, linkedin_url, designation, company_name, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', $8) RETURNING id`,
      [
        apolloIdA,
        'Suppress',
        'Lead',
        emailA,
        `https://linkedin.com/in/${apolloIdA}`,
        'CTO',
        'Sales Academy',
        JSON.stringify({ unipile_provider_id: providerIdA })
      ]
    );
    const prospectIdA = prospectResultA.rows[0].id;
    console.log(`[test]: Created Prospect A with ID: ${prospectIdA}`);

    // Update with invitation ID simulating staged invitation state
    await db.query(
      'UPDATE prospects SET unipile_invitation_id = $1 WHERE id = $2',
      [inviteIdA, prospectIdA]
    );

    // 2. Fire invitation.accepted Webhook
    console.log('[test]: Simulating "invitation.accepted" webhook...');
    const acceptResA = await fetch(`${baseUrl}/webhooks/unipile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-unipile-signature': 'test-sig'
      },
      body: JSON.stringify({
        event: 'invitation.accepted',
        invitation_id: inviteIdA
      })
    });

    if (!acceptResA.ok) {
      throw new Error(`Invitation accepted webhook failed with status: ${acceptResA.status}`);
    }
    console.log('[test]: Invitation accepted webhook parsed successfully.');

    // Assert Connection status
    const dbCheckA1 = await db.query('SELECT status, linkedin_connected_at FROM prospects WHERE id = $1', [prospectIdA]);
    const leadA1 = dbCheckA1.rows[0];
    if (leadA1.status !== 'LI_CONNECTED' || !leadA1.linkedin_connected_at) {
      throw new Error(`Assert failed: Prospect A status is ${leadA1.status} (expected: LI_CONNECTED) or linkedin_connected_at is null.`);
    }
    console.log('✅ Assert Passed: Prospect A transitioned to LI_CONNECTED and connection timestamp recorded.');

    // 3. Immediately fire chat.message.received Webhook
    console.log('[test]: Simulating inbound LinkedIn reply message webhook...');
    const replyResA = await fetch(`${baseUrl}/webhooks/unipile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-unipile-signature': 'test-sig'
      },
      body: JSON.stringify({
        event: 'chat.message.received',
        data: {
          direction: 'INBOUND',
          sender_id: providerIdA,
          text: 'I am highly interested in custom sales simulations. Let us schedule a call!'
        }
      })
    });

    if (!replyResA.ok) {
      throw new Error(`LinkedIn message webhook failed with status: ${replyResA.status}`);
    }
    console.log('[test]: Message reply webhook parsed successfully.');

    // Assert Reply Status
    const dbCheckA2 = await db.query('SELECT status, linkedin_replied FROM prospects WHERE id = $1', [prospectIdA]);
    const leadA2 = dbCheckA2.rows[0];
    if (leadA2.linkedin_replied !== true || leadA2.status === 'EMAIL_SENT') {
      throw new Error(`Assert failed: Prospect A linkedin_replied is false or status is ${leadA2.status} (expected not EMAIL_SENT).`);
    }
    console.log(`[test]: Inbound reply verified. status: ${leadA2.status}, linkedin_replied: ${leadA2.linkedin_replied}`);
    console.log('✅ Assert Passed: Prospect A replied state registered (linkedin_replied = true).');

    // 4. Wait for queue delay (delay is 3s, waiting 4.5s to be absolutely sure)
    console.log('[test]: Waiting 4.5 seconds for delayed sequence evaluator execution...');
    await delay(4500);

    // Assert Suppression (should NOT be EMAIL_SENT)
    const dbCheckA3 = await db.query('SELECT status, smartlead_id FROM prospects WHERE id = $1', [prospectIdA]);
    const leadA3 = dbCheckA3.rows[0];
    if (leadA3.status === 'EMAIL_SENT' || leadA3.smartlead_id) {
      throw new Error(`Assert failed: Prospect A escalated to email! Status: ${leadA3.status}, smartlead_id: ${leadA3.smartlead_id}`);
    }
    console.log('✅ Assert Passed: Outreach suppression succeeded. Prospect A remained unescalated and no email was sent.');


    // -------------------------------------------------------------
    // TEST PATH B: Escalation (No reply triggers Smartlead email)
    // -------------------------------------------------------------
    console.log('\n--- 📂 Test Path B: Escalation (Connection -> Timeout -> Cold Email Enrollment) ---');

    const apolloIdB = `test_seq_b_${Date.now()}`;
    const emailB = `test_escalate_${Date.now()}@example.com`;
    const inviteIdB = `invite_b_${Date.now()}`;
    const providerIdB = `provider_b_${Date.now()}`;

    // 1. Insert test prospect
    const prospectResultB = await db.query(
      `INSERT INTO prospects (
        apollo_id, first_name, last_name, email, linkedin_url, designation, company_name, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', $8) RETURNING id`,
      [
        apolloIdB,
        'Escalate',
        'Lead',
        emailB,
        `https://linkedin.com/in/${apolloIdB}`,
        'VP Sales',
        'Acme Corp',
        JSON.stringify({ unipile_provider_id: providerIdB })
      ]
    );
    const prospectIdB = prospectResultB.rows[0].id;
    console.log(`[test]: Created Prospect B with ID: ${prospectIdB}`);

    // Update with invitation ID simulating staged invitation state
    await db.query(
      'UPDATE prospects SET unipile_invitation_id = $1 WHERE id = $2',
      [inviteIdB, prospectIdB]
    );

    // 2. Fire invitation.accepted Webhook
    console.log('[test]: Simulating "invitation.accepted" webhook...');
    const acceptResB = await fetch(`${baseUrl}/webhooks/unipile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-unipile-signature': 'test-sig'
      },
      body: JSON.stringify({
        event: 'invitation.accepted',
        invitation_id: inviteIdB
      })
    });

    if (!acceptResB.ok) {
      throw new Error(`Invitation accepted webhook failed with status: ${acceptResB.status}`);
    }
    console.log('[test]: Invitation accepted webhook parsed successfully.');

    // Assert Connection status
    const dbCheckB1 = await db.query('SELECT status FROM prospects WHERE id = $1', [prospectIdB]);
    const leadB1 = dbCheckB1.rows[0];
    if (leadB1.status !== 'LI_CONNECTED') {
      throw new Error(`Assert failed: Prospect B status is ${leadB1.status} (expected: LI_CONNECTED).`);
    }
    console.log('✅ Assert Passed: Prospect B transitioned to LI_CONNECTED.');

    // 3. Wait for queue delay (delay is 3s, waiting 4.5s)
    console.log('[test]: Waiting 4.5 seconds for delayed sequence evaluator execution (no replies)...');
    await delay(4500);

    // Assert Escalation (should now be EMAIL_SENT)
    const dbCheckB2 = await db.query('SELECT status, smartlead_id FROM prospects WHERE id = $1', [prospectIdB]);
    const leadB2 = dbCheckB2.rows[0];
    if (leadB2.status !== 'EMAIL_SENT' || !leadB2.smartlead_id) {
      throw new Error(`Assert failed: Prospect B was not escalated. Status: ${leadB2.status}, smartlead_id: ${leadB2.smartlead_id}`);
    }
    console.log(`✅ Assert Passed: Cold email escalation succeeded. Status updated to EMAIL_SENT. smartlead_id: ${leadB2.smartlead_id}`);

    // -------------------------------------------------------------
    // Clean up test data
    // -------------------------------------------------------------
    console.log('\n[test]: Cleaning test database prospects...');
    await db.query("DELETE FROM prospects WHERE apollo_id LIKE 'test_seq_%'");

    console.log('\n================================================================');
    console.log('🎉 ALL SEQUENCE ENGINE TESTS COMPLETED SUCCESSFULLY! 🎉');
    console.log('================================================================');
    
  } catch (err: any) {
    console.error('\n❌ TEST RUN FAILED:', err.stack || err.message);
    process.exit(1);
  } finally {
    console.log('[test]: Shutting down database connection pool and queue worker connections...');
    await outreachWorker.close();
    await outreachQueue.close();
    await db.close();
    console.log('[test]: Shutdown complete. Exiting test process.');
    process.exit(0);
  }
}

// Start test execution
runTests();
