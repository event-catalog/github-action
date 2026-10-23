import { createOpenAI } from '@ai-sdk/openai';
import { AIProvider, type AIProviderOptions } from '@/ai-models/ai-provider';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.6-terra';

const AVAILABLE_OPENAI_MODELS = [
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'o1',
  'o1-2024-12-17',
  'o1-mini',
  'o1-mini-2024-09-12',
  'o1-preview',
  'o1-preview-2024-09-12',
  'o3-mini',
  'o3-mini-2025-01-31',
  'o3',
  'o3-2025-04-16',
  'o4-mini',
  'o4-mini-2025-04-16',
  'gpt-4.1',
  'gpt-4.1-2025-04-14',
  'gpt-4.1-mini',
  'gpt-4.1-mini-2025-04-14',
  'gpt-4.1-nano',
  'gpt-4.1-nano-2025-04-14',
  'gpt-4o',
  'gpt-4o-2024-05-13',
  'gpt-4o-2024-08-06',
  'gpt-4o-2024-11-20',
  'gpt-4o-audio-preview',
  'gpt-4o-audio-preview-2024-10-01',
  'gpt-4o-audio-preview-2024-12-17',
  'gpt-4o-search-preview',
  'gpt-4o-search-preview-2025-03-11',
  'gpt-4o-mini-search-preview',
  'gpt-4o-mini-search-preview-2025-03-11',
  'gpt-4o-mini',
  'gpt-4o-mini-2024-07-18',
  'gpt-4-turbo',
  'gpt-4-turbo-2024-04-09',
  'gpt-4-turbo-preview',
  'gpt-4-0125-preview',
  'gpt-4-1106-preview',
  'gpt-4',
  'gpt-4-0613',
  'gpt-4.5-preview',
  'gpt-4.5-preview-2025-02-27',
  'gpt-3.5-turbo-0125',
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-1106',
  'chatgpt-4o-latest',
] as const;

export class OpenAIProvider extends AIProvider {
  public models: string[];

  constructor(options: AIProviderOptions) {
    const openaiProvider = createOpenAI({
      apiKey: options.apiKey,
    });
    const modelId = options.modelId || DEFAULT_OPENAI_MODEL;
    // The locked SDK treats these newer models as classic chat models, choosing
    // function tools and temperature 0. Use its native JSON-schema output and
    // the supported temperature for these explicitly qualified substitutes.
    const isQualifiedSubstitute = modelId === 'gpt-5.6-terra' || modelId === 'gpt-5.6-luna';
    const languageModel = openaiProvider(modelId, isQualifiedSubstitute ? { structuredOutputs: true } : {});
    super({
      ...options,
      ...(isQualifiedSubstitute && { objectTemperature: 1 }),
      model: languageModel,
    });
    this.models = [...AVAILABLE_OPENAI_MODELS];
  }
}
