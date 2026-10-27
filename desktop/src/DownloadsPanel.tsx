import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isPreview, writeLog } from './bridge';
import { productService, type Product } from './products';

import { PublishDraftEditor } from './PublishDraftEditor';
import { missingPublishFields, platformLabels, type Download } from './mediaTypes';
import { requestStatusSync, statusSyncEvent } from './statusSync';

export type MediaSyncSnapshot = { records: Download[]; syncedAt: number; error: string | null };

const labels = { downloading: '下载中', completed: '已保存', failed: '失败' };
const sourceKey = (download: Download) => download.accountId || 'legacy:' + download.accountName;

export function DownloadsPanel({ active, onSync }: { active: boolean; onSync: (snapshot: MediaSyncSnapshot) => void }) {
  const [syncedAt, setSyncedAt] = useState(0);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('');
  const [status, setStatus] = useState('');
  const [association, setAssociation] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [exporting, setExporting] = useState<string[]>([]);
  const [exportPaths, setExportPaths] = useState<Record<string, string>>({});
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState<string[]>([]);

  async function refreshProducts() {
    setLoadingProducts(true);
    try { setProducts(await productService.list()); }
    catch (cause) { setActionError('读取商品失败：' + String(cause)); }
    finally { setLoadingProducts(false); }
  }
  useEffect(() => { if (active) void refreshProducts(); }, [active]);
  useEffect(() => {
    if (isPreview()) { onSync({ records: [], syncedAt: Date.now(), error: null }); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const previous = new Map<string, string>();
    let hydrated = false;
    let inFlight = false;
    async function refresh() {
      if (stopped || inFlight) return;
      clearTimeout(timer); inFlight = true;
      try {
        const result = await invoke<{ records: Download[]; error: string | null }>('list_downloads');
        const list = result.records;
        if (stopped) return;
        for (const download of list) {
          const signature = download.status + ':' + download.fileAvailable;
          const missingFile = download.status === 'completed' && !download.fileAvailable;
          if ((hydrated || download.status === 'downloading') && previous.get(download.id) !== signature) {
            writeLog(`${download.accountName}：${missingFile ? '文件缺失' : labels[download.status]} ${download.filename}${download.error ? '，' + download.error : ''}`,
              download.status === 'failed' || missingFile ? 'error' : download.status === 'completed' ? 'success' : 'info');
          }
          previous.set(download.id, signature);
        }
        hydrated = true;
        setDownloads(current => list.map(item => {
          const existing = current.find(record => record.id === item.id);
          if (!existing) return item;
          return { ...item,
            ...((existing.associationRevision || 0) > (item.associationRevision || 0) ? { product: existing.product, associationRevision: existing.associationRevision } : {}),
            ...((existing.publishDraft?.revision || 0) > (item.publishDraft?.revision || 0) ? { publishDraft: existing.publishDraft } : {}),
          };
        }));
        const time = Date.now();
        setSyncedAt(time); setError(result.error || '');
        onSync({ records: list, syncedAt: time, error: result.error });
      } catch (cause) {
        if (!stopped) {
          const text = '读取下载记录失败：' + String(cause);
          setError(text); onSync({ records: [], syncedAt: 0, error: text });
        }
      }
      inFlight = false;
      if (!stopped) timer = setTimeout(() => void refresh(), 2000);
    }
    const sync = () => void refresh();
    window.addEventListener(statusSyncEvent, sync);
    window.addEventListener('focus', sync);
    void refresh();
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener(statusSyncEvent, sync); window.removeEventListener('focus', sync); };
  }, [onSync]);
  async function fileAction(id: string, command: 'reveal_download' | 'play_download' | 'reveal_publish_package') {
    setActionError('');
    try { await invoke(command, { id }); }
    catch (cause) { setActionError(String(cause)); }
  }
  async function exportPackage(download: Download) {
    setActionError(''); setMessage('正在生成资料包…'); setExporting(current => [...current, download.id]);
    try {
      const result = await invoke<{ path: string; missingFields: string[] }>('export_publish_package', {
        id: download.id, revision: download.publishDraft?.revision || 0, associationRevision: download.associationRevision || 0,
      });
      setExportPaths(current => ({ ...current, [download.id]: result.path }));
      const text = '资料包已导出：' + result.path + (result.missingFields.length ? '；还需补充：' + result.missingFields.join('、') : '；可在目标平台人工核对。');
      setMessage(text); writeLog(text, 'success');
    } catch (cause) { setMessage(''); setActionError('导出失败：' + String(cause)); }
    finally { setExporting(current => current.filter(id => id !== download.id)); }
  }
  async function linkProduct(download: Download, productId: string) {
    setActionError(''); setMessage(''); setSaving(current => [...current, download.id]);
    try {
      const updated = await invoke<Download>('link_download_product', {
        id: download.id, productId: productId || null, revision: download.associationRevision || 0,
      });
      setDownloads(current => current.map(item => item.id === updated.id ? { ...item, ...updated } : item));
      const text = updated.product ? '已关联商品：' + updated.product.title : '已解除商品关联';
      setMessage(text); writeLog(download.filename + '：' + text, 'success'); requestStatusSync();
    } catch (cause) { setActionError('关联未保存：' + String(cause)); }
    finally { setSaving(current => current.filter(id => id !== download.id)); }
  }
  const sources = [...new Map(downloads.map(download => [sourceKey(download), download])).entries()];
  const query = search.trim().toLocaleLowerCase();
  const visible = downloads.filter(download => (!account || sourceKey(download) === account)
    && (!status || download.status === status)
    && (!association || (association === 'linked' ? !!download.product : !download.product))
    && [download.filename, download.accountName, download.product?.title || '', download.product?.sku || '', download.publishDraft?.title || ''].join(' ').toLocaleLowerCase().includes(query));

  return <section className="downloads-panel media-library" aria-label="视频素材库">
    <div className="workspace-title"><div><span className="eyebrow">本地视频与下载文件</span><h2>视频素材库</h2></div><span>{visible.length} / {downloads.length} 条</span></div>
    <p>文件保存在系统“下载 / JD Affiliate”。历史与商品关联在重启后保留，最多展示最近 100 条及进行中的下载。</p>
    <div className="media-filters">
      <label>搜索素材<input aria-label="搜索素材" placeholder="文件名、商品名称或 SKU" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label>来源账号<select value={account} onChange={event => setAccount(event.target.value)}><option value="">全部账号</option>
        {sources.map(([key, download]) => <option key={key} value={key}>{download.accountName} · {download.accountId ? download.accountId.slice(0, 8) : '旧版记录，账号未区分'}</option>)}
      </select></label>
      <label>下载状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option><option value="completed">已保存</option><option value="downloading">下载中</option><option value="failed">失败</option></select></label>
      <label>商品关联<select value={association} onChange={event => setAssociation(event.target.value)}><option value="">全部素材</option><option value="linked">已关联商品</option><option value="unlinked">未关联商品</option></select></label>
      <button className="secondary" onClick={() => { setSearch(''); setAccount(''); setStatus(''); setAssociation(''); }}>清除筛选</button>
    </div>
    <div className="toolbar"><button className="secondary" onClick={requestStatusSync}>同步状态</button><small>{error ? '同步异常' : syncedAt ? '最后同步：' + new Date(syncedAt).toLocaleTimeString('zh-CN') : '正在同步'}</small><button className="secondary" disabled={loadingProducts} onClick={() => void refreshProducts()}>重新读取商品</button><small>关联标签保留选择时的商品名称与 SKU，不改变视频内容。</small></div>
    {message && <p role="status">{message}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {error && <p role="alert">{error}</p>}
    {!downloads.length && <p>在豆包视频详情点击下载，保存的文件会出现在这里。</p>}
    {downloads.length > 0 && !visible.length && <p>没有符合筛选条件的素材，可清除筛选后查看全部记录。</p>}
    <ul>{visible.map(download => <li key={download.id}>
      <div className="media-item-info"><b>{download.filename || '文件'}</b><small>{download.status === 'completed' && !download.fileAvailable ? '文件缺失' : labels[download.status]} · {download.accountName} · {download.createdAt > 0 ? new Date(download.createdAt).toLocaleString('zh-CN') : '时间未知'}</small>
        {download.error && <small>{download.error}</small>}
        {download.status === 'completed' && <small title={download.path}>{download.path}</small>}
        {download.product && <small>关联商品：{download.product.title} · SKU {download.product.sku} · 商品版本 {download.product.revision}</small>}
        {download.publishDraft && <small>发布草稿：{download.publishDraft.title || '未填写标题'} · {platformLabels[download.publishDraft.platform] || '未选择平台'} · {missingPublishFields(download, download.publishDraft).length ? '资料待补' : '待人工核对'}</small>}
      </div>
      {download.status === 'completed' && <div className="media-item-actions">
        <label>关联商品<select aria-label={'关联商品：' + download.filename} value={download.product?.id || ''} disabled={loadingProducts || saving.includes(download.id)} onChange={event => void linkProduct(download, event.target.value)}>
          <option value="">未关联商品</option>
          {download.product && !products.some(product => product.id === download.product?.id) && <option value={download.product.id}>{download.product.title}（历史关联）</option>}
          {products.map(product => <option key={product.id} value={product.id}>{product.title} · {product.sku}</option>)}
        </select></label>
        <div className="download-file-actions">
          {/\.(mp4|mov|m4v|webm)$/i.test(download.filename) && <button className="secondary" onClick={() => setEditingDraft(download.id)}>发布准备</button>}
          {/\.(mp4|mov|m4v)$/i.test(download.filename) && <button className="secondary" onClick={() => void fileAction(download.id, 'play_download')}>播放视频</button>}
          <button className="secondary" onClick={() => void fileAction(download.id, 'reveal_download')}>在 Finder 中显示</button>
          {/\.(mp4|mov|m4v|webm)$/i.test(download.filename) && <button className="secondary"
            disabled={exporting.includes(download.id) || !download.publishDraft || !download.fileAvailable}
            title={!download.publishDraft ? '请先在发布准备中保存草稿' : !download.fileAvailable ? '视频文件不可访问' : '导出视频副本、已保存文案和商品摘要'}
            onClick={() => void exportPackage(download)}>{exporting.includes(download.id) ? '导出中…' : '导出资料包'}</button>}
          {exportPaths[download.id] && <button className="secondary" title={exportPaths[download.id]} onClick={() => void fileAction(download.id, 'reveal_publish_package')}>打开上次资料包</button>}

        </div>
      </div>}
    </li>)}</ul>
    {editingDraft && downloads.find(download => download.id === editingDraft) && <PublishDraftEditor key={editingDraft}
      download={downloads.find(download => download.id === editingDraft)!}
      onClose={() => setEditingDraft(null)}
      onSaved={updated => { setDownloads(current => current.map(item => item.id === updated.id ? { ...item, ...updated } : item)); requestStatusSync(); }} />}
  </section>;
}
