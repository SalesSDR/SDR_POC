import { Langfuse } from 'langfuse';
import config from '../../config/env';

// Initialize the global Langfuse client instance
export const langfuse = new Langfuse({
  publicKey: config.LANGFUSE_PUBLIC_KEY,
  secretKey: config.LANGFUSE_SECRET_KEY,
  baseUrl: config.LANGFUSE_HOST,
});

// Log any unexpected asynchronous SDK communication errors
langfuse.on('error', (err) => {
  console.error('[langfuse]: Asynchronous error detected:', err);
});

/**
 * High-order transaction wrapper to execute operations within a Langfuse trace scope.
 * Measures latencies, manages inputs/outputs, captures execution errors, and flushes metadata.
 * 
 * @param workflowName The identifier name of this workflow trace.
 * @param userId Unique target identifier mapping to the user or prospect.
 * @param callback Executor callback block containing AI/model tasks.
 */
export async function traceAIWorkflow<T>(
  workflowName: string,
  userId: string,
  callback: (trace: ReturnType<typeof langfuse.trace>) => Promise<T>
): Promise<T> {
  if (config.NODE_ENV === 'development') {
    console.log(`[langfuse]: Initializing trace context for workflow: "${workflowName}"`);
  }

  // Create the root trace trace instance
  const trace = langfuse.trace({
    name: workflowName,
    userId: userId,
    metadata: {
      environment: config.NODE_ENV,
      timestamp: new Date().toISOString(),
    },
  });

  try {
    // Execute the nested generative steps
    const result = await callback(trace);

    // Update trace with output and tag as success
    trace.update({
      tags: ['success'],
      output: typeof result === 'object' ? JSON.stringify(result) : String(result),
    });

    return result;
  } catch (err: any) {
    // Record error parameters onto the trace instance
    trace.update({
      tags: ['failure'],
      output: JSON.stringify({
        error: err.message || 'Unknown error',
        stack: err.stack,
      }),
    });

    console.error(`[langfuse]: Execution failed in workflow "${workflowName}":`, err.message);
    throw err;
  } finally {
    // Flush event buffers immediately to secure tracking records without closing the client
    try {
      await langfuse.flushAsync();
      if (config.NODE_ENV === 'development') {
        console.log(`[langfuse]: Tracing flush successful for workflow: "${workflowName}".`);
      }
    } catch (flushErr) {
      console.error('[langfuse]: Failed to flush traces to endpoint:', flushErr);
    }
  }
}

export default langfuse;
