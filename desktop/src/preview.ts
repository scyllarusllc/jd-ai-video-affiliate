// Explicit development-only UI fixtures. Never connected to real accounts or persisted.
import type { Account } from './accounts';
import type { Product } from './products';

let accounts: Account[] = [
  { id: '54eb48f8-b66c-488c-85d4-04b114ad17c1', name: '豆包演示 A', platform: 'doubao', archived: false },
  { id: '658c8b30-600d-45b5-a226-2d83b0984986', name: '豆包演示 B', platform: 'doubao', archived: false },
  { id: '00ea84ae-21f9-4c2f-9133-4c5c73df2306', name: '京东演示账号', platform: 'jd', archived: false },
];
const products: Product[] = [
  { id: 'f1505c45-4793-44b6-971c-e0b17c91a1f5', sku: '100000000001', title: '演示商品 · 日常通勤衬衫', url: '', specs: '示例规格，请替换为真实商品资料', selling_points: '示例卖点，不用于真实发布', revision: 1 },
];

export async function previewCall(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (command) {
    case 'list_accounts': return { accounts: structuredClone(accounts), legacyImported: true };
    case 'list_products': return structuredClone(products);
    case 'list_prompt_templates': return [
      { id: 'clothing', name: '服装展示', version: 1, description: '服装正面、版型与面料展示' },
      { id: 'large-item', name: '大物件展示', version: 1, description: '固定机位与连贯动作' },
      { id: 'general', name: '通用四镜头', version: 1, description: '人物开场、全景、细节与同框收尾' },
    ];
    case 'list_prompt_versions': return [];
    case 'create_account': {
      const name = String(args.name || '').trim();
      if (!name || !['jd', 'doubao'].includes(String(args.platform))) throw new Error('请填写账号名称与平台');
      const account: Account = { id: crypto.randomUUID(), name, platform: args.platform as Account['platform'], archived: false };
      accounts = [...accounts, account];
      return account;
    }
    case 'archive_account': {
      const account = accounts.find(a => a.id === args.accountId);
      if (!account) throw new Error('演示账号不存在');
      account.archived = Boolean(args.archived);
      return null;
    }
    default: throw new Error('此演示仅供界面与账号列表交互预览，请在桌面应用使用此功能。');
  }
}
