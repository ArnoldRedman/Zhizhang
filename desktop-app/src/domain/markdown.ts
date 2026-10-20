/**
 * 大纲、卡片这类资料文件本来就是 Markdown，作者在文件夹里手写表格、标题和列表，
 * 但界面只有 textarea，表格进去就变成一墙竖线。这里给一个够用的子集渲染器：
 * 标题、分隔线、引用、围栏代码、有序/无序列表、GFM 表格、段落与行内强调。
 * 不追求 CommonMark 全兼容，也不引入依赖——只需要让作者写的 Markdown 在界面上看起来是它本来的样子。
 */

const escapeHtml = (value: string) => value
  .replace(/&/gu, '&amp;')
  .replace(/</gu, '&lt;')
  .replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;');

/** 行内标记：先转义再放行自己生成的标签，避免资料里的尖括号被当成 HTML 注入 */
const inline = (value: string): string => escapeHtml(value)
  .replace(/`([^`]+)`/gu, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*\n]+)\*/gu, '$1<em>$2</em>')
  .replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

const splitRow = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return trimmed.split('|').map(cell => cell.trim());
};

/** GFM 表格分隔行：| --- | :-: | */
const isTableDivider = (line: string) => /^\s*\|?[\s:-]*-[\s|:-]*$/u.test(line) && line.includes('-');

const tableAlignments = (divider: string): Array<'left' | 'center' | 'right'> => splitRow(divider).map(cell => {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  return right ? 'right' : 'left';
});

const renderTable = (head: string[], divider: string, rows: string[][]): string => {
  const aligns = tableAlignments(divider);
  const cell = (tag: 'th' | 'td', text: string, index: number) => `<${tag} style="text-align:${aligns[index] || 'left'}">${inline(text)}</${tag}>`;
  const headHtml = `<thead><tr>${head.map((text, index) => cell('th', text, index)).join('')}</tr></thead>`;
  const bodyHtml = rows.length ? `<tbody>${rows.map(row => `<tr>${head.map((_, index) => cell('td', row[index] ?? '', index)).join('')}</tr>`).join('')}</tbody>` : '';
  return `<table>${headHtml}${bodyHtml}</table>`;
};

/** Markdown → HTML。入参为空或只有空白时返回空串，界面据此显示占位 */
export const renderMarkdown = (source: string): string => {
  const lines = String(source ?? '').replace(/\r\n/gu, '\n').split('\n');
  const html: string[] = [];
  let index = 0;

  const paragraph: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(inline).join('<br />')}</p>`);
    paragraph.length = 0;
  };

  while (index < lines.length) {
    const line = lines[index];

    // 围栏代码块：整段原样保留，里面的竖线和星号不能被当成表格或强调
    if (/^\s*```/u.test(line)) {
      flushParagraph();
      const code: string[] = [];
      const fence = line.trim().slice(0, 3);
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/u.test(line)) {
      flushParagraph();
      html.push('<hr />');
      index += 1;
      continue;
    }

    // 表格：表头 + 分隔行 + 数据行；缺分隔行就不是表格，按段落处理
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      flushParagraph();
      const head = splitRow(line);
      const divider = lines[index + 1];
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      html.push(renderTable(head, divider, rows));
      continue;
    }

    if (/^\s*>\s?/u.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/u.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/u, ''));
        index += 1;
      }
      html.push(`<blockquote>${quoted.map(inline).join('<br />')}</blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/u.exec(line);
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/u.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const tag = bullet ? 'ul' : 'ol';
      const items: string[] = [];
      while (index < lines.length) {
        const nextBullet = /^\s*[-*+]\s+(.*)$/u.exec(lines[index]);
        const nextOrdered = /^\s*(\d+)[.)]\s+(.*)$/u.exec(lines[index]);
        const text = bullet ? nextBullet?.[1] : nextOrdered?.[2];
        if (text === undefined) break;
        items.push(`<li>${inline(text.trim())}</li>`);
        index += 1;
      }
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flushParagraph();
  return html.join('\n');
};

/** 取正文第一段非标题文字，用作列表摘要或搜索命中提示 */
export const markdownExcerpt = (source: string, limit = 80): string => {
  const line = String(source ?? '').split(/\r?\n/u)
    .map(item => item.trim())
    .find(item => item && !/^#{1,6}\s/u.test(item) && !/^\|/u.test(item));
  if (!line) return '';
  const plain = line.replace(/^[-*+>\d.\s]+/u, '').replace(/[*`]/gu, '');
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
};
