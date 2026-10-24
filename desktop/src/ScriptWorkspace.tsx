import { useEffect, useState } from 'react';
import { productService, type Product } from './products';
import { promptService, type PromptDraft, type PromptTemplate, type PromptVersion } from './prompts';

export function ScriptWorkspace() {
  const [products, setProducts] = useState<Product[]>([]);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [productId, setProductId] = useState('');
  const [templateId, setTemplateId] = useState('general');
  const [draft, setDraft] = useState<PromptDraft | null>(null);
  const [body, setBody] = useState('');
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [selected, setSelected] = useState<PromptVersion | null>(null);
  const [requestId, setRequestId] = useState(crypto.randomUUID());
  const [savedBody, setSavedBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('先选择商品和模板，生成本地脚本草稿。');
  // Draft selection is pinned while editing, so switching products cannot misattribute its text.
  const dirty = draft !== null && body !== savedBody;

  async function refreshProducts() {
    setBusy(true);
    try {
      const [items, available] = await Promise.all([productService.list(), promptService.templates()]);
      setProducts(items); setTemplates(available);
      if (!productId && items.length) setProductId(items[0].id);
      setMessage('已读取商品和模板。生成草稿不调用 AI，也不会消耗豆包额度。');
    } catch (error) { setMessage('读取失败：' + String(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refreshProducts(); }, []);

  useEffect(() => {
    let active = true;
    setVersions([]); setSelected(null);
    if (productId) promptService.list(productId).then(rows => { if (active) setVersions(rows); })
      .catch(error => { if (active) setMessage('历史读取失败：' + String(error)); });
    return () => { active = false; };
  }, [productId]);

  async function generate() {
    setBusy(true);
    try {
      const next = await promptService.generate(productId, templateId);
      setDraft(next); setBody(next.body); setSavedBody(null); setRequestId(crypto.randomUUID());
      setMessage('草稿已生成。请核对商品资料并编辑；点击保存后才会进入历史版本。');
    } catch (error) { setMessage('生成失败：' + String(error)); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      const version = await promptService.save(draft, body, requestId);
      setSavedBody(body);
      setMessage('已保存为版本 ' + version.version + '，原有版本保持不变。');
      try { setVersions(await promptService.list(draft.product_id)); setSelected(version); }
      catch { setMessage('脚本已保存，但历史刷新失败。可再次点击保存核对，不会重复创建同一请求。'); }
    } catch (error) { setMessage('保存失败：' + String(error)); }
    finally { setBusy(false); }
  }

  function discardDraft() {
    setDraft(null); setBody(''); setSavedBody(null); setRequestId(crypto.randomUUID());
    setMessage('已关闭当前草稿。已保存的历史版本仍保留。');
  }

  return <>
    <section><h2>商品带货脚本</h2>
      <p>将商品资料填入本地模板，编辑后保存版本。此处输出的是脚本，不会自动生成视频。</p>
      <div className="toolbar"><button className="secondary" disabled={busy} onClick={() => void refreshProducts()}>重新读取商品</button></div>
      <div className="script-selectors">
        <label>商品<select disabled={busy || draft !== null} value={productId} onChange={e => setProductId(e.target.value)}>
          {!products.length && <option value="">请先在商品工作区录入商品</option>}
          {products.map(product => <option key={product.id} value={product.id}>{product.sku} · {product.title}</option>)}
        </select></label>
        <label>脚本模板<select disabled={busy || draft !== null} value={templateId} onChange={e => setTemplateId(e.target.value)}>
          {templates.map(template => <option key={template.id} value={template.id}>{template.name} · v{template.version}</option>)}
        </select></label>
      </div>
      <p>{templates.find(template => template.id === templateId)?.description}</p>
      {!draft && <button disabled={busy || !productId || !templates.length} onClick={() => void generate()}>填入商品资料并生成草稿</button>}
      {draft && <>
        <p>当前草稿：{draft.snapshot.title} · SKU {draft.snapshot.sku} · 商品资料版本 {draft.product_revision}</p>
        <label>脚本正文<textarea className="script-body" rows={20} maxLength={20000} disabled={busy} value={body} onChange={e => {
          setBody(e.target.value); setRequestId(crypto.randomUUID());
        }} /></label>
        <p>保存后才可在重启后恢复；未保存草稿会随应用退出丢失。</p>
        <div className="toolbar"><button disabled={busy || !body.trim()} onClick={() => void save()}>{dirty ? '保存为新版本' : '核对已保存版本'}</button>
          <button className="secondary" disabled={busy} onClick={discardDraft}>{dirty ? '放弃未保存草稿' : '关闭草稿'}</button>
          <span>{dirty ? '当前正文尚未保存' : '正文已保存'}</span></div>
      </>}
      <p className="status" role="status">{message}</p>
    </section>
    <section><h2>历史版本 · {versions.length} 个</h2>
      <p>每个版本保存独立的正文、模板版本和商品资料快照。查看历史不会覆盖正在编辑的草稿。</p>
      {!!versions.length && <table><thead><tr><th>版本</th><th>保存时间</th><th>模板 / 商品版本</th><th>查看</th></tr></thead><tbody>
        {versions.map(version => <tr key={version.id}><td>v{version.version}</td><td>{new Date(version.created_at).toLocaleString()}</td>
          <td>{templates.find(t => t.id === version.template_id)?.name || version.template_id} · 模板 v{version.template_version}<small>商品 v{version.product_revision}</small></td>
          <td><button className="secondary" onClick={() => setSelected(version)}>查看版本</button></td></tr>)}
      </tbody></table>}
      {selected && <details open><summary>版本 {selected.version} · 商品资料快照与正文</summary>
        <dl><dt>SKU</dt><dd>{selected.snapshot.sku}</dd><dt>标题</dt><dd>{selected.snapshot.title}</dd>
          <dt>链接</dt><dd>{selected.snapshot.url || '未提供'}</dd><dt>规格</dt><dd>{selected.snapshot.specs || '未提供'}</dd>
          <dt>事实卖点</dt><dd>{selected.snapshot.selling_points || '未提供'}</dd></dl>
        <label>历史正文（只读，可选中复制）<textarea className="script-body" rows={15} readOnly value={selected.body} /></label>
      </details>}
    </section>
  </>;
}
