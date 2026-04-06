/**
 * Web search tool — uses OpenAI's built-in hosted web search.
 */

import { webSearchTool } from '@openai/agents';

export const webSearch = webSearchTool({
  searchContextSize: 'medium',
});
