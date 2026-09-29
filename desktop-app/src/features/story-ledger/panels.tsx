import { useState } from 'react';
import type { OutlineDocument, StoryPromise } from '../../domain/project';

const chapterNumber = (value: string) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
};

/** 章纲上的四栏。空着不挡连续创作，运行时只把填了的注入正文提示词 */
export function ChapterBriefFields({ outline, onChange }: { outline: OutlineDocument; onChange: (patch: Partial<OutlineDocument>) => void }) {
  const field = (key: 'readerKnows' | 'protagonistKnows' | 'mustHide' | 'hintOnly', label: string, placeholder: string) => (
    <label>{label}<input className="input" value={outline[key] || ''} placeholder={placeholder} onChange={event => onChange({ [key]: event.target.value })} /></label>
  );
  return (
    <details className="chapter-brief-fields">
      <summary>本章信息边界 <small>空着不挡写作。隐瞒没填时，用上一章埋下的作者真相</small></summary>
      {field('readerKnows', '读者已经知道', '读者此刻已经知道的事')}
      {field('protagonistKnows', '视角人物已经知道', '本章视角人物知道什么')}
      {field('mustHide', '必须隐瞒', '角色不能说破的底')}
      {field('hintOnly', '只能暗示', '可以露头，不能明说')}
    </details>
  );
}

/** 作者可改的承诺账。没填期限或节奏的条目留在这里，不进每一章的提示词 */
export function PromiseLedger({ promises, onChange }: { promises: StoryPromise[]; onChange: (next: StoryPromise[]) => void }) {
  const [text, setText] = useState('');
  const [planted, setPlanted] = useState('');
  const [due, setDue] = useState('');
  const [every, setEvery] = useState('');
  const patch = (id: string, partial: Partial<StoryPromise>) => onChange(promises.map(item => item.id === id ? { ...item, ...partial, updatedAt: new Date().toISOString() } : item));
  const add = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onChange([...promises, {
      id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text: trimmed,
      plantedChapter: chapterNumber(planted),
      dueChapter: chapterNumber(due),
      everyChapters: chapterNumber(every),
      status: 'open',
      updatedAt: new Date().toISOString(),
    }]);
    setText('');
    setPlanted('');
    setDue('');
    setEvery('');
  };
  return (
    <details className="outline-promises">
      <summary>承诺账 <small>{promises.filter(item => item.status === 'open').length} 条未收。填了期限或节奏，到期才进写作</small></summary>
      {promises.map(item => (
        <div className="promise-row" key={item.id}>
          <input className="input" value={item.text} onChange={event => patch(item.id, { text: event.target.value })} />
          <div className="promise-row-meta">
            <label>埋设<input className="input" inputMode="numeric" value={item.plantedChapter ?? ''} onChange={event => patch(item.id, { plantedChapter: chapterNumber(event.target.value) })} /></label>
            <label>期限<input className="input" inputMode="numeric" value={item.dueChapter ?? ''} onChange={event => patch(item.id, { dueChapter: chapterNumber(event.target.value) })} /></label>
            <label>每隔<input className="input" inputMode="numeric" value={item.everyChapters ?? ''} onChange={event => patch(item.id, { everyChapters: chapterNumber(event.target.value) })} /></label>
            <select className="select" value={item.status} onChange={event => patch(item.id, { status: event.target.value as StoryPromise['status'] })}>
              <option value="open">未收</option>
              <option value="paid">已收</option>
              <option value="dropped">放弃</option>
            </select>
            <button type="button" className="link-button" onClick={() => onChange(promises.filter(entry => entry.id !== item.id))}>删除</button>
          </div>
        </div>
      ))}
      <div className="promise-row">
        <input className="input" value={text} placeholder="例如：灯塔上的枪必须响，或每 8 章发一次糖" onChange={event => setText(event.target.value)} />
        <div className="promise-row-meta">
          <label>埋设<input className="input" inputMode="numeric" value={planted} onChange={event => setPlanted(event.target.value)} /></label>
          <label>期限<input className="input" inputMode="numeric" value={due} onChange={event => setDue(event.target.value)} /></label>
          <label>每隔<input className="input" inputMode="numeric" value={every} placeholder="≥2" onChange={event => setEvery(event.target.value)} /></label>
          <button type="button" className="btn-secondary" disabled={!text.trim()} onClick={add}>记下</button>
        </div>
      </div>
    </details>
  );
}
