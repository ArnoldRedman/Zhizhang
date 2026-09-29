// 可拖动分栏：把上一版只服务编辑器侧栏的手柄抽成通用机制。
// 每个分栏有自己的 storage key、方向、取值区间；读回时统一夹到区间内，
// 避免 localStorage 里的旧值或脏值把某一栏拖成 0 宽。

export type PaneAxis = 'x' | 'y';

export interface PaneSpec {
  /** localStorage 键名 */
  key: string;
  min: number;
  max: number;
  /** 用户没调过时的取值 */
  fallback: number;
}

/** 界面上所有可拖动分栏的取值区间，集中在这里，改档位不用翻组件 */
export const panes = {
  appSidebar: { key: 'pane-app-sidebar', min: 168, max: 420, fallback: 232 },
  editorSidebar: { key: 'editor-sidebar-width', min: 180, max: 560, fallback: 244 },
  editorSidebarTabs: { key: 'editor-sidebar-tabs-height', min: 84, max: 520, fallback: 232 },
  projectAgent: { key: 'pane-project-agent', min: 320, max: 760, fallback: 470 },
  agentPanel: { key: 'pane-agent-panel', min: 320, max: 640, fallback: 336 },
  libraryList: { key: 'pane-library-list', min: 170, max: 460, fallback: 245 },
  libraryReader: { key: 'pane-library-reader', min: 220, max: 620, fallback: 330 },
  dismantleLibrary: { key: 'pane-dismantle-library', min: 170, max: 440, fallback: 230 },
  dismantleChapters: { key: 'pane-dismantle-chapters', min: 170, max: 440, fallback: 235 },
  styleList: { key: 'pane-style-list', min: 180, max: 480, fallback: 240 },
} as const satisfies Record<string, PaneSpec>;

export type PaneName = keyof typeof panes;

export function clampPane(name: PaneName, value: number): number {
  const spec = panes[name];
  if (!Number.isFinite(value) || value <= 0) return spec.fallback;
  return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
}

export function readPane(name: PaneName): number {
  try {
    return clampPane(name, Number(localStorage.getItem(panes[name].key)));
  } catch {
    return panes[name].fallback;
  }
}

export function writePane(name: PaneName, value: number): number {
  const next = clampPane(name, value);
  try {
    localStorage.setItem(panes[name].key, String(next));
  } catch {
    // 隐私模式下写不进去不影响本次拖动
  }
  return next;
}

/** 读出全部分栏尺寸，作为组件初始 state */
export function readAllPanes(): Record<PaneName, number> {
  const entries = (Object.keys(panes) as PaneName[]).map(name => [name, readPane(name)] as const);
  return Object.fromEntries(entries) as Record<PaneName, number>;
}
