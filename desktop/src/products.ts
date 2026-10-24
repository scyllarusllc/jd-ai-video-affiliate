import { invoke, isTauri } from '@tauri-apps/api/core';

export type ProductInput = { sku: string; title: string; url: string; specs: string; selling_points: string };
export type Product = ProductInput & { id: string; revision: number };
export type PreviewRow = { line: number; product: ProductInput | null; error: string | null };

function call<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauri()) return Promise.reject(new Error('商品管理需要桌面环境，请使用 npm run desktop。'));
  return invoke<T>(command, args);
}

export const productService = {
  list: () => call<Product[]>('list_products'),
  save: (product: ProductInput, editing: Product | null) => call<void>('save_product', {
    product, id: editing?.id ?? null, revision: editing?.revision ?? null,
  }),
  preview: (content: string) => call<PreviewRow[]>('preview_products_csv', { content }),
  import: (content: string) => call<number>('import_products_csv', { content }),
};
