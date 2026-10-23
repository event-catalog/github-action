import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../src/ai-models/openai';
import { sendPromptToModel } from '../../src/lib/ai';
import * as core from '@actions/core';
import { responseSchema } from '../../src/tasks/schema-review/prompt';
import { readFileSync } from 'node:fs';

const review = {
  executiveSummary: 'Synthetic schema review',
  score: 85,
  schemaFormat: 'json',
  effectedConsumers: [],
};
const messages = [{ role: 'user' as const, content: 'Review the synthetic schema change.' }];

function captureOpenAI() {
  const requests: { url: string; body: any }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url: String(url), body });
      const message = body.tools
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_test', type: 'function', function: { name: 'json', arguments: JSON.stringify(review) } }],
          }
        : { role: 'assistant', content: JSON.stringify(review) };
      return new Response(
        JSON.stringify({
          id: 'test-completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message, finish_reason: body.tools ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    })
  );
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('locked SDK compatibility (no provider requests)', () => {
  it.each(['gpt-5.6-terra', 'gpt-5.6-luna'])(
    'uses strict schema output and supported temperature for explicit %s',
    async (modelId) => {
      const requests = captureOpenAI();
      const result = await new OpenAIProvider({ modelId, apiKey: 'synthetic-key' }).generateObject(messages, responseSchema);
      expect(responseSchema.parse(result.object)).toEqual(review);
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
      expect(requests[0].body).toMatchObject({
        model: modelId,
        temperature: 1,
        response_format: { type: 'json_schema', json_schema: { strict: true } },
      });
      expect(requests[0].body).not.toHaveProperty('tools');
      expect(requests[0].body).not.toHaveProperty('tool_choice');
      expect(requests[0].body).not.toHaveProperty('reasoning_effort');
      expect(requests[0]).toMatchSnapshot();
      const schema = requests[0].body.response_format.json_schema.schema;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toEqual(expect.arrayContaining(['executiveSummary', 'score', 'schemaFormat', 'effectedConsumers']));
      expect(schema.properties.score).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
      expect(schema.properties.effectedConsumers.items).toMatchObject({
        additionalProperties: false,
        required: ['name', 'version', 'url', 'warning'],
      });
    }
  );

  it('migrates the action input and both empty-input fallbacks', async () => {
    const requests = captureOpenAI();
    vi.spyOn(core, 'getInput').mockReturnValue('');
    await sendPromptToModel('Synthetic system', 'Synthetic user', responseSchema);
    await new OpenAIProvider({ modelId: '', apiKey: 'synthetic-key' }).generateObject(messages, responseSchema);
    expect(requests.map(({ body }) => body.model)).toEqual(['gpt-5.6-terra', 'gpt-5.6-terra']);
    const action = readFileSync('action.yml', 'utf8');
    expect(action).toContain("default: 'gpt-5.6-terra'");
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('model: gpt-5.6-terra');
    expect(readme.split('```yaml')[1].split('```')[0]).not.toContain('model: o4-mini');
  });

  it.each(['o4-mini', 'gpt-4o'])('preserves the explicit %s request', async (modelId) => {
    const requests = captureOpenAI();
    const result = await new OpenAIProvider({ modelId, apiKey: 'synthetic-key' }).generateObject(messages, responseSchema);
    expect(responseSchema.parse(result.object)).toEqual(review);
    expect(requests[0].body.model).toBe(modelId);
    if (modelId === 'o4-mini') {
      expect(requests[0].body).not.toHaveProperty('temperature');
      expect(requests[0].body.response_format.type).toBe('json_schema');
    } else {
      expect(requests[0].body.temperature).toBe(0);
      expect(requests[0].body.tools[0].function.name).toBe('json');
    }
  });

  it('preserves Anthropic structured tool output', async () => {
    const requests: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(
          JSON.stringify({
            id: 'test',
            type: 'message',
            role: 'assistant',
            model: 'claude-3-7-sonnet-20250219',
            content: [{ type: 'tool_use', id: 'call_test', name: 'json', input: review }],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      })
    );
    vi.spyOn(core, 'getInput').mockImplementation(
      (name) => ({ provider: 'anthropic', model: 'claude-3-7-sonnet-20250219', api_key: 'synthetic-key' })[name] || ''
    );
    const result = await sendPromptToModel('Synthetic system', 'Synthetic user', responseSchema);
    expect(responseSchema.parse(result)).toEqual(review);
    expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(requests[0].body).toMatchObject({
      model: 'claude-3-7-sonnet-20250219',
      temperature: 0,
      tool_choice: { type: 'tool', name: 'json' },
    });
  });

  it('preserves Google schema output', async () => {
    const requests: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(review) }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      })
    );
    vi.spyOn(core, 'getInput').mockImplementation(
      (name) => ({ provider: 'google', model: 'gemini-1.5-flash', api_key: 'synthetic-key' })[name] || ''
    );
    const result = await sendPromptToModel('Synthetic system', 'Synthetic user', responseSchema);
    expect(responseSchema.parse(result)).toEqual(review);
    expect(requests[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent');
    expect(requests[0].body.generationConfig).toMatchObject({
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: { type: 'object' },
    });
  });
});
