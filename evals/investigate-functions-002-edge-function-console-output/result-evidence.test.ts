import { describe, expect, it } from 'vitest';
import { consoleRowEvidence } from './result-evidence.js';

function mcpResult(rows: unknown[]): unknown {
  return [{ type: 'text', text: JSON.stringify({ result: rows }) }];
}

describe('consoleRowEvidence', () => {
  it.each([
    {
      name: 'coupon row',
      rows: [
        {
          event_message: 'Coupon code SPRING24 expired; dropping discount',
          cart_id: 'cart_8f21ac',
        },
      ],
    },
    {
      name: 'lowercased coupon row',
      rows: [
        {
          event_message: 'coupon code spring24 expired; dropping discount',
          cart_id: 'cart_8f21ac',
        },
      ],
    },
    {
      name: 'pricing timeout row',
      rows: [
        {
          event_message:
            'pricing-gateway timed out after 3 retries; falling back to zero tax',
        },
      ],
    },
  ])('accepts a genuine $name', ({ rows }) => {
    expect(consoleRowEvidence(mcpResult(rows)).foundFinding).toBe(true);
  });

  it.each([
    {
      name: 'request envelopes',
      result: mcpResult([
        {
          event_message: 'POST | 200 | /functions/v1/checkout-quote',
          execution_time_ms: 8431,
        },
      ]),
    },
    {
      name: 'source metadata',
      result: mcpResult([{ source: 'function_logs', count: 6 }]),
    },
    {
      name: 'marker-shaped column aliases',
      result: mcpResult([{ SPRING24: 6, cart_8f21ac: 0 }]),
    },
    {
      name: 'markers split across rows',
      result: mcpResult([
        { event_message: 'Coupon code SPRING24 expired' },
        { cart_id: 'cart_8f21ac' },
      ]),
    },
    { name: 'malformed result', result: [{ type: 'text', text: 'not json' }] },
    {
      name: 'error result',
      result: [
        {
          type: 'text',
          text: JSON.stringify({ result: [], error: 'bad query' }),
        },
      ],
    },
  ])('rejects $name', ({ result }) => {
    expect(consoleRowEvidence(result).foundFinding).toBe(false);
  });
});
