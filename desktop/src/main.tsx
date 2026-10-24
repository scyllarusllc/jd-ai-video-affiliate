import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { accountService, type Account } from './accounts';
import { productService, type Product } from './products';
import { ProductWorkspace } from './ProductWorkspace';
import { ScriptWorkspace } from './ScriptWorkspace';
import { isPreview, logEvent, writeLog, type LogEntry } from './bridge';
import './style.css';

type View = 'overview' | 'jd' | 'doubao' | 'products' | 'scripts' | 'settings';
const navigation: { id: View; label: string }[] = [
  { id: 'overview', label: '数据大屏' }, { id: 'jd', label: '京东账号' },
  { id: 'doubao', label: '豆包账号' }, { id: 'products', label: '商品工作区' },
  { id: 'scripts', label: '脚本工作区' }, { id: 'settings', label: '设置' },
];

function AddAccount({ platform, onClose, onSave }: {
  platform: Account['platform']; onClose: () => void;
  onSave: (platform: Account['platform'], name: string) => Promise<boolean>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState(platform);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try { if (await onSave(selected, name.trim())) onClose(); else setError('添加失败，详细原因见工作台状态栏与执行日志。'); }
    finally { setBusy(false); }
  }
  return <dialog ref={ref} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} aria-labelledby="add-account-title">
    <form className="dialog-form" onSubmit={submit}><h2 id="add-account-title">添加账号</h2>
      <label>平台<select value={selected} disabled={busy} onChange={e => setSelected(e.target.value as Account['platform'])}>
        <option value="doubao">豆包</option><option value="jd">京东创作服务平台</option></select></label>
      <label>账号名称<input autoFocus required maxLength={60} value={name} disabled={busy} onChange={e => setName(e.target.value)} placeholder="给这个账号起个名字" /></label>
      <p>登录会在独立账号窗口中完成。</p>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="toolbar"><button disabled={busy || !name.trim()}>保存账号</button><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button></div>
    </form></dialog>;
}

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [view, setView] = useState<View>('doubao');
  const [visited, setVisited] = useState<View[]>([]);
  const [platform, setPlatform] = useState<Account['platform']>('doubao');
  const [archived, setArchived] = useState(false);
  const [currentId, setCurrentId] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showLogs, setShowLogs] = useState(true);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [message, setMessage] = useState('正在读取本地账号…');
  const logBottom = useRef<HTMLDivElement>(null);
  const workspaceScroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const listener = (event: Event) => {
      const entry = (event as CustomEvent<LogEntry>).detail;
      setLogs(previous => [...previous, entry].slice(-300));
    };
    window.addEventListener(logEvent, listener);
    writeLog(isPreview() ? '已进入界面演示，所有示例数据仅保留在当前页面内存' : '工作台已启动，登录状态与额度需在平台确认');
    return () => window.removeEventListener(logEvent, listener);
  }, []);
  useEffect(() => { logBottom.current?.scrollIntoView({ block: 'nearest' }); }, [logs, showLogs]);
  useEffect(() => { workspaceScroll.current?.scrollTo({ top: 0 }); }, [view]);

  async function refresh() {
    setBusy(true);
    try {
      const list = await accountService.load();
      setAccounts(list); setReady(true);
      setChecked(previous => previous.filter(id => list.some(a => a.id === id)));
      setMessage('账号资料已读取；登录状态与可用额度待平台确认。');
    } catch (error) { setReady(false); setMessage('读取失败：' + String(error)); }
    try { setProducts(await productService.list()); } catch { /* Logged by the bridge. */ }
    setBusy(false);
  }
  useEffect(() => { void refresh(); }, []);

  function navigate(next: View) {
    setView(next);
    setVisited(previous => previous.includes(next) ? previous : [...previous, next]);
    if (next === 'jd' || next === 'doubao') { setPlatform(next); setChecked([]); setSearch(''); }
  }
  const visible = accounts.filter(a => a.platform === platform && a.archived === archived && a.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const current = visible.find(a => a.id === currentId) || visible[0];
  const allChecked = visible.length > 0 && visible.every(a => checked.includes(a.id));
  const selectedCount = visible.filter(a => checked.includes(a.id)).length;

  async function openAccount(probe = false) {
    if (!current || current.archived) return;
    setBusy(true);
    try {
      await accountService.open(current.id, probe);
      setMessage('已打开 ' + current.name + ' 的' + (probe ? '存储验证页' : '独立网页窗口') + '。');
    } catch (error) { setMessage('打开失败：' + String(error)); }
    finally { setBusy(false); }
  }
  async function saveAccount(target: Account['platform'], name: string) {
    try {
      const account = await accountService.create(target, name);
      setAccounts(await accountService.load()); setPlatform(target); setArchived(false); setCurrentId(account.id); setView(target); setReady(true);
      setMessage('已添加 ' + account.name + '，请选择打开账号窗口登录。');
      return true;
    } catch (error) { setMessage('添加失败：' + String(error)); return false; }
  }
  async function archiveSelected(ids: string[], next: boolean) {
    setBusy(true); let successes = 0; let failures = 0;
    try {
      for (const id of ids) {
        try { await accountService.archive(id, next); successes++; }
        catch (error) {
          failures++;
          writeLog((next ? '归档' : '恢复') + '账号 ' + (accounts.find(a => a.id === id)?.name || id) + '失败：' + String(error), 'error');
        }
      }
      setAccounts(await accountService.load()); setChecked([]); setCurrentId('');
      setMessage((next ? '归档' : '恢复') + '完成 ' + successes + ' 个，失败 ' + failures + ' 个。失败原因见日志。');
    } catch (error) { setMessage('账号可能已变更，请重新读取核对：' + String(error)); }
    finally { setBusy(false); }
  }

  const accountView = view === 'jd' || view === 'doubao';
  return <main className="app-shell">
    <header className="app-header"><div className="brand-mark" aria-hidden="true">▶</div>
      <h1>京东助手 <span>AI 短视频带货与佣金实战</span></h1><span className="build-badge">macOS · 开发版</span></header>
    {isPreview() && <div className="preview-notice">界面演示 · 示例账号与商品不代表真实数据；当前页面不会连接账号或保存到数据库。</div>}
    <nav className="module-nav" aria-label="模块导航">{navigation.map(item => <button key={item.id} aria-current={view === item.id ? 'page' : undefined}
      className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)}>{item.label}</button>)}<span className="nav-spacer" />
      <span className="local-mode">本地工作台</span></nav>

    <div className="workbench">
      <aside className="account-sidebar" aria-label="账号列表">
        <div className="sidebar-heading"><h2>{platform === 'doubao' ? '豆包账号' : '京东账号'}</h2><span>{visible.length} 个</span></div>
        <div className="platform-switch"><button className={platform === 'doubao' ? 'selected' : ''} onClick={() => navigate('doubao')}>豆包</button>
          <button className={platform === 'jd' ? 'selected' : ''} onClick={() => navigate('jd')}>京东</button></div>
        <div className="sidebar-actions"><button disabled={!ready || busy} onClick={() => setAdding(true)}>＋ 添加账号</button>
          <button className="secondary" disabled={busy} onClick={() => void refresh()}>刷新</button></div>
        <input className="account-search" aria-label="搜索账号" placeholder="搜索账号名称" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="account-table-scroll"><table className="account-table"><colgroup><col className="check-column" /><col /><col className="status-column" /><col className="quota-column" /></colgroup>
          <thead><tr><th><input type="checkbox" aria-label="全选当前列表" checked={allChecked} disabled={busy || !visible.length} onChange={e => setChecked(e.target.checked ? visible.map(a => a.id) : [])} /></th>
            <th>名称</th><th>状态</th><th>额度</th></tr></thead>
          <tbody>{visible.map(account => <tr key={account.id} className={current?.id === account.id ? 'current-account' : ''}>
            <td><input type="checkbox" aria-label={'选择 ' + account.name} checked={checked.includes(account.id)} disabled={busy} onChange={e => setChecked(previous => e.target.checked ? [...previous, account.id] : previous.filter(id => id !== account.id))} /></td>
            <td><button className="account-name" aria-pressed={current?.id === account.id} onClick={() => setCurrentId(account.id)}>{account.name}</button></td>
            <td><span className="account-status"><i />{account.archived ? '归档' : '待验证'}</span></td><td className="unknown-quota" title="尚未读取平台额度">—</td>
          </tr>)}</tbody></table>
          {!visible.length && <div className="sidebar-empty">{ready ? archived ? '暂无归档账号' : '当前列表没有账号' : '未连接本地账号库'}<small>{ready ? archived ? '取消勾选可查看使用中的账号' : '添加账号后打开独立窗口登录' : '可点击刷新重新连接'}</small></div>}
        </div>
        <div className="sidebar-footer"><div className="selection-actions"><span>已选 {selectedCount}</span><button className="text-button" disabled={busy || !selectedCount}
          onClick={() => void archiveSelected(visible.filter(a => checked.includes(a.id)).map(a => a.id), !archived)}>{archived ? '批量恢复' : '批量归档'}</button></div>
          <label className="checkbox-label"><input type="checkbox" disabled={busy} checked={archived} onChange={e => { setArchived(e.target.checked); setChecked([]); }} />查看归档账号</label>
          <p>待验证为未知登录状态，— 为未读取额度。</p></div>
      </aside>

      <div className="right-workspace">
        <div className="action-bar" aria-label="快捷操作">
          <button disabled={busy || !current || current.archived} onClick={() => void openAccount()}>{platform === 'doubao' ? '打开豆包' : '打开京东'}</button>
          <button className="secondary" onClick={() => navigate('scripts')}>脚本模板</button>
          <button className="secondary" onClick={() => navigate('products')}>商品资料</button>
          <button className="secondary" disabled={busy || !current || current.archived} onClick={() => void openAccount(true)}>验证存储</button>
          <span className="action-spacer" /><button className="text-button" onClick={() => setShowLogs(!showLogs)}>{showLogs ? '收起日志' : '显示日志'}</button>
        </div>
        <div className="workspace-status" role="status"><span className="status-dot" />{message}</div>
        <label className="mobile-account-picker">当前账号<select value={current?.id || ''} onChange={e => setCurrentId(e.target.value)}>
          {!visible.length && <option value="">当前没有账号</option>}
          {visible.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select></label>
        <div className="workspace-scroll" ref={workspaceScroll}>
          <div hidden={!accountView} className="account-workspace">
            <div className="workspace-title"><div><span className="eyebrow">账号工作区</span><h2>{current?.name || '选择一个账号开始'}</h2></div><span className="neutral-badge">{archived ? '已归档' : '登录状态待验证'}</span></div>
            <div className="browser-launch"><div className="browser-outline" aria-hidden="true"><div className="browser-dots">● ● ●</div><div className="browser-symbol">↗</div></div>
              <h3>{platform === 'doubao' ? '豆包创作工作区' : '京东创作服务平台'}</h3>
              <p>选择左侧账号，在独立窗口中登录和操作。<br />每个账号保留自己的网页存储标识。</p>
              <button disabled={busy || !current || current.archived} onClick={() => void openAccount()}>打开账号窗口 ↗</button>
              <small>当前版本使用独立网页窗口，平台网页尚未嵌入此区域。</small>
            </div>
            <div className="workflow-strip"><span><b>01</b>选择账号</span><span><b>02</b>准备商品资料</span><span><b>03</b>编辑脚本</span><span><b>04</b>打开平台操作</span></div>
            {current && <div className="account-maintenance"><span>账号归档保留原存储标识，可随时恢复。</span><button className="text-button" disabled={busy} onClick={() => void archiveSelected([current.id], !current.archived)}>{current.archived ? '恢复此账号' : '归档此账号'}</button></div>}
          </div>
          <div hidden={view !== 'products'} className="content-workspace">{visited.includes('products') && <ProductWorkspace />}</div>
          <div hidden={view !== 'scripts'} className="content-workspace">{visited.includes('scripts') && <ScriptWorkspace />}</div>
          <div hidden={view !== 'overview'} className="content-workspace"><section><span className="eyebrow">本地数据概览</span><h2>工作台数据</h2>
            <dl className="overview-list"><dt>使用中账号</dt><dd>{accounts.filter(a => !a.archived).length}</dd><dt>归档账号</dt><dd>{accounts.filter(a => a.archived).length}</dd><dt>已录入商品</dt><dd>{products.length}</dd></dl>
            <button className="secondary" disabled={busy} onClick={() => void refresh()}>更新统计</button><p>以上统计来自当前读取结果。佣金、结算、提现和生成额度尚未接入。</p></section></div>
          <div hidden={view !== 'settings'} className="content-workspace"><section><h2>工作台设置</h2>
            <label className="checkbox-label"><input type="checkbox" checked={showLogs} onChange={e => setShowLogs(e.target.checked)} />显示执行日志</label>
            <p>日志只保留当前运行中的最近 300 条，不会在重启后恢复。</p><h3>账号与数据</h3><p>账号、商品和脚本历史保存在本地数据库。归档账号不会删除网页登录数据。</p>
            <h3>当前功能边界</h3><p>脚本模板在本地组装，不调用外部模型。视频生成、素材下载和自动发布尚未接入。</p></section></div>
        </div>
        {showLogs && <section className="log-panel" aria-label="执行日志"><div className="log-header"><h2>执行日志 <span>{logs.length}</span></h2><span>本次运行</span>
          <button className="text-button" onClick={() => setLogs([])}>清空显示</button></div>
          <div className="log-scroll" aria-live="polite" role="log">{logs.map(entry => <div className={'log-line ' + entry.level} key={entry.id}><time>{new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })}</time>
            <span>{entry.level === 'error' ? '失败' : entry.level === 'success' ? '完成' : '信息'}</span><p>{entry.text}</p></div>)}<div ref={logBottom} /></div>
        </section>}
      </div>
    </div>
    {adding && <AddAccount platform={platform} onClose={() => setAdding(false)} onSave={saveAccount} />}
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
