import { z, ZodSchema } from 'zod';
import { getInput } from '@actions/core';
import { getProvider } from '@/ai-models';
import * as core from '@actions/core';
import { APICallError, NoObjectGeneratedError, RetryError } from 'ai';
import { DEFAULT_OPENAI_MODEL } from '@/ai-models/openai';

export async function sendPromptToModel(
  systemPrompt: string,
  promptText: string,
  schema: ZodSchema
): Promise<z.infer<typeof schema>> {
  const provider = getInput('provider') || 'openai';
  const model = getInput('model') || DEFAULT_OPENAI_MODEL;
  const apiKey = getInput('api_key') || process.env.API_KEY || '';

  if (apiKey) core.setSecret(apiKey);

  core.info(`Sending prompt to model ${model} with provider ${provider}`);

  const { generateObject } = getProvider(provider, {
    modelId: model,
    apiKey: apiKey,
  });

  // Let the original error reach the task boundary without dumping SDK request data.
  const { object } = await generateObject(
    [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: promptText,
      },
    ],
    schema
  );
  return object;
}

/** Avoid logging SDK error objects or provider messages, which can contain payloads and keys. */
export function getAIErrorMessage(error: unknown): string {
  if (RetryError.isInstance(error)) return getAIErrorMessage(error.lastError);
  if (NoObjectGeneratedError.isInstance(error) || error instanceof z.ZodError) {
    return 'AI review returned invalid or missing structured output.';
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'AI provider request timed out or was aborted.';
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ? `HTTP ${error.statusCode}` : 'network error';
    const data = error.data as { error?: { param?: unknown } } | undefined;
    const param = data?.error?.param;
    const safeParam =
      typeof param === 'string' && ['temperature', 'reasoning_effort', 'response_format', 'model'].includes(param)
        ? `; parameter: ${param}`
        : '';
    return `AI provider request failed (${status}${safeParam}).`;
  }
  if (error instanceof TypeError) return 'AI provider network request failed.';
  return 'AI review failed. Check the provider configuration and try again.';
}
