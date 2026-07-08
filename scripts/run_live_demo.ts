import db from '../src/config/database';
import { generateAndStageInvite, queueApprovedInvite } from '../src/services/linkedin/unipile';
import { outreachWorker } from '../src/services/queue/workers';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runLiveDemo() {
  console.log('================================================================');
  console.log('🚀 Starting Live AI SDR Demo Inbound/Outbound Pipeline 🚀');
  console.log('================================================================');

  try {
    // 1. Fetch the latest prospect inserted by create_demo_lead.ts
    console.log('[demo] Fetching the demo prospect from PostgreSQL...');
    const result = await db.query(
      `SELECT id, first_name, last_name, linkedin_url, email, status FROM prospects 
       WHERE apollo_id LIKE 'demo_live_%' 
       ORDER BY created_at DESC LIMIT 1`
    );

    if (result.rowCount === 0) {
      throw new Error("No demo prospect found in the database. Please run 'npx ts-node scripts/create_demo_lead.ts' first!");
    }

    const prospect = result.rows[0];
    console.log(`[demo] Target Prospect: ${prospect.first_name} ${prospect.last_name}`);
    console.log(`[demo] LinkedIn URL: ${prospect.linkedin_url}`);
    console.log(`[demo] Target Email: ${prospect.email}`);
    console.log(`[demo] Current Status: ${prospect.status}`);

    if (prospect.linkedin_url.includes('YOUR_VANITY_URL') || prospect.email.includes('your_target_email')) {
      console.warn('\n⚠️ WARNING: You are running the demo with default placeholder values.');
      console.warn('   Please edit the vanity URL and email in scripts/create_demo_lead.ts first and re-run.');
      process.exit(1);
    }

    // 2. Draft personal copy and resolve the Unipile internal provider ID
    console.log('\n[demo] Step 1: Generating invitation copy via Gemini and resolving profile ID via Unipile...');
    await generateAndStageInvite(prospect.id, 'gemini-flash-latest');

    // Retrieve updated metadata
    const stagedCheck = await db.query('SELECT metadata FROM prospects WHERE id = $1', [prospect.id]);
    const metadata = stagedCheck.rows[0].metadata || {};
    console.log(`[demo] Resolved Unipile Provider ID: ${metadata.unipile_provider_id}`);
    console.log(`[demo] Staged AI Invitation Note: "${metadata.staged_invite}"`);

    // 3. Approve draft in database
    console.log('\n[demo] Step 2: Approving draft note (setting invite_approved = true)...');
    metadata.invite_approved = true;
    await db.query('UPDATE prospects SET metadata = $1 WHERE id = $2', [JSON.stringify(metadata), prospect.id]);

    // 4. Queue the approved invite (triggers native delay jitter in queue)
    console.log('\n[demo] Step 3: Queueing task in BullMQ outreach queue...');
    await queueApprovedInvite(prospect.id);

    // 5. Spawn worker dynamically to process outreach queue
    console.log('\n[demo] Step 4: Monitoring job execution status...');
    
    // Poll the database for up to 15 seconds waiting for the worker to update the status to LI_INVITED
    let lead = { status: 'NEW', unipile_invitation_id: null };
    for (let i = 0; i < 15; i++) {
      await delay(1000);
      const checkResult = await db.query(
        'SELECT status, unipile_invitation_id FROM prospects WHERE id = $1',
        [prospect.id]
      );
      if (checkResult.rows[0]) {
        lead = checkResult.rows[0];
        if (lead.status === 'LI_INVITED') {
          break;
        }
      }
    }

    console.log(`\n=============================================================`);
    console.log(`🎉 Demo Run Executed Successfully!`);
    console.log(`   Final Database Status: ${lead.status}`);
    console.log(`   Unipile Invitation ID: ${lead.unipile_invitation_id}`);
    console.log(`=============================================================`);
    if (lead.status === 'LI_INVITED') {
      console.log(`Go check your target LinkedIn account! You should see the invitation.`);
    } else {
      console.warn(`⚠️ Warning: The worker did not process the invite in time. Please restart 'npm run dev' to load corrected environment variables, then try running this script again.`);
    }

  } catch (err: any) {
    console.error('\n❌ Live Demo Failed:', err.stack || err.message);
  } finally {
    console.log('\n[demo] Shutting down database connections and worker threads...');
    await outreachWorker.close();
    await db.close();
    console.log('[demo] Closed successfully.');
    process.exit(0);
  }
}

runLiveDemo();
