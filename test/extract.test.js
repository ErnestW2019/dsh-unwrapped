import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractSession, summarizeContent, tokensFromUsage } from '../lib/extract.js';

const T0 = Date.UTC(2026, 5, 1, 10, 0, 0);

function session(events, header = {}) {
  return {
    header: { id: 's1', createdAt: T0, cwd: '/work/proj', agentPreset: 'standard', ...header },
    events,
  };
}

describe('extract: content summarization', () => {
  it('counts text and separates reasoning, keeping the first preview', () => {
    const summary = summarizeContent([
      { type: 'reasoning', text: 'abcd' },
      { type: 'text', text: '  Hello there  ' },
      { type: 'text', text: 'second' },
    ]);
    assert.equal(summary.chars, '  Hello there  '.length + 'second'.length);
    assert.equal(summary.reasoningChars, 4);
    assert.equal(summary.preview, 'Hello there');
  });

  it('counts nested tool-result payloads', () => {
    const summary = summarizeContent([
      { type: 'tool-result', content: [{ type: 'text', text: '12345' }, { type: 'text', text: '678' }] },
    ]);
    assert.equal(summary.toolResultChars, 8);
  });

  it('derives totals when the provider omits totalTokens', () => {
    assert.deepEqual(tokensFromUsage({ inputTokens: 4, outputTokens: 6 }), {
      input: 4,
      output: 6,
      total: 10,
      cacheRead: 0,
      cacheWrite: 0,
    });
    assert.equal(tokensFromUsage({}), null);
    assert.equal(tokensFromUsage(null), null);
  });
});

describe('extract: session folding', () => {
  it('separates human prompts from injected context', () => {
    const facts = extractSession(session([
      { type: 'user/message', time: T0, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
      { type: 'user/message', time: T0 + 10, data: { content: [{ type: 'text', text: 'AGENTS.md injected' }], source: { kind: 'agent' } } },
      { type: 'user/message', time: T0 + 20, data: { content: [{ type: 'text', text: 'second prompt' }], source: { kind: 'user' } } },
    ]));
    assert.equal(facts.humanPoints.length, 2);
    assert.equal(facts.injectedMessages, 1);
    assert.deepEqual(facts.humanPoints.map((p) => p.chars), [2, 'second prompt'.length]);
  });

  it('attaches usage, model, and provider to assistant messages', () => {
    const facts = extractSession(session([
      { type: 'model/selection', time: T0, data: { provider: 'deepseek', model: 'deepseek-v4' } },
      {
        type: 'assistant/message',
        time: T0 + 100,
        data: {
          message: { content: [{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'why' }] },
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
        },
      },
    ]));
    assert.equal(facts.assistantPoints.length, 1);
    const point = facts.assistantPoints[0];
    assert.equal(point.chars, 6);
    assert.equal(point.reasoningChars, 3);
    assert.equal(point.model, 'deepseek-v4');
    assert.equal(point.provider, 'deepseek');
    assert.equal(facts.tokens.input, 10);
    assert.equal(facts.tokens.output, 5);
    assert.equal(facts.tokens.total, 15);
    assert.equal(facts.tokens.cacheRead, 2);
  });

  it('keeps the newest title and counts tools, turns, steps, failures', () => {
    const facts = extractSession(session([
      { type: 'session/title', time: T0, data: { title: 'first' } },
      { type: 'session/title', time: T0 + 1, data: { title: 'final title' } },
      { type: 'tool/call', time: T0 + 2, data: { name: 'pwsh', arguments: '{}' } },
      { type: 'tool/call', time: T0 + 3, data: { name: 'read', arguments: '{}' } },
      { type: 'turn/start', time: T0 + 4, data: { turn: 1 } },
      { type: 'step/end', time: T0 + 5, data: { turn: 1, step: 1 } },
      { type: 'turn/end', time: T0 + 6, data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } },
    ]));
    assert.equal(facts.title, 'final title');
    assert.deepEqual(facts.toolPoints.map((p) => p.name), ['pwsh', 'read']);
    assert.equal(facts.turnPoints.length, 1);
    assert.equal(facts.stepPoints.length, 1);
    assert.equal(facts.failures.length, 1);
    assert.equal(facts.failures[0].message, 'boom');
    assert.equal(facts.firstTs, T0);
    assert.equal(facts.lastTs, T0 + 6);
  });

  it('marks interrupted assistant messages and delegation metadata', () => {
    const facts = extractSession(session([
      { type: 'assistant/message', time: T0, data: { message: { content: [] }, interrupted: true } },
    ], { id: 's2', delegationDepth: 1, origin: 'subagent', isSeeded: true }));
    assert.equal(facts.interrupted, 1);
    assert.equal(facts.delegationDepth, 1);
    assert.equal(facts.origin, 'subagent');
    assert.equal(facts.isSeeded, true);
  });

  it('returns null for unusable snapshots', () => {
    assert.equal(extractSession(null), null);
    assert.equal(extractSession({ events: [] }), null);
    assert.equal(extractSession({ header: {}, events: [] }), null);
  });
});
