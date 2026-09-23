import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftAcceptanceIssues } from './acceptance.ts';

const content = '正文'.repeat(1100);
const reviewed = { perspectives: [{ perspective: 'consistency' }], advances: true, repeatedEvents: [], findings: [] };

test('合格草稿可自动采用，缺审查或不足字数不可采用', () => {
  assert.deepEqual(draftAcceptanceIssues(content, 2200, reviewed), []);
  assert.match(draftAcceptanceIssues('正文'.repeat(602), 2200, reviewed)[0], /1204 字/);
  assert.deepEqual(draftAcceptanceIssues(content, 2200), ['审查未完成']);
  assert.match(draftAcceptanceIssues(content, 2200, { ...reviewed, findings: [{ severity: 'S4', category: 'format', issue: '一致性审查未完成：超时' }] })[0], /一致性审查未完成/);
});

test('即使字数合格，重复事件与已指出的跨章冲突也不能自动覆盖原章', () => {
  const issues = draftAcceptanceIssues(content, 2200, {
    ...reviewed,
    repeatedEvents: ['上一章已经宣判，本章却择期宣判'],
    findings: [{ severity: 'S2', category: 'consistency', issue: '上一章已经宣判，本章却择期宣判' }],
  });
  assert.equal(issues.length, 2);
  assert.match(issues[1], /上一章已经宣判/);
  assert.equal(draftAcceptanceIssues(content, 2200, { ...reviewed, findings: [{ severity: 'S1', category: 'structure', issue: '同一结果第二次宣判' }] }).length, 1);
  assert.deepEqual(draftAcceptanceIssues(content, 2200, { ...reviewed, findings: [{ severity: 'S4', category: 'prose', issue: '动作略多' }] }), []);
});
