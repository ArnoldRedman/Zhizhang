import type { ModelApiClient } from "../models/model-api.js";
import { chapterReviewRequest, mergeReviewResults, normalizePerspectiveResult, reviewPerspectivesFor, type ChapterReviewInput, type ChapterReviewResult, type PerspectiveResult, type ReviewMode } from "./chapter-review.js";

/**
 * 按档位串行跑各审查视角并合成报告
 * 写作图（新章）与 chapter.review（旧章）都走这里，视角顺序、失败处理、合并规则只有一份。
 * 某个视角失败不拖垮整份报告：记一条"该视角未完成"，其余视角照常合并
 */
export async function runChapterReview(
  client: ModelApiClient,
  mode: ReviewMode,
  input: ChapterReviewInput,
  lintFindings: Array<{ type: string; severity: "blocking" | "advisory"; line: number; excerpt: string; message: string }> = [],
  onPerspective?: (perspective: string, index: number, total: number) => void,
): Promise<{ result: ChapterReviewResult; inputBytes: number; usages: Array<NonNullable<Awaited<ReturnType<ModelApiClient["chat"]>>["usage"]>>; failures: string[] }> {
  const perspectives = reviewPerspectivesFor(mode);
  const results: PerspectiveResult[] = [];
  const usages: Array<NonNullable<Awaited<ReturnType<ModelApiClient["chat"]>>["usage"]>> = [];
  const failures: string[] = [];
  let inputBytes = 0;
  for (const [index, perspective] of perspectives.entries()) {
    onPerspective?.(perspective, index, perspectives.length);
    const request = chapterReviewRequest(input, perspective);
    inputBytes += request.inputBytes;
    try {
      const response = await client.chat(request.messages, { response_format: { type: "json_object" }, temperature: 0.2, reasoningMode: "off", unbounded: true, retryAttempts: 1 });
      if (response.usage) usages.push(response.usage);
      const normalized = normalizePerspectiveResult(response.content, perspective);
      results.push(normalized);
      if (normalized.findings.some(item => item.category === "format" && item.issue === "无法解析审查结果")) {
        failures.push(`${perspective}：模型返回的审查结果不是可解析的 JSON`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${perspective}：${message}`);
      results.push({ perspective, verdict: "APPROVE", findings: [{ severity: "S4", category: "format", location: "", evidence: "", issue: `${perspectiveLabel(perspective)}未完成：${message}`, fix: "", source: perspective }] });
    }
  }
  return { result: mergeReviewResults(mode, results, lintFindings, failures), inputBytes, usages, failures };
}

export const perspectiveLabel = (perspective: string): string => ({
  architect: "结构审查", character: "人物审查", prose: "文字审查", consistency: "一致性审查", solo: "综合审查",
} as Record<string, string>)[perspective] || perspective;
