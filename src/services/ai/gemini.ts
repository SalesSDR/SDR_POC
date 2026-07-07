import { GoogleGenAI } from '@google/genai';
import config from '../../config/env';

// Initialize the official Google Gen AI SDK client
export const ai = new GoogleGenAI({
  apiKey: config.GEMINI_API_KEY,
});

/**
 * Classifies the intent of a prospect message using gemini-1.5-flash.
 * High-throughput classification with low latency.
 * 
 * @param text The input message text to classify.
 * @param contextTrace The parent Langfuse trace context to record this generation.
 */
export async function classifyIntent(text: string, contextTrace: any, modelOverride?: string): Promise<string> {
  const modelName = modelOverride || (config.APP_ENV === 'production' ? 'gemini-1.5-flash' : 'gemini-flash-latest');
  const start = Date.now();

  // Create a sub-generation in Langfuse
  const generation = contextTrace.generation({
    name: 'classify-intent',
    model: modelName,
    modelParameters: {
      temperature: 0.1,
      maxOutputTokens: 100,
    },
    input: text,
  });

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: text,
      config: {
        temperature: 0.1,
        maxOutputTokens: 100,
        systemInstruction: 'Classify the incoming sales lead query into one of these intent tags: QUESTION, OBJECTION, INTERESTED, NOT_INTERESTED, DNC. Respond with ONLY the tag name in uppercase.',
      },
    });

    const outputText = (response.text || '').trim();

    // Capture token usage metrics from Gemini's usageMetadata response properties
    const usage = response.usageMetadata;
    
    generation.update({
      output: outputText,
      completionStartTime: new Date(start),
      endTime: new Date(),
      usage: usage ? {
        promptTokens: usage.promptTokenCount,
        completionTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
      } : undefined,
    });

    return outputText;
  } catch (err: any) {
    if (config.APP_ENV !== 'production' && (err.message.includes('429') || err.message.includes('quota') || err.message.includes('limit') || err.message.includes('Quota') || err.message.includes('Limit'))) {
      console.warn(`⚠️ [gemini]: Gemini API quota exceeded in development. Falling back to mock intent tag 'QUESTION' for testing...`);
      return 'QUESTION';
    }

    generation.update({
      output: err.message,
      endTime: new Date(),
      statusMessage: err.message,
    });
    console.error('[gemini]: classifyIntent failed:', err.message);
    throw err;
  }
}

/**
 * Generates structured reasoning/outreach recommendations using gemini-1.5-pro.
 * Optimizes for complex logic pipelines.
 * 
 * @param prompt The instructions and user context.
 * @param contextTrace The parent Langfuse trace context to record this generation.
 */
export async function generateReasoning(prompt: string, contextTrace: any, modelOverride?: string): Promise<string> {
  const modelName = modelOverride || 'gemini-1.5-pro';
  const start = Date.now();

  // Create a sub-generation in Langfuse
  const generation = contextTrace.generation({
    name: 'generate-reasoning',
    model: modelName,
    modelParameters: {
      temperature: 0.7,
      maxOutputTokens: 1000,
    },
    input: prompt,
  });

  try {
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        temperature: 0.7,
        maxOutputTokens: 1000,
      },
    });

    const outputText = response.text || '';
    const usage = response.usageMetadata;

    generation.update({
      output: outputText,
      completionStartTime: new Date(start),
      endTime: new Date(),
      usage: usage ? {
        promptTokens: usage.promptTokenCount,
        completionTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
      } : undefined,
    });

    return outputText;
  } catch (err: any) {
    if (config.APP_ENV !== 'production' && (err.message.includes('429') || err.message.includes('quota') || err.message.includes('limit') || err.message.includes('Quota') || err.message.includes('Limit'))) {
      console.warn(`⚠️ [gemini]: Gemini API quota exceeded in development. Falling back to mock reasoning response for testing...`);
      return "Hi, thanks for reaching out. Yes, our Agentic AI integration supports SOC2 isolation and dynamic guardrails to ensure compliance. Let's schedule a brief call next week to discuss your requirements.";
    }

    generation.update({
      output: err.message,
      endTime: new Date(),
      statusMessage: err.message,
    });
    console.error('[gemini]: generateReasoning failed:', err.message);
    throw err;
  }
}
export default ai;
