import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadFactsFromSessionQuery, createFactsCache, mapLimit } from '../lib/sources.js';

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);

function snapshot(id, createdAt = T0) {
  return {
    header: { id, createdAt, cwd: '/work/app' },
    events: [
      { type: 'user/message', time: createdAt, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
      { type: 'assistant/message', time: createdAt + 1, data: { message: { content: [{ type: 'text', text: 'yo' }] }, usage: { inputTokens: 3, outputTokens: 4 } } },
    ],
  };
}

function fakeQuery(ids, { failOn = [] } = {}) {
  return {
    listSessions: async () => ids.map((id, index) => ({ header: { id, createdAt: T0 + index }, live: false, persisted: true })),
    readSession: async (id) => {
      if (failOn.includes(id)) throw new Error(`cannot read ${id}`);
      return snapshot(id);
    },
  };
}

describe('sources: sessionQuery adapter', () => {
  it('reads every listed session into facts, newest first', async () => {
    const facts = await loadFactsFromSessionQuery(fakeQuery(['a', 'b', 'c']));
    assert.deepEqual(facts.map((fact) => fact.id), ['c', 'b', 'a']);
    assert.equal(facts[0].humanPoints.length, 1);
    assert.equal(facts[0].tokens.total, 7);
  });

  it('skips unreadable sessions instead of failing the report', async () => {
    const errors = [];
    const facts = await loadFactsFromSessionQuery(fakeQuery(['a', 'b', 'c'], { failOn: ['b'] }), {
      onError: (err, id) => errors.push([id, err.message]),
    });
    assert.deepEqual(facts.map((fact) => fact.id), ['c', 'a']);
    assert.deepEqual(errors, [['b', 'cannot read b']]);
  });

  it('honors the session cap', async () => {
    const facts = await loadFactsFromSessionQuery(fakeQuery(['a', 'b', 'c', 'd']), { maxSessions: 2 });
    assert.deepEqual(facts.map((fact) => fact.id), ['d', 'c']);
  });

  it('rejects a missing service', async () => {
    await assert.rejects(() => loadFactsFromSessionQuery(null), /sessionQuery/);
    await assert.rejects(() => loadFactsFromSessionQuery({ listSessions: async () => [] }), /sessionQuery/);
  });
});

describe('sources: facts cache', () => {
  it('loads once inside the TTL and reloads after it', async () => {
    let calls = 0;
    let clock = 0;
    const cache = createFactsCache(async () => {
      calls += 1;
      return [{ id: `s${calls}` }];
    }, { ttlMs: 1000, now: () => clock });

    assert.equal((await cache.get())[0].id, 's1');
    clock = 500;
    assert.equal((await cache.get())[0].id, 's1');
    assert.equal(calls, 1);

    clock = 1500;
    assert.equal((await cache.get())[0].id, 's2');
    assert.equal(calls, 2);
    cache.invalidate();
    assert.equal((await cache.get())[0].id, 's3');
  });

  it('shares one in-flight load between concurrent callers', async () => {
    let calls = 0;
    const cache = createFactsCache(async () => {
      calls += 1;
      return [{ id: 'only' }];
    }, { ttlMs: 0 });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    assert.equal(calls, 1);
    assert.equal(a, b);
  });

  it('keeps the last good value available as stale data', async () => {
    const cache = createFactsCache(async () => [{ id: 'good' }], { ttlMs: 0 });
    assert.deepEqual(cache.stale(), null);
    await cache.get();
    assert.equal(cache.stale()[0].id, 'good');
  });
});

describe('sources: mapLimit', () => {
  it('preserves order and bounds concurrency', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });
    assert.deepEqual(result, [2, 4, 6, 8, 10]);
    assert.equal(peak <= 2, true);
  });
});
