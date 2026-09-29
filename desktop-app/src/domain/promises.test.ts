import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duePromises } from './promises.ts';
import type { StoryPromise } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';
const item = (patch: Partial<StoryPromise>): StoryPromise => ({
  id: patch.id || 'p', text: patch.text || '灯塔的枪得响', status: 'open', updatedAt: now, ...patch,
});

test('只有到期、逾期或踩上节奏的承诺进本章', () => {
  const promises = [
    item({ id: 'due', dueChapter: 10 }),
    item({ id: 'early', text: '还没到', dueChapter: 12 }),
    item({ id: 'overdue', text: '逾期仍在', dueChapter: 8 }),
    item({ id: 'paid', text: '已收', dueChapter: 8, status: 'paid' }),
    item({ id: 'cadence', text: '发糖', everyChapters: 5, plantedChapter: 10 }),
    item({ id: 'note', text: '只是记着' }),
  ];
  assert.deepEqual(duePromises(promises, 10).map(entry => entry.id), ['due', 'overdue']);
  assert.deepEqual(duePromises(promises, 15).map(entry => entry.id), ['due', 'early', 'overdue', 'cadence']);
  assert.deepEqual(duePromises(promises, 14).map(entry => entry.id), ['due', 'early', 'overdue']);
  assert.deepEqual(duePromises(promises, 9).map(entry => entry.id), ['overdue']);
});
