import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { accountService, type Account } from './accounts';
import './style.css';
import { ProductWorkspace } from './ProductWorkspace';
import { ScriptWorkspace } from './ScriptWorkspace';

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<Account['platform']>('doubao');
  const [message, setMessage] = useState('正在读取账号数据库…');
  const [busy, setBusy] = useState(true);
  const [ready, setReady] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [tab, setTab] = useState<'accounts' | 'products' | 'scripts'>('accounts');

  async function refresh() {
    setBusy(true);
    try {
      setAccounts(await accountService.load());
      setReady(true);
      setMessage('账号已从本地数据库读取。网页登录状态需要在独立窗口确认。');
    } catch (error) { setReady(false); setMessage('读取失败：' + String(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function action(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await work();
      setAccounts(await accountService.load());
      setMessage(success);
      return true;
    } catch (error) { setMessage('操作失败：' + String(error)); return false; }
    finally { setBusy(false); }
  }

  async function addAccount(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !ready || busy) return;
    const saved = await action(() => accountService.create(platform, name.trim()), '已保存账号。打开网页后请自行登录，此处不推断登录状态。');
    if (saved) setName('');
  }

  const visible = accounts.filter(account => account.archived === showArchived);
  return <main>
    <header><span className="eyebrow">TAURI · macOS 验证版</span>
      <h1>京东 AI 短视频带货与佣金实战</h1>
      <p>先验证账号隔离与网页登录，再进入生成和发布流程。</p></header>
    <nav className="tabs" aria-label="工作区">
      <button className={tab === 'accounts' ? '' : 'secondary'} aria-pressed={tab === 'accounts'} onClick={() => setTab('accounts')}>账号管理</button>
      <button className={tab === 'products' ? '' : 'secondary'} aria-pressed={tab === 'products'} onClick={() => setTab('products')}>商品工作区</button>
      <button className={tab === 'scripts' ? '' : 'secondary'} aria-pressed={tab === 'scripts'} onClick={() => setTab('scripts')}>脚本工作区</button>
    </nav>
    <div hidden={tab !== 'accounts'}><section><h2>账号工作区</h2>
      <form onSubmit={addAccount}>
        <label>平台<select disabled={busy || !ready} value={platform} onChange={e => setPlatform(e.target.value as Account['platform'])}>
          <option value="doubao">豆包</option><option value="jd">京东创作服务平台</option>
        </select></label>
        <label>账号名称<input disabled={busy || !ready} value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="例如：豆包 A" required /></label>
        <button disabled={busy || !ready}>添加账号</button>
      </form>
      <div className="toolbar"><button className="secondary" disabled={busy} onClick={() => void refresh()}>重新读取</button>
        <button className="secondary" disabled={busy} onClick={() => setShowArchived(!showArchived)}>{showArchived ? '查看使用中账号' : '查看归档账号'}</button>
        <span>{showArchived ? '已归档' : '使用中'} · {visible.length} 个</span></div>
      {visible.length ? <table><thead><tr><th>账号名称</th><th>平台</th><th>操作</th></tr></thead>
        <tbody>{visible.map(account => <tr key={account.id}>
          <td>{account.name}</td><td>{account.platform === 'doubao' ? '豆包' : '京东'}</td>
          <td>{!account.archived && <>
            <button disabled={busy} onClick={() => void action(() => accountService.open(account.id, false), '已打开 ' + account.name + ' 的平台窗口，登录状态待确认。')}>打开网页</button>
            <button className="secondary" disabled={busy} onClick={() => void action(() => accountService.open(account.id, true), '已打开 ' + account.name + ' 的存储验证页。')}>验证存储隔离</button>
          </>}
          <button className="secondary" disabled={busy} onClick={() => void action(
            () => accountService.archive(account.id, !account.archived),
            account.archived ? '已恢复账号，原存储标识保持不变。' : '已归档账号，登录数据仍保留，可随时恢复。',
          )}>{account.archived ? '恢复账号' : '归档'}</button></td>
        </tr>)}</tbody></table> : <p className="empty">{showArchived ? '暂无归档账号。' : '暂无使用中的账号。添加豆包 A、豆包 B，分别验证登录。'}</p>}
      <p className="status" role="status">{message}</p>
    </section>
    <section><h2>本轮验证顺序</h2><ol>
      <li>两个账号的验证页分别保存不同标记，检查是否互相影响。</li>
      <li>关闭窗口、退出并重启应用，检查标记与真实平台登录是否保留。</li>
      <li>手动完成豆包生成下载、京东上传，并记录弹窗或兼容问题。</li>
    </ol><p>账号名称、平台与存储标识保存在本地 SQLite 数据库。归档不会清除登录数据。本版不自动生成、不提交发布、不记录密码。</p></section></div>
    <div hidden={tab !== 'products'}><ProductWorkspace /></div>
    <div hidden={tab !== 'scripts'}><ScriptWorkspace /></div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<App />);
