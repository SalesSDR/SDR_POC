import config from '../src/config/env';

async function triggerWebhook() {
  const url = `http://localhost:${config.PORT}/webhooks/unipile`;
  console.log(`[test-helper] Sending mock invitation.accepted webhook to: ${url}`);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-unipile-signature': 'test-sig'
      },
      body: JSON.stringify({
        event: 'invitation.accepted',
        invitation_id: 'already_invited_state_sync'
      })
    });

    if (response.ok) {
      console.log('=============================================================');
      console.log('✅ Success! Webhook accepted by server.');
      console.log('   Go look at your running "npm run dev" terminal window!');
      console.log('   You should see the 5-minute delayed job enqueued.');
      console.log('=============================================================');
    } else {
      const errText = await response.text();
      console.error(`❌ Failed: Server returned status ${response.status}: ${errText}`);
    }
  } catch (err: any) {
    console.error('❌ Error sending request:', err.message);
  }
}

triggerWebhook();
