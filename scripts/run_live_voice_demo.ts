import db from '../src/config/database';
import { outreachQueue } from '../src/services/queue/outreachQueue';
import { outreachWorker } from '../src/services/queue/workers';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runLiveVoiceDemo() {
  const toNumber = process.argv[2];
  
  if (!toNumber) {
    console.error('\n❌ ERROR: Phone number is required.');
    console.log('Usage: npx ts-node scripts/run_live_voice_demo.ts <your_phone_number>');
    console.log('Example: npx ts-node scripts/run_live_voice_demo.ts +15551234567\n');
    process.exit(1);
  }

  console.log('================================================================');
  console.log(`📞 Starting Live Voice Outreach Demo targeting: ${toNumber} 📞`);
  console.log('================================================================');

  try {
    // 1. Fetch or create a demo prospect
    console.log('[demo] Resolving demo prospect from PostgreSQL...');
    let result = await db.query(
      `SELECT id, first_name, last_name, metadata FROM prospects 
       ORDER BY created_at DESC LIMIT 1`
    );

    let prospectId: string;
    let metadata: any = {};

    if (result.rowCount === 0) {
      console.log('[demo] No prospects found. Inserting a mock voice prospect...');
      const insertResult = await db.query(
        `INSERT INTO prospects (
          apollo_id, first_name, last_name, email, linkedin_url, designation, company_name, status, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', $8) RETURNING id`,
        [
          `demo_voice_${Date.now()}`,
          'Voice',
          'Demo',
          `voice_demo_${Date.now()}@example.com`,
          `https://linkedin.com/in/demo_voice_${Date.now()}`,
          'VP Sales',
          'Lions Sales Academy',
          JSON.stringify({ phone: toNumber })
        ]
      );
      prospectId = insertResult.rows[0].id;
    } else {
      const prospect = result.rows[0];
      prospectId = prospect.id;
      metadata = prospect.metadata || {};
      metadata.phone = toNumber;
      
      // Update phone in metadata
      await db.query(
        'UPDATE prospects SET metadata = $1 WHERE id = $2',
        [JSON.stringify(metadata), prospectId]
      );
      console.log(`[demo] Updated existing prospect ${prospectId} metadata with phone number.`);
    }

    // 2. Queue the CALL_ESCALATED outreach task
    console.log('\n[demo] Step 1: Queueing CALL_ESCALATED job in BullMQ outreach-tasks queue...');
    const job = await outreachQueue.add('CALL_ESCALATED', { prospectId });
    console.log(`[demo] Enqueued Job ID: ${job.id}`);

    // 3. Monitor state transition
    console.log('\n[demo] Step 2: Monitoring job processing state...');
    console.log('[demo] Waiting 5 seconds for the background worker to execute...');
    await delay(5000);

    const checkResult = await db.query(
      'SELECT status FROM prospects WHERE id = $1',
      [prospectId]
    );
    const finalStatus = checkResult.rows[0]?.status;

    console.log(`\n=============================================================`);
    console.log(`🎉 Live Voice Demo Initiated Successfully!`);
    console.log(`   Final Prospect Status: ${finalStatus}`);
    console.log(`=============================================================`);
    
    if (finalStatus === 'CALL_ESCALATED') {
      console.log(`✅ Outbound call sequence has been triggered successfully!`);
      console.log(`Check your phone - Twilio should be calling you shortly.`);
    } else {
      console.warn(`⚠️ Warning: Prospect status is '${finalStatus}' (expected: CALL_ESCALATED).`);
      console.warn(`Ensure your dev server 'npm run dev' is running, and has been restarted to load the new code.`);
    }

  } catch (err: any) {
    console.error('\n❌ Live Voice Demo Trigger Failed:', err.stack || err.message);
  } finally {
    console.log('\n[demo] Shutting down connection layers...');
    await outreachWorker.close();
    await outreachQueue.close();
    await db.close();
    console.log('[demo] Closed successfully.');
    process.exit(0);
  }
}

runLiveVoiceDemo();
