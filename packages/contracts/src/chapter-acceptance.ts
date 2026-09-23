interface ReviewForAcceptance {
  advances?: boolean;
  repeatedEvents?: string[];
  findings?: Array<{ severity: string; category: string; issue: string }>;
  perspectives?: Array<unknown>;
}

/** 自动采用与自动修正共用一份验收结果；没有目标字数的内部调用只检查审查 */
export const draftAcceptanceIssues = (content: string, target: number, review?: ReviewForAcceptance): string[] => {
  const actual = [...content.replace(/[\s\u200B-\u200D\uFEFF]/gu, '')].length;
  const issues: string[] = [];
  if (target > 0 && (actual < target || actual > Math.floor(target * 1.2))) {
    issues.push(`正文 ${actual} 字，目标 ${target}～${Math.floor(target * 1.2)} 字`);
  }
  if (!review?.perspectives?.length) issues.push('审查未完成');
  if (review?.advances === false || review?.repeatedEvents?.length) issues.push('审查指出本章重演了前文事件');
  for (const finding of review?.findings || []) {
    if (finding.category === 'format' && /未完成|无法解析审查结果/u.test(finding.issue)) issues.push(`审查未完成：${finding.issue}`);
    if (finding.severity === 'S1' || (finding.severity === 'S2' && ['consistency', 'factual', 'causal'].includes(finding.category))) {
      issues.push(`审查问题：${finding.issue}`);
    }
  }
  return issues;
};
