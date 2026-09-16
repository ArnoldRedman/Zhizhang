import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapWithConcurrency } from './concurrency.ts';

test('mapWithConcurrency 按上限并发，且每个任务都跑到', async () => {
  const items = Array.from({ length: 9 }, (_, index) => index);
  let running = 0;
  let peak = 0;
  const seen: number[] = [];
  await mapWithConcurrency(items, 3, async item => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 5));
    running -= 1;
    seen.push(item);
  });
  assert.equal(peak, 3, '并发峰值应等于上限');
  assert.deepEqual([...seen].sort((left, right) => left - right), items);
});

test('mapWithConcurrency 上限非法或超过批量时退化为串行/全开，单个任务抛错不拖累其他任务', async () => {
  const items = [1, 2, 3];
  const done: number[] = [];
  // 上限 0 时按串行跑；中间那个任务失败，后面的 3 必须照旧跑到
  await mapWithConcurrency(items, 0, async item => {
    if (item === 2) throw new Error('单个任务失败');
    done.push(item);
  });
  assert.deepEqual(done, [1, 3]);
  await mapWithConcurrency([], 5, async () => {});
  await mapWithConcurrency([7], 5, async item => { done.push(item); });
  assert.deepEqual(done, [1, 3, 7]);
});
