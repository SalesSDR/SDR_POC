import db from '../src/config/database';

async function createDemoLead() {
  // ==========================================
  // CONFIGURATION: Customize your target demo lead details here
  // ==========================================
  const firstName = 'there';
  const lastName = '!';
  
  // Replace this with your own LinkedIn vanity URL (e.g. https://www.linkedin.com/in/akanksha-singh/)
  const linkedinUrl = 'https://www.linkedin.com/in/3194pnkjkr/';
  
  // Replace this with your own target email address
  const email = 'myagenttest30@gmail.com';
  
  const designation = 'Chief Technology Officer';
  const companyName = 'Lions Sales Academy';
  const geography = 'United States';

  console.log(`[demo-setup] Connecting to PostgreSQL database...`);
  console.log(`[demo-setup] Attempting to insert lead: ${firstName} ${lastName} (${email})...`);

  try {
    // Clear any conflicting prospects to prevent unique constraint violations
    await db.query('DELETE FROM prospects WHERE email = $1 OR linkedin_url = $2', [email, linkedinUrl]);
    const result = await db.query(
      `INSERT INTO prospects (
        apollo_id, 
        first_name, 
        last_name, 
        linkedin_url, 
        email, 
        designation, 
        geography, 
        company_name, 
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NEW') RETURNING id`,
      [
        `demo_live_${Date.now()}`,
        firstName,
        lastName,
        linkedinUrl,
        email,
        designation,
        geography,
        companyName
      ]
    );

    const newProspectId = result.rows[0].id;
    console.log(`\n=============================================================`);
    console.log(`✅ Success! Demo lead inserted into prospects table.`);
    console.log(`   Prospect ID: ${newProspectId}`);
    console.log(`=============================================================`);
    console.log(`Next Steps:`);
    console.log(`1. Run your dev server: 'npm run dev' or 'ts-node src/app.ts'`);
    console.log(`2. This will auto-draft a personalized note using Gemini.`);
    console.log(`3. Update the prospect's metadata in the database: set invite_approved = true.`);
    console.log(`4. The BullMQ worker will send the real LinkedIn connection request!`);

  } catch (err: any) {
    console.error(`\n❌ Error: Failed to insert prospect:`, err.stack || err.message);
  } finally {
    // Close the database connection pool cleanly
    await db.close();
    console.log(`[demo-setup] Database connection closed.`);
  }
}

createDemoLead();
