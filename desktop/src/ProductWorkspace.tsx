import { useEffect, useState, type FormEvent } from 'react';
import { productService, type Product, type ProductInput, type PreviewRow } from './products';

const empty: ProductInput = { sku: '', title: '', url: '', specs: '', selling_points: '' };

export function ProductWorkspace() {
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState<ProductInput>({ ...empty });
  const [editing, setEditing] = useState<Product | null>(null);
  const [search, setSearch] = useState('');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [message, setMessage] = useState('正在读取商品…');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try { setProducts(await productService.list()); setMessage('商品已读取。商品卖点请依据实际资料填写。'); }
    catch (error) { setMessage('读取失败：' + String(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await productService.save(form, editing);
      setEditing(null); setForm({ ...empty });
      setPreview([]);
      setMessage('商品已保存。');
      try { setProducts(await productService.list()); }
      catch { setMessage('商品已保存，但列表刷新失败，请重新读取后确认。'); }
    } catch (error) { setMessage('保存失败：' + String(error)); }
    finally { setBusy(false); }
  }

  async function checkCsv() {
    setBusy(true); setPreview([]);
    try {
      const rows = await productService.preview(csv);
      setPreview(rows);
      setMessage('已预览 ' + rows.length + ' 行，错误 ' + rows.filter(row => row.error).length + ' 行；此时尚未写入。');
    } catch (error) { setMessage('预览失败：' + String(error)); }
    finally { setBusy(false); }
  }

  async function importCsv() {
    setBusy(true);
    try {
      const count = await productService.import(csv);
      setPreview([]); setCsv('');
      setMessage('已导入 ' + count + ' 个商品。');
      try { setProducts(await productService.list()); }
      catch { setMessage('导入已完成，但列表刷新失败，请重新读取后确认，勿重复提交。'); }
    } catch (error) { setPreview([]); setMessage('导入失败：' + String(error)); }
    finally { setBusy(false); }
  }

  async function readFile(file?: File) {
    if (!file) return;
    setPreview([]); setBusy(true);
    try {
      if (file.size > 1_048_576) throw new Error('CSV 最大为 1 MiB');
      setCsv(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
      setMessage('CSV 已读取，点击预览检查后再确认导入。');
    } catch (error) { setCsv(''); setMessage('读取 CSV 失败，请使用 UTF-8 文件：' + String(error)); }
    finally { setBusy(false); }
  }

  function edit(product: Product) {
    setEditing(product);
    const { sku, title, url, specs, selling_points } = product;
    setForm({ sku, title, url, specs, selling_points });
    setMessage('正在编辑：' + product.title + '。若其他窗口已修改，保存时会提示重新读取。');
  }

  const visible = products.filter(p => (p.sku + ' ' + p.title + ' ' + p.specs).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <>
    <section><h2>{editing ? '编辑商品' : '录入商品'}</h2>
      <form className="product-form" onSubmit={save}>
        <label>京东 SKU<input value={form.sku} disabled={busy} inputMode="numeric" maxLength={30} required onChange={e => setForm({ ...form, sku: e.target.value })} /></label>
        <label>商品标题<input value={form.title} disabled={busy} maxLength={200} required onChange={e => setForm({ ...form, title: e.target.value })} /></label>
        <label className="wide">商品链接（可选，京东 HTTPS 完整链接）<input type="url" value={form.url} disabled={busy} maxLength={2000} onChange={e => setForm({ ...form, url: e.target.value })} /></label>
        <label>型号与规格<textarea value={form.specs} disabled={busy} maxLength={2000} rows={3} onChange={e => setForm({ ...form, specs: e.target.value })} /></label>
        <label>事实卖点<textarea value={form.selling_points} disabled={busy} maxLength={4000} rows={3} onChange={e => setForm({ ...form, selling_points: e.target.value })} /></label>
        <div className="wide"><button disabled={busy}>{editing ? '保存修改' : '保存商品'}</button>
          {editing && <button type="button" className="secondary" disabled={busy} onClick={() => { setEditing(null); setForm({ ...empty }); }}>取消编辑</button>}</div>
      </form>
      <p role="status" className="status">{message}</p>
    </section>
    <section><h2>商品列表 · {products.length} 个</h2>
      <div className="toolbar"><input aria-label="搜索商品" placeholder="搜索 SKU、标题或规格" value={search} onChange={e => setSearch(e.target.value)} />
        <button className="secondary" disabled={busy} onClick={() => void refresh()}>重新读取</button></div>
      {visible.length ? <table><thead><tr><th>SKU</th><th>标题 / 规格</th><th>操作</th></tr></thead><tbody>
        {visible.map(product => <tr key={product.id}><td>{product.sku}</td><td>{product.title}<small>{product.specs}</small></td>
          <td><button className="secondary" disabled={busy} onClick={() => edit(product)}>编辑</button></td></tr>)}
      </tbody></table> : <p>没有匹配商品。可手动录入或使用下方 CSV 导入。</p>}
    </section>
    <section><h2>批量导入 CSV</h2>
      <p>UTF-8，最多 500 行、1 MiB。表头：<code>sku,title,url,specs,selling_points</code>。重复 SKU 或任意错误会阻止整批写入，现有商品请通过编辑修改。</p>
      <label>选择 CSV<input disabled={busy} type="file" accept=".csv,text/csv" onChange={e => { void readFile(e.target.files?.[0]); e.target.value = ''; }} /></label>
      <label className="csv-input">或粘贴 CSV<textarea disabled={busy} rows={6} value={csv} onChange={e => { setCsv(e.target.value); setPreview([]); }} /></label>
      <button disabled={busy || !csv.trim()} onClick={() => void checkCsv()}>预览检查</button>
      <button className="secondary" disabled={busy || !preview.length || preview.some(row => row.error)} onClick={() => void importCsv()}>确认导入 {preview.length ? preview.length + ' 个商品' : ''}</button>
      {!!preview.length && <table><thead><tr><th>CSV 行号</th><th>SKU / 标题</th><th>检查结果</th></tr></thead><tbody>
        {preview.map((row, index) => <tr key={index}><td>{row.line}</td><td>{row.product?.sku}<small>{row.product?.title}</small></td><td>{row.error || '可导入'}</td></tr>)}
      </tbody></table>}
    </section>
  </>;
}
