import { Message } from '@eventcatalog/sdk';
import { z } from 'zod';

// TODO: Get these from the catalog?
export const EDA_RULES = `
- All schema changes must be backward compatible.
- Events should be designed to be idempotent.
- Avoid using generic event types; be specific about the domain and action.
- All events must have a version number.
- Consider the impact on downstream consumers before making any changes.
`;

export const getSystemPromptForSchemaReview = () => `
You are an expert reviewer specializing in event-driven architectures (EDA).
Your task is to analyze schema diffs and other architectural information based on the provided EDA rules:
${EDA_RULES}

Your audience is enterprise development and architecture teams. Maintain a professional and clear tone.

Provide a detailed assessment covering the following aspects:
- Overall impact of the changes.
- Specific breaking changes, if any.
- Adherence to EDA best practices and the provided rules.
- Potential risks and considerations for downstream systems.
- If the changes are breaking, and if you have a list of consumers, provide a list of consumers that MAY be affected by the changes with a warning message to the team about the consumer (service). And how this can effect them.
- If you have no list of consumers, do not return any consumer information.

Format your response as a JSON object with the following keys:
- "executiveSummary": A concise (2-3 sentences) overview of the most critical findings and the overall risk/impact. This should be suitable for quick ingestion by stakeholders.
- "effectedConsumers": A list of consumers that MAY be affected by the changes with a warning message to the team about the consumer (service). And how this can effect them.
- "score": A numerical score from 0 to 100, where 0 indicates a very problematic change with high risk of breaking compatibility, and 100 indicates a perfectly safe and well-designed change.`;

export const getUserPromptForSchemaReview = (
  previousSchema: string | null,
  newSchema: string,
  consumers: Message[],
  changeStatus = 'modified'
) => `

Please analyze these changes for potential issues, especially breaking changes if this is a schema or configuration file. Provide your assessment.

Review the following changes to the schema:
Change type: ${changeStatus}.
${
  previousSchema === null
    ? 'Base schema: absent, verified by GitHub added-file metadata.'
    : `Previous schema:
\`\`\`
${previousSchema}
\`\`\``
}
New schema:
\`\`\`
${newSchema}
\`\`\`

${
  consumers.length > 0
    ? `
The consumers (effectedConsumers) of the messages are:
${consumers.map((consumer) => `- ${consumer.name} (${consumer.version})`).join('\n')}
`
    : 'The schema does not have any consumers mapped in EventCatalog. Do not return any consumer information.'
}
`;

export const responseSchema = z.object({
  executiveSummary: z
    .string()
    .describe('A concise summary of key findings and overall impact, suitable for quick review by enterprise stakeholders.'),
  score: z
    .number()
    .min(0)
    .max(100)
    .describe('A score from 0 to 100, where 0 indicates a very problematic change and 100 indicates a perfectly safe change.'),
  schemaFormat: z
    .string()
    .describe(
      'The type of schema For example "avro", "json", "yaml", "proto", "thrift", "xml", "avsc". For example JSONDraft7, Avro, Protobuf, etc.'
    ),
  effectedConsumers: z
    .array(
      z.object({
        name: z.string().describe('The name of the consumer (service).'),
        version: z.string().describe('The version of the consumer.'),
        url: z.string().describe('The URL of the consumer (service).'),
        warning: z.string().describe('A warning message to the user about the consumer (service).'),
      })
    )
    .describe('A list of consumers that MAY be affected by the changes to the schemas.'),
});
