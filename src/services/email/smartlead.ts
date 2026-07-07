import config from '../../config/env';
import db from '../../config/database';
import { ai } from '../ai/gemini';

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
  if (config.SMARTLEAD_API_KEY !== 'mock_smartlead_api_key' && config.APP_ENV === 'production') {
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
  const modelName =
    modelOverride ||
    (config.APP_ENV === 'production' ? 'gemini-1.5-flash' : 'gemini-flash-latest');
  const start = Date.now();
  let generation: any = null;

  if (trace) {
    generation = trace.generation({
      name: 'classify-email-intent',
      model: modelName,
      modelParameters: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      },
      input: replyBody
    });
  }

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: replyBody,
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            intent: {
              type: 'STRING',
              enum: ['INTERESTED', 'NOT_INTERESTED', 'OOO', 'QUESTION']
            }
          },
          required: ['intent']
        },
        systemInstruction: 'Classify the incoming cold email reply into one of these intent tags: INTERESTED, NOT_INTERESTED, OOO, QUESTION. Return a JSON object containing the "intent" field matching one of the uppercase tags.'
      }
    });

    const responseText = (response.text || '{}').trim();
    const parsed = JSON.parse(responseText);
    const rawIntent = (parsed.intent || '').toUpperCase();

    const allowedIntents = ['INTERESTED', 'NOT_INTERESTED', 'OOO', 'QUESTION'];
    const finalIntent = allowedIntents.includes(rawIntent) ? rawIntent : 'QUESTION';

    if (generation) {
      const usage = response.usageMetadata;
      generation.update({
        output: finalIntent,
        completionStartTime: new Date(start),
        endTime: new Date(),
        usage: usage ? {
          promptTokens: usage.promptTokenCount,
          completionTokens: usage.candidatesTokenCount,
          totalTokens: usage.totalTokenCount
        } : undefined
      });
    }

    return finalIntent as any;
  } catch (err: any) {
    if (config.APP_ENV !== 'production' && (err.message.includes('429') || err.message.includes('quota') || err.message.includes('limit') || err.message.includes('Quota') || err.message.includes('Limit'))) {
      console.warn(`⚠️ [smartlead]: Gemini API quota exceeded in development. Falling back to mock intent tag 'INTERESTED' for testing...`);
      return 'INTERESTED';
    }

    if (generation) {
      generation.update({
        output: err.message,
        endTime: new Date(),
        statusMessage: err.message
      });
    }
    console.error('[smartlead]: classifyEmailIntent failed:', err.message);
    throw err;
  }
}
