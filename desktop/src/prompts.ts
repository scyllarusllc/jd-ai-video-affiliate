import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ProductInput } from './products';

export type PromptTemplate = { id: string; name: string; version: number; description: string };
export type PromptDraft = {
  product_id: string; product_revision: number; template_id: string; template_version: number;
  snapshot: ProductInput; body: string;
};
export type PromptVersion = PromptDraft & { id: string; version: number; created_at: string };

function call<T>(command: string, args?: Record<string, unknown>) {
  if (!isTauri()) return Promise.reject(new Error('脚本管理需要桌面环境，请使用 npm run desktop。'));
  return invoke<T>(command, args);
}

export const promptService = {
  templates: () => call<PromptTemplate[]>('list_prompt_templates'),
  generate: (productId: string, templateId: string) => call<PromptDraft>('generate_prompt', { productId, templateId }),
  list: (productId: string) => call<PromptVersion[]>('list_prompt_versions', { productId }),
  save: (draft: PromptDraft, body: string, requestId: string) => call<PromptVersion>('save_prompt_version', {
    productId: draft.product_id, templateId: draft.template_id,
    productRevision: draft.product_revision, body, requestId,
  }),
};
