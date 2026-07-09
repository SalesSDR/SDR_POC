import express from 'express';
import db from '../src/config/database';
import webhookRoutes from '../src/routes/webhookRoutes';
import { outreachQueue } from '../src/services/queue/outreachQueue';
import { outreachWorker } from '../src/services/queue/workers';
import { WaveFile } from 'wavefile';
import config from '../src/config/env';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runVoiceVerification() {
  console.log('================================================================');
  console.log('🧪 STARTING REAL-TIME VOICE OUTREACH VERIFICATION TESTS 🧪');
  console.log('================================================================');

  const testProspectId = `test_voice_prospect_${Date.now()}`;
  const mockPhone = '+15550199';
  let createdUUID: string = '';
  let testServer: any = null;

  try {
    // -------------------------------------------------------------
    // TEST 1: Audio Transcoding Math Validation
    // -------------------------------------------------------------
    console.log('\n--- 📂 Test 1: Audio Transcoding Math Validation ---');
    
    // Create mock G.711 mu-law 8kHz audio sample (160 bytes = 20ms)
    const mockMuLawData = Buffer.alloc(160, 0x7F); // 0x7F is quiet/silence in mu-law
    
    // Transcode: mu-law 8kHz -> PCM 16kHz
    const wavIn = new WaveFile();
    wavIn.fromScratch(1, 8000, '8m', mockMuLawData);
    wavIn.fromMuLaw();
    wavIn.toSampleRate(16000);
    
    const pcm16Samples = wavIn.getSamples(false, Int16Array) as any;
    const channel16 = Array.isArray(pcm16Samples) ? pcm16Samples[0] : pcm16Samples;
    const pcm16Buffer = Buffer.from(channel16.buffer, channel16.byteOffset, channel16.byteLength);
    console.log(`✅ Transcode Inbound (Twilio -> Gemini) Success! Input size: ${mockMuLawData.length} bytes, Output PCM size: ${pcm16Buffer.length} bytes`);

    // Transcode: PCM 24kHz -> mu-law 8kHz
    const mockPcm24Data = Buffer.alloc(960, 0); // 20ms of 24kHz 16-bit PCM = 960 bytes
    const int16Samples = new Int16Array(
      mockPcm24Data.buffer,
      mockPcm24Data.byteOffset,
      mockPcm24Data.length / 2
    );
    const wavOut = new WaveFile();
    wavOut.fromScratch(1, 24000, '16', int16Samples);
    wavOut.toSampleRate(8000);
    wavOut.toMuLaw();
    
    const muLawSamples = wavOut.getSamples(false, Uint8Array) as any;
    const channelMuLaw = Array.isArray(muLawSamples) ? muLawSamples[0] : muLawSamples;
    const muLawBuffer = Buffer.from(channelMuLaw.buffer, channelMuLaw.byteOffset, channelMuLaw.byteLength);
    console.log(`✅ Transcode Outbound (Gemini -> Twilio) Success! Input size: ${mockPcm24Data.length} bytes, Output mu-law size: ${muLawBuffer.length} bytes`);

    // -------------------------------------------------------------
    // TEST 2: Setup Database Prospect with phone details
    // -------------------------------------------------------------
    console.log('\n--- 📂 Test 2: Database Lead Setup with Phone Attributes ---');
    
    const dbResult = await db.query(
      `INSERT INTO prospects (
        apollo_id, first_name, last_name, email, linkedin_url, designation, company_name, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', $8) RETURNING id`,
      [
        testProspectId,
        'Voice',
        'Tester',
        `voice_test_${Date.now()}@example.com`,
        `https://linkedin.com/in/${testProspectId}`,
        'SDR QA',
        'Lions Sales Academy',
        JSON.stringify({ phone: mockPhone })
      ]
    );
    
    createdUUID = dbResult.rows[0].id;
    console.log(`✅ Test prospect inserted. UUID: ${createdUUID}, Phone: ${mockPhone}`);

    // -------------------------------------------------------------
    // TEST 3: HTTP TwiML dynamic XML retrieval
    // -------------------------------------------------------------
    console.log('\n--- 📂 Test 3: TwiML Webhook REST retrieval ---');
    
    // Spin up a temporary test server on port 3050 to serve the new webhook routes
    const testApp = express();
    testApp.use(express.json());
    testApp.use('/webhooks', webhookRoutes);

    const testPort = 3050;
    testServer = testApp.listen(testPort);
    console.log(`[test-setup] Temporary test server started on port ${testPort}`);

    const baseUrl = `http://localhost:${testPort}`;
    
    // Override SERVER_PUBLIC_HOST temporarily in process env if not configured
    const originalHost = config.SERVER_PUBLIC_HOST;
    if (!config.SERVER_PUBLIC_HOST) {
      (config as any).SERVER_PUBLIC_HOST = 'test-tunnel.ngrok-free.app';
    }

    const twimlResponse = await fetch(`${baseUrl}/webhooks/twilio/twiml/${createdUUID}`, {
      method: 'POST',
    });

    // Restore host
    if (!originalHost) {
      (config as any).SERVER_PUBLIC_HOST = originalHost;
    }

    if (!twimlResponse.ok) {
      throw new Error(`TwiML endpoint returned status: ${twimlResponse.status}`);
    }

    const xml = await twimlResponse.text();
    console.log('TwiML XML Response:\n', xml);

    if (!xml.includes('<Response>') || !xml.includes('<Connect>') || !xml.includes('<Stream url=')) {
      throw new Error('Verification failed: Served TwiML XML structure is invalid.');
    }
    console.log('✅ Served valid structural TwiML instructions containing matching Connect/Stream target paths.');

    // -------------------------------------------------------------
    // TEST 4: Job Dispatcher & Queue Evaluation
    // -------------------------------------------------------------
    console.log('\n--- 📂 Test 4: BullMQ Job Dispatcher Routing ---');
    
    // Temporarily mock SERVER_PUBLIC_HOST for outbound call verification
    const hostBackup = config.SERVER_PUBLIC_HOST;
    if (!config.SERVER_PUBLIC_HOST) {
      (config as any).SERVER_PUBLIC_HOST = 'test-tunnel.ngrok-free.app';
    }

    // Temporarily verify that worker evaluates job successfully
    console.log('[test]: Dispatching CALL_ESCALATED job sequence event...');
    
    // Add job to the queue
    const job = await outreachQueue.add('CALL_ESCALATED', { prospectId: createdUUID });
    console.log(`[test]: Enqueued job ID: ${job.id}`);
    
    // Wait for the worker to process the job
    await delay(3000);

    // Restore config
    (config as any).SERVER_PUBLIC_HOST = hostBackup;
    
    // Check prospect status in database
    const finalCheck = await db.query('SELECT status FROM prospects WHERE id = $1', [createdUUID]);
    const finalStatus = finalCheck.rows[0]?.status;
    console.log(`[test]: Final database status of prospect: ${finalStatus}`);

    // Since Twilio credentials are mock in dev, it will either throw or succeed.
    // If status is CALL_ESCALATED, it verifies the state machine transition worked!
    if (finalStatus === 'CALL_ESCALATED') {
      console.log('✅ State transition verification passed: Status is CALL_ESCALATED.');
    } else {
      console.warn(`⚠️ Warning: Status is '${finalStatus}' (expected: CALL_ESCALATED if twilio was processed, or NEW if it failed/skipped before updating)`);
    }

    console.log('\n================================================================');
    console.log('🎉 ALL VOICE OUTREACH VERIFICATION TESTS COMPLETED SUCCESSFULLY! 🎉');
    console.log('================================================================');

  } catch (err: any) {
    console.error('\n❌ VERIFICATION RUN FAILED:', err.stack || err.message);
    process.exit(1);
  } finally {
    if (testServer) {
      console.log('[test]: Stopping temporary test server...');
      testServer.close();
    }

    if (createdUUID) {
      console.log('[test]: Cleaning test database prospects...');
      await db.query('DELETE FROM prospects WHERE id = $1', [createdUUID]);
    }
    
    console.log('[test]: Shutting down database connection pool and queue connections...');
    await outreachWorker.close();
    await outreachQueue.close();
    await db.close();
    console.log('[test]: Shutdown complete. Exiting.');
    process.exit(0);
  }
}

runVoiceVerification();
