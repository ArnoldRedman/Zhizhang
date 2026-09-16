/**
 * 有限并发地跑一批任务
 * 中转站通常有每分钟请求数上限，并发开太高反而会批量报 429，所以上限交给调用方给
 * 单个任务自己抛错不拖累其他任务：错误在任务内部处理，这里吞下去继续排下一个
 * （如果错误直接冒出去，那个工作线程会提前结束，其余任务就白等了）
 */
export const mapWithConcurrency = async <Item>(
  items: readonly Item[],
  limit: number,
  run: (item: Item, index: number) => Promise<void>,
): Promise<void> => {
  if (!items.length) return;
  const width = Math.max(1, Math.min(items.length, Math.floor(limit) || 1));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await run(items[index], index);
      } catch {
        // 任务自己的失败由调用方记到对应那一行，这里只保证队列继续往下走
      }
    }
  });
  await Promise.all(workers);
};
