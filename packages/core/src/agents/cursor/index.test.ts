import { describe, expect, it } from 'vitest';
import { createParser, supportedParsers } from '../registry.js';
import { cursorAgent, cursorDefinition } from './index.js';
import { cursorParser } from './parser.js';

describe('cursorAgent wiring', () => {
  it('registers the cursor parser in the agent registry', () => {
    expect(supportedParsers()).toContain('cursor');
    expect(createParser('cursor')).toBe(cursorParser);
    expect(cursorDefinition.parser).toBe(cursorParser);
  });

  it('builds a harness with cursor metadata defaults', () => {
    const harness = cursorAgent();
    expect(harness.id).toBe('cursor');
    expect(harness.modelId).toBe('composer-2.5');
    expect(harness.metadata).toEqual({
      agent: 'cursor',
      modelProvider: 'cursor',
      modelId: 'composer-2.5',
    });
    expect(harness.runsInSandbox).toBe(true);
  });

  it('accepts model and reasoningEffort overrides', () => {
    const harness = cursorAgent({
      model: 'cursor-grok-4.5-high',
      reasoningEffort: 'high',
    });
    expect(harness.modelId).toBe('cursor-grok-4.5-high');
    expect(harness.metadata.reasoningEffort).toBe('high');
  });
});
