import WebSocket from 'ws';
import { WaveFile } from 'wavefile';
import config from '../../config/env';
import db from '../../config/database';
import { langfuse } from '../ai/observability';

/**
 * Handles real-time full-duplex WebSocket stream between Twilio and Gemini Live API.
 * Performs on-the-fly audio transcoding and logs the final conversation history.
 * 
 * @param twilioSocket Incoming WebSocket connection from Twilio
 * @param prospectId Unique identifier for the prospect
 */
export function handleVoiceStream(twilioSocket: WebSocket, prospectId: string) {
  console.log(`[stream-bridge]: Initializing voice bridge for prospect ${prospectId}`);

  let streamSid = '';
  let transcriptText = '';
  let isCleanedUp = false;
  let isTwilioReady = false;
  let isGeminiReady = false;
  let hasSentGreeting = false;
  let lastSpeaker: 'user' | 'agent' | null = null;

  const checkAndSendGreeting = () => {
    if (isTwilioReady && isGeminiReady && !hasSentGreeting) {
      hasSentGreeting = true;
      const initialGreeting = {
        clientContent: {
          turns: [
            {
              role: 'user',
              parts: [
                {
                  text: 'Please initiate the call by saying: "Hello! This is Robert calling from Lion Sales Academy. How are you doing today?"'
                }
              ]
            }
          ],
          turnComplete: true
        }
      };
      if (geminiSocket.readyState === WebSocket.OPEN) {
        geminiSocket.send(JSON.stringify(initialGreeting));
        console.log('[stream-bridge]: Sent initial greeting prompt to Gemini to start conversation (both channels ready).');
      }
    }
  };

  // 1. Initialize Langfuse trace context for call tracking
  const trace = langfuse.trace({
    name: 'voice-outreach-call',
    userId: prospectId,
    metadata: {
      channel: 'VOICE',
      environment: config.NODE_ENV,
      timestamp: new Date().toISOString(),
    },
  });

  // 2. Establish connection to Google Gemini Multimodal Live API WSS endpoint
  const geminiUrl = `${config.GEMINI_LIVE_API_URL}?key=${config.GEMINI_API_KEY}`;
  console.log(`[stream-bridge]: Connecting to Gemini Live API: ${config.GEMINI_LIVE_API_URL}`);
  const geminiSocket = new WebSocket(geminiUrl);

  // Define cleanup boundary to close connections safely and commit logs
  const cleanup = async () => {
    if (isCleanedUp) return;
    isCleanedUp = true;

    console.log(`[stream-bridge]: Connection closed. Cleaning up sockets for prospect ${prospectId}...`);

    try {
      if (twilioSocket.readyState === WebSocket.OPEN || twilioSocket.readyState === WebSocket.CONNECTING) {
        twilioSocket.close();
      }
      if (geminiSocket.readyState === WebSocket.OPEN || geminiSocket.readyState === WebSocket.CONNECTING) {
        geminiSocket.close();
      }
    } catch (err: any) {
      console.warn('[stream-bridge]: Error closing socket streams during cleanup:', err.message);
    }

    try {
      const finalTranscript = transcriptText.trim();
      if (finalTranscript) {
        console.log(`[stream-bridge]: Logging conversation history to PostgreSQL interaction logs...`);
        await db.query(
          `INSERT INTO interaction_logs (prospect_id, channel, direction, message_content, gemini_intent_tag, langfuse_trace_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [prospectId, 'VOICE', 'OUTBOUND', finalTranscript, 'VOICE_CALL', trace.id]
        );

        trace.update({
          tags: ['success'],
          output: finalTranscript,
        });
      } else {
        console.log('[stream-bridge]: No voice transcripts collected during the session.');
        trace.update({
          tags: ['no_conversation'],
          output: 'Session closed without active dialogue transcription.',
        });
      }

      await langfuse.flushAsync();
      console.log('[stream-bridge]: Observability telemetry metrics successfully flushed.');
    } catch (dbErr: any) {
      console.error('[stream-bridge]: Failed to write interaction logs or flush traces:', dbErr.message || dbErr);
    }
  };

  // 3. Setup Gemini handshake on open event
  geminiSocket.on('open', () => {
    console.log('[stream-bridge]: Handshake complete with Gemini Multimodal Live API.');

    // BidiGenerateContentSetup JSON payload initialization
    const setupFrame = {
      setup: {
        model: 'models/gemini-2.5-flash-native-audio-latest',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Puck' // Clear, crisp professional persona tone (Fenrir or Aoede are also valid)
              }
            }
          }
        },
        systemInstruction: {
          parts: [
            {
              text: `You are Robert, an elite, highly professional Sales Automation Architect at Lion Sales Academy.

Lion Sales Academy sells custom, enterprise-grade Agentic AI sales implementation services, custom multi-agent outbound automation architectures, legacy CRM integrations, and premium sales automation enablement frameworks.

Your Persona: Confident, helpful, concise, and focused on operational metrics. Never be pushy, and never use generic sales catchphrases. Speak like a real human engineer over a phone line.

Your Mandate: Keep your answers extremely brief (1 to 2 sentences maximum per turn) to avoid overwhelming the prospect. Address high-level decision-makers (Chief Sales Officers, VP of Sales) across the USA, UAE, and India.

Your Objective: Acknowledge their outbound history, handle classic administrative objections (such as security governance or CRM breaking concerns) calmly, and steer the discussion toward scheduling an engineering blueprint review session.`
            }
          ]
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };

    try {
      geminiSocket.send(JSON.stringify(setupFrame));
      console.log('[stream-bridge]: Dispatched setup configuration parameters to Gemini Live API.');
      isGeminiReady = true;
      checkAndSendGreeting();
    } catch (err: any) {
      console.error('[stream-bridge]: Failed to send setup configuration packet to Gemini:', err.message);
      cleanup();
    }
  });

  // 4. Inbound Audio Transcoding Loop: Twilio -> Gemini
  twilioSocket.on('message', (message: string) => {
    try {
      const packet = JSON.parse(message);

      if (packet.event === 'start') {
        streamSid = packet.start.streamSid;
        console.log(`[stream-bridge]: Twilio call session started. Stream SID captured: ${streamSid}`);
        isTwilioReady = true;
        checkAndSendGreeting();
      } else if (packet.event === 'media') {
        if (!streamSid && packet.streamSid) {
          streamSid = packet.streamSid;
        }

        const base64Payload = packet.media.payload;
        if (!base64Payload) return;

        // Convert base64 G.711 mu-law (8kHz) to binary buffer
        const rawBuffer = Buffer.from(base64Payload, 'base64');

        // Transcode to 16-bit linear PCM upsampled to 16kHz
        const wav = new WaveFile();
        wav.fromScratch(1, 8000, '8m', rawBuffer);
        wav.fromMuLaw();
        wav.toSampleRate(16000);

        // Extract raw Int16 samples (mono channel)
        const samples = wav.getSamples(false, Int16Array) as any;
        const channelSamples = Array.isArray(samples) ? samples[0] : samples;
        const pcm16Buffer = Buffer.from(channelSamples.buffer, channelSamples.byteOffset, channelSamples.byteLength);
        const pcm16Base64 = pcm16Buffer.toString('base64');

        // Package and forward to Gemini
        if (geminiSocket.readyState === WebSocket.OPEN) {
          const rawInputFrame = {
            realtimeInput: {
              mediaChunks: [
                {
                  mimeType: 'audio/pcm;rate=16000',
                  data: pcm16Base64
                }
              ]
            }
          };
          geminiSocket.send(JSON.stringify(rawInputFrame));
        }
      } else if (packet.event === 'stop') {
        console.log('[stream-bridge]: Twilio stop signal received.');
        cleanup();
      }
    } catch (err: any) {
      console.error('[stream-bridge]: Exception in Twilio socket message handler:', err.message || err);
      cleanup();
    }
  });

  // 5. Outbound Audio Transcoding Loop: Gemini -> Twilio
  geminiSocket.on('message', (message: string) => {
    try {
      const packet = JSON.parse(message);

      // Handle model turn interruption (Barge-In)
      if (packet.serverContent?.interrupted === true) {
        console.log('[stream-bridge]: Gemini model output was interrupted. Clearing Twilio buffer.');
        if (twilioSocket.readyState === WebSocket.OPEN && streamSid) {
          const clearFrame = {
            event: 'clear',
            streamSid: streamSid
          };
          twilioSocket.send(JSON.stringify(clearFrame));
        }
      }

      // Handle real-time audio output streaming
      if (packet.serverContent?.modelTurn?.parts) {
        for (const part of packet.serverContent.modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
            const rawPcm24Base64 = part.inlineData.data;
            const pcm24Buffer = Buffer.from(rawPcm24Base64, 'base64');

            // Convert to Int16 samples for wavefile ingestion
            const int16Samples = new Int16Array(
              pcm24Buffer.buffer,
              pcm24Buffer.byteOffset,
              pcm24Buffer.length / 2
            );

            // Transcode 24kHz PCM 16-bit down to G.711 mu-law 8kHz
            const wav = new WaveFile();
            wav.fromScratch(1, 24000, '16', int16Samples);
            wav.toSampleRate(8000);
            wav.toMuLaw();

            // Extract mu-law bytes (8-bit)
            const samples = wav.getSamples(false, Uint8Array) as any;
            const channelSamples = Array.isArray(samples) ? samples[0] : samples;
            const muLawBuffer = Buffer.from(channelSamples.buffer, channelSamples.byteOffset, channelSamples.byteLength);
            const muLawBase64 = muLawBuffer.toString('base64');

            // Send payload back down to Twilio
            if (twilioSocket.readyState === WebSocket.OPEN && streamSid) {
              const twilioFrame = {
                event: 'media',
                streamSid: streamSid,
                media: {
                  payload: muLawBase64
                }
              };
              twilioSocket.send(JSON.stringify(twilioFrame));
            }
          }
        }
      }

      // Collect real-time transcripts for telemetry
      if (packet.serverContent?.inputTranscription?.text) {
        const text = packet.serverContent.inputTranscription.text;
        if (lastSpeaker !== 'user') {
          transcriptText += (transcriptText ? '\n' : '') + `User: ${text}`;
          lastSpeaker = 'user';
        } else {
          transcriptText += `${text}`;
        }
        console.log(`[stream-bridge] User Transcript chunk: "${text}"`);
      }
      if (packet.serverContent?.outputTranscription?.text) {
        const text = packet.serverContent.outputTranscription.text;
        if (lastSpeaker !== 'agent') {
          transcriptText += (transcriptText ? '\n' : '') + `Agent (Robert): ${text}`;
          lastSpeaker = 'agent';
        } else {
          transcriptText += `${text}`;
        }
        console.log(`[stream-bridge] Agent Transcript chunk: "${text}"`);
      }
    } catch (err: any) {
      console.error('[stream-bridge]: Exception in Gemini socket message handler:', err.message || err);
      cleanup();
    }
  });

  // Handle socket close and errors gracefully
  twilioSocket.on('close', (code, reason) => {
    console.log(`[stream-bridge]: Twilio socket session closed. Code: ${code}, Reason: ${reason ? reason.toString() : 'None'}`);
    cleanup();
  });

  geminiSocket.on('close', (code, reason) => {
    console.log(`[stream-bridge]: Gemini socket connection closed. Code: ${code}, Reason: ${reason ? reason.toString() : 'None'}`);
    cleanup();
  });

  geminiSocket.on('unexpected-response', (_req, res) => {
    console.error(`❌ [stream-bridge]: Gemini handshake rejected with status: ${res.statusCode} - ${res.statusMessage}`);
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      console.error(`❌ [stream-bridge]: Gemini error response body: ${body}`);
      cleanup();
    });
  });

  twilioSocket.on('error', (err) => {
    console.error('[stream-bridge]: Twilio socket stream error:', err.message || err);
    cleanup();
  });

  geminiSocket.on('error', (err) => {
    console.error('[stream-bridge]: Gemini socket stream error:', err.message || err);
    cleanup();
  });
}
