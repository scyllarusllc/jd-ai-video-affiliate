import type { Product } from './products';
export type PublishDraftInput = { platform: string; title: string; caption: string };
export type PublishDraft = PublishDraftInput & { revision: number; updatedAt: number };
export type Download = {
  id: string; createdAt: number; accountName: string; accountId?: string | null;
  filename: string; status: 'downloading' | 'completed' | 'failed';
  path?: string; error?: string; fileAvailable?: boolean;
  product?: Pick<Product, 'id' | 'sku' | 'title' | 'revision'> | null;
  associationRevision?: number; publishDraft?: PublishDraft | null;
};
export const platformLabels: Record<string, string> = { jd: '京东', douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书' };
export function missingPublishFields(download: Download, draft?: PublishDraftInput | null) {
  return [
    !download.fileAvailable && '可访问的视频文件',
    !download.product && '关联商品',
    !draft?.platform && '目标平台',
    !draft?.title.trim() && '发布标题',
    !draft?.caption.trim() && '发布文案',
  ].filter((field): field is string => Boolean(field));
}
