import { useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeLog } from './bridge';
import { missingPublishFields, platformLabels, type Download, type PublishDraftInput } from './mediaTypes';

export function PublishDraftEditor({ download, onSaved, onClose }: {
  download: Download; onSaved: (download: Download) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const initial = download.publishDraft;
  const [form, setForm] = useState<PublishDraftInput>({ platform: initial?.platform || '', title: initial?.title || '', caption: initial?.caption || '' });
  const [baseline, setBaseline] = useState(form);
  const [revision, setRevision] = useState(initial?.revision || 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const missing = missingPublishFields(download, form);
  const stale = (download.publishDraft?.revision || 0) !== revision;
  useEffect(() => { ref.current?.showModal(); }, []);
  function change(key: keyof PublishDraftInput, value: string) {
    setForm(current => ({ ...current, [key]: value })); setMessage('');
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const updated = await invoke<Download>('save_publish_draft', { id: download.id, revision, draft: form });
      const saved = updated.publishDraft!;
      const normalized = { platform: saved.platform, title: saved.title, caption: saved.caption };
      setForm(normalized); setBaseline(normalized); setRevision(saved.revision); onSaved(updated);
      setMessage('发布草稿已保存到本地。'); writeLog(download.filename + '：发布草稿已保存', 'success');
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  function reload() {
    const saved = download.publishDraft;
    const next = { platform: saved?.platform || '', title: saved?.title || '', caption: saved?.caption || '' };
    setForm(next); setBaseline(next); setRevision(saved?.revision || 0); setError(''); setMessage('已读取保存的草稿。');
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText([form.title, form.caption].filter(Boolean).join('\n\n'));
      setMessage('已复制保存的标题和文案。'); setError('');
    } catch { setError('复制失败，请选中标题与文案手动复制。'); }
  }
  return <dialog ref={ref} className="publish-dialog" aria-labelledby="publish-draft-title" onCancel={event => {
    if (busy || dirty) { event.preventDefault(); setError('有未保存的修改，可保存草稿或点击“放弃修改并关闭”。'); }
    else onClose();
  }}>
    <form className="dialog-form" onSubmit={event => void save(event)}>
      <h2 id="publish-draft-title">发布准备</h2>
      <p>{download.filename}{download.product ? ' · ' + download.product.title : ' · 尚未关联商品'}</p>
      <p>草稿保存在本地；发布时可复制文案，在目标平台手动填写。</p>
      <label>目标平台<select value={form.platform} disabled={busy} onChange={event => change('platform', event.target.value)}>
        <option value="">尚未选择</option>{Object.entries(platformLabels).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
      </select></label>
      <label>发布标题<input autoFocus value={form.title} maxLength={120} disabled={busy} onChange={event => change('title', event.target.value)} /></label>
      <label>发布文案<textarea rows={7} value={form.caption} maxLength={5000} disabled={busy} onChange={event => change('caption', event.target.value)} /></label>
      <small>本地草稿容量：标题 120 字，文案 5000 字。实际发布限制请在目标平台确认。</small>
      <div className="publish-readiness" role="status">{missing.length ? '还需补充：' + missing.join('、') : '本地资料已齐全，可到目标平台人工核对。'}</div>
      {stale && <p className="dialog-error">已保存的草稿有更新；当前输入已保留，请核对后重新读取。</p>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="toolbar publish-actions">
        <button disabled={busy || stale || (!dirty && revision > 0)}>{busy ? '保存中…' : '保存草稿'}</button>
        <button type="button" className="secondary" disabled={busy || dirty || !revision || stale || (!form.title && !form.caption)} onClick={() => void copy()}>复制已保存文案</button>
        {stale && <button type="button" className="secondary" disabled={busy} onClick={reload}>{dirty ? '放弃当前修改并读取已保存草稿' : '重新读取已保存草稿'}</button>}
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>{dirty ? '放弃修改并关闭' : '关闭'}</button>
      </div>
    </form>
  </dialog>;
}
