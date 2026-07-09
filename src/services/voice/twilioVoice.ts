import twilio from 'twilio';
import config from '../../config/env';

/**
 * Initiates an outbound voice call to a prospect's phone number using Twilio.
 * Verifies Twilio credentials at runtime to avoid application crashes.
 * 
 * @param prospectId Unique UUID identifier for the prospect
 * @param toNumber Destination prospect phone number
 */
export async function initiateOutboundCall(prospectId: string, toNumber: string): Promise<any> {
  console.log(`[twilio-voice]: Verifying outbound call configurations for prospect ${prospectId}`);

  const sid = config.TWILIO_ACCOUNT_SID;
  const token = config.TWILIO_AUTH_TOKEN;
  const fromNum = config.TWILIO_FROM_NUMBER;
  const host = config.SERVER_PUBLIC_HOST;

  if (!sid || !token || !fromNum) {
    const errorMsg = `Twilio configuration is incomplete. Missing: ${[
      !sid && 'TWILIO_ACCOUNT_SID',
      !token && 'TWILIO_AUTH_TOKEN',
      !fromNum && 'TWILIO_FROM_NUMBER'
    ].filter(Boolean).join(', ')}`;
    console.error(`❌ [twilio-voice]: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  if (!host) {
    const errorMsg = 'SERVER_PUBLIC_HOST is missing in environment variables.';
    console.error(`❌ [twilio-voice]: ${errorMsg}`);
    throw new Error(errorMsg);
  }

  console.log(`[twilio-voice]: Dialing prospect phone number: ${toNumber} from ${fromNum}`);
  
  try {
    const client = twilio(sid, token);
    const callbackUrl = `https://${host}/webhooks/twilio/twiml/${prospectId}`;
    
    console.log(`[twilio-voice]: Twilio call callback url configured as: ${callbackUrl}`);

    const call = await client.calls.create({
      url: callbackUrl,
      to: toNumber,
      from: fromNum,
      method: 'POST',
    });

    console.log(`✅ [twilio-voice]: Outbound call successfully initiated. Twilio Call SID: ${call.sid}`);
    return call;
  } catch (err: any) {
    console.error(`❌ [twilio-voice]: Failed to initiate Twilio call:`, err.message || err);
    throw err;
  }
}
