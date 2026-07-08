import config from '../src/config/env';

async function generateLink() {
  const url = `${config.UNIPILE_API_URL}/api/v1/hosted/accounts/link`;
  
  // Set expiration to 2 hours from now
  const expiryDate = new Date();
  expiryDate.setHours(expiryDate.getHours() + 2);

  console.log(`[unipile] Querying Hosted Auth Wizard Link creator...`);
  console.log(`[unipile] API URL: ${config.UNIPILE_API_URL}`);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.UNIPILE_ACCESS_TOKEN
      },
      body: JSON.stringify({
        type: 'create',
        providers: ['LINKEDIN'],
        api_url: config.UNIPILE_API_URL,
        expiresOn: expiryDate.toISOString()
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Unipile returned status ${response.status}: ${errText}`);
    }

    const body = (await response.json()) as any;
    
    console.log(`\n================================================================================`);
    console.log(`✅ Success! Copy and paste this URL into your browser to log in:`);
    console.log(`   ${body.url}`);
    console.log(`================================================================================`);
    console.log(`Instructions:`);
    console.log(`1. Copy the URL above and paste it into your browser.`);
    console.log(`2. Log in using your LinkedIn credentials.`);
    console.log(`3. Once connected, your account will have both MESSAGING and NETWORKING scopes.`);
    console.log(`4. Check the account list or your terminal output for your new Account ID.`);

  } catch (err: any) {
    console.error(`\n❌ Error: Failed to generate connection link:`, err.message);
  }
}

generateLink();
