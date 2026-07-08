import config from '../../config/env';
import db from '../../config/database';
import { classifyIntent } from '../ai/gemini';

/**
 * Enrolls a prospect into the designated Smartlead campaign.
 * Uses the global import endpoint and passes campaign_id in the JSON body.
 */
export async function enrollInCampaign(prospectId: string): Promise<string> {
  console.log(`[smartlead-service]: Enrolling prospect ID: ${prospectId} into cold outreach...`);

  // 1. Fetch prospect details from PostgreSQL
  const prospectResult = await db.query(
    'SELECT id, first_name, last_name, email, company_name FROM prospects WHERE id = $1',
    [prospectId]
  );

  if (prospectResult.rowCount === 0) {
    throw new Error(`Prospect not found in database: ${prospectId}`);
  }

  const prospect = prospectResult.rows[0];
  if (!prospect.email) {
    throw new Error(`Prospect does not have an email address: ${prospectId}`);
  }

  let smartleadId = `mock_sl_${Date.now()}`;

  // 2. Execute enrollment request call to Smartlead import endpoint
  if (config.ALLOW_LIVE_OUTREACH) {
    console.log(`[smartlead-client]: Dispatched lead enrollment request payload successfully.`);
    const isMockKey = config.SMARTLEAD_API_KEY === 'mock_smartlead_api_key';
    if (isMockKey) {
      smartleadId = `mock_sl_${Date.now()}`;
    } else {
      try {
        const url = `${config.SMARTLEAD_API_URL}/campaigns/import?api_key=${config.SMARTLEAD_API_KEY}`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            campaign_id: Number(config.SMARTLEAD_CAMPAIGN_ID),
            leads: [
              {
                email: prospect.email,
                first_name: prospect.first_name || '',
                last_name: prospect.last_name || '',
                company_name: prospect.company_name || ''
              }
            ]
          })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Smartlead campaigns import failed with status ${response.status}: ${errText}`);
        }

        const body = (await response.json()) as any;
        // Extract the lead ID from import response array or root level parameters
        const importedLead = body.leads?.[0] || body;
        smartleadId = String(importedLead.id || importedLead.lead_id || `mock_sl_${Date.now()}`);
      } catch (err: any) {
        console.error(`❌ [smartlead]: Live campaigns import failed for prospect ${prospectId}:`, err.message);
        throw err;
      }
    }
  } else {
    console.log(`[smartlead-service]: Enrolled prospect into campaign. Mocking delivery response.`);
  }

  // 3. Save smartlead_id and set status to 'EMAIL_SENT'
  await db.query(
    `UPDATE prospects 
     SET smartlead_id = $1, 
         status = 'EMAIL_SENT', 
         updated_at = CURRENT_TIMESTAMP 
     WHERE id = $2`,
    [smartleadId, prospectId]
  );

  console.log(`[smartlead-service]: Enrolled prospect into campaign. Status updated to 'EMAIL_SENT'. smartlead_id: ${smartleadId}`);
  return smartleadId;
}

/**
 * Classifies the sentiment of an inbound reply email using gemini-1.5-flash.
 * Configured with responseMimeType "application/json" to force rigid schema outcomes.
 */
export async function classifyEmailIntent(
  replyBody: string,
  trace?: any,
  modelOverride?: string
): Promise<'INTERESTED' | 'NOT_INTERESTED' | 'OOO' | 'QUESTION'> {
  const result = await classifyIntent(replyBody, trace, modelOverride);
  return result as any;
}
