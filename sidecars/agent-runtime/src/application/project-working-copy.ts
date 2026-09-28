import { applyTextReplacements, type ProjectAgentChange } from "@zhizhang/contracts";

/** 第208章算单章；第206～215章这种区间不算，避免阶段节拍误伤某一章 */
export function chapterOutlineNumber(title: unknown, content?: unknown): string | undefined {
  const match = /第\s*(\d{1,4})\s*章(?!\s*[～~\-—–至到])/u.exec(`${String(title ?? "")}\n${String(content ?? "").slice(0, 400)}`);
  return match?.[1];
}

/** 同一章已有章纲时补上它的编号，后面的写入才能覆盖，而不是再新建一份 */
export function attachOutlineTarget(project: Record<string, unknown>, change: ProjectAgentChange): ProjectAgentChange {
  if (change.type !== "outline.upsert" || change.targetId !== undefined || change.kind !== "章纲") return change;
  const number = chapterOutlineNumber(change.title, change.content);
  const items = Array.isArray(project.outlines) ? project.outlines as Array<Record<string, unknown>> : [];
  const existing = number ? items.find(item => item.kind === "章纲" && chapterOutlineNumber(item.title, item.content) === number) : undefined;
  const id = Number(existing?.id);
  return id > 0 ? { ...change, targetId: id } : change;
}

/** 只修改本轮临时项目；持久化仍由前端的预览、冲突检查与历史版本负责 */
export function stageProjectChange(project: Record<string, unknown>, change: ProjectAgentChange): void {
  const list = (key: string): Array<Record<string, unknown>> => Array.isArray(project[key]) ? project[key] as Array<Record<string, unknown>> : [];
  const update = (key: string, id: unknown, patch: Record<string, unknown>) => {
    const items = list(key);
    const target = items.find(item => String(item.id) === String(id));
    if (id !== undefined && !target) throw new Error(`找不到待修改的${key}对象：${String(id)}`);
    project[key] = target ? items.map(item => item === target ? { ...item, ...patch } : item) : [...items, { ...patch, id: Date.now() + items.length }];
  };
  switch (change.type) {
    case "project.update": Object.assign(project, change.patch); break;
    case "chapter.update":
      update("chapters", change.targetId, { content: change.content, ...(change.title ? { title: change.title } : {}) });
      // 旧摘要已不能证明新版剧情，后续调用直接依据本轮更新的原文
      project.memories = list("memories").filter(item => String(item.chapterId) !== String(change.targetId));
      project.memoryDocuments = [];
      break;
    case "chapter.create": update("chapters", undefined, { title: change.title, content: change.content }); break;
    case "outline.upsert": {
      const targeted = attachOutlineTarget(project, change);
      const targetId = targeted.type === "outline.upsert" ? targeted.targetId : change.targetId;
      update("outlines", targetId, { kind: change.kind, title: change.title, content: change.content, ...(change.chapterId === undefined ? {} : { chapterId: change.chapterId }) });
      break;
    }
    case "outline.delete": {
      const id = String(change.targetId);
      project.outlines = list("outlines").filter(item => String(item.id) !== id);
      project.graphNodes = list("graphNodes").filter(item => item.id !== `outline:${id}`);
      project.graphEdges = list("graphEdges").filter(item => item.source !== `outline:${id}` && item.target !== `outline:${id}`);
      break;
    }
    case "text.replace": {
      const key = change.target === "chapter" ? "chapters" : "outlines";
      const items = list(key);
      const target = items.find(item => String(item.id) === String(change.targetId));
      if (!target) throw new Error(`找不到要局部修改的${change.target === "chapter" ? "章节" : "大纲"}：${change.targetId}`);
      target.content = applyTextReplacements(String(target.content ?? ""), change.replacements);
      if (change.target === "chapter") project.memories = list("memories").filter(item => String(item.chapterId) !== String(change.targetId));
      break;
    }
    case "card.upsert": update("cards", change.targetId, { type: change.cardType, title: change.title, content: change.content, ...(change.currentState === undefined ? {} : { currentState: change.currentState }) }); break;
    case "memory.document.upsert": update("memoryDocuments", list("memoryDocuments").find(item => item.kind === change.kind)?.id, { kind: change.kind, title: change.title, content: change.content }); break;
    case "graph.node.upsert": {
      const items = list("graphNodes");
      const patch = { id: change.targetId, label: change.label, type: change.nodeType, category: change.category, content: change.content, status: change.nodeStatus };
      project.graphNodes = [...items.filter(item => item.id !== change.targetId), patch];
      break;
    }
    case "graph.edge.upsert":
      project.graphEdges = [...list("graphEdges").filter(item => item.id !== change.targetId), { id: change.targetId, source: change.source, target: change.target, label: change.label, weight: change.weight }];
      break;
    // 批量命名、拆章和删除保留现有前端落地流程，不在临时副本里伪造完成
    default: break;
  }
}

/** 同一对象多次修改只展示最终稿，避免前端把中间稿重复应用 */
export function proposalKey(change: ProjectAgentChange): string | undefined {
  if (change.type === "project.update") return change.type;
  if (change.type === "memory.document.upsert") return `${change.type}:${change.kind}`;
  if (change.type === "outline.upsert") {
    const number = change.kind === "章纲" ? chapterOutlineNumber(change.title, change.content) : undefined;
    if (number) return `${change.type}:chapter:${number}`;
    return `${change.type}:${change.kind}:${change.title}`;
  }
  if (change.type === "text.replace") return `${change.type}:${change.target}:${change.targetId}`;

  if ("targetId" in change && change.targetId !== undefined) return `${change.type}:${change.targetId}`;
  return undefined;
}
