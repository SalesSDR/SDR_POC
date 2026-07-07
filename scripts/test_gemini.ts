import { ai } from '../src/services/ai/gemini';

async function test() {
  console.log('Starting Gemini Schema test...');
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: 'I am currently out of the office on annual leave with limited access to email until July 15th.',
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
        systemInstruction: 'Classify the incoming email reply into one of: INTERESTED, NOT_INTERESTED, OOO, QUESTION. Return a JSON object with "intent".'
      }
    });
    console.log('Response text:', response.text);
  } catch (err: any) {
    console.error('Error caught:', err.stack || err.message);
  }
}

test();
