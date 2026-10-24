import { desktopCall } from './bridge';

export type ProductInput = { sku: string; title: string; url: string; specs: string; selling_points: string };
export type Product = ProductInput & { id: string; revision: number };
export type PreviewRow = { line: number; product: ProductInput | null; error: string | null };

function call<T>(command: string, args?: Record<string, unknown>) {
  return desktopCall<T>(command, args);
}

export const productService = {
  list: () => call<Product[]>('list_products'),
  save: (product: ProductInput, editing: Product | null) => call<void>('save_product', {
    product, id: editing?.id ?? null, revision: editing?.revision ?? null,
  }),
  preview: (content: string) => call<PreviewRow[]>('preview_products_csv', { content }),
  import: (content: string) => call<number>('import_products_csv', { content }),
};
