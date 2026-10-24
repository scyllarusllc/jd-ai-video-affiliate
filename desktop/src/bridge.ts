import { invoke, isTauri } from '@tauri-apps/api/core';

export type LogEntry = { id: string; time: string; level: 'info' | 'success' | 'error'; text: string };
export const logEvent = 'jd-workbench-log';

export function writeLog(text: string, level: LogEntry['level'] = 'info') {
  window.dispatchEvent(new CustomEvent<LogEntry>(logEvent, {
    detail: { id: crypto.randomUUID(), time: new Date().toISOString(), level, text },
  }));
}

export function isPreview() {
  return import.meta.env.DEV && !isTauri() && new URLSearchParams(location.search).get('preview') === '1';
}

const labels: Record<string, string> = {
  list_accounts: '读取账号', create_account: '添加账号', archive_account: '更新账号归档状态',
  import_legacy_accounts: '迁移旧账号', open_account: '打开账号窗口', list_products: '读取商品',
  save_product: '保存商品', preview_products_csv: '检查 CSV', import_products_csv: '导入商品',
  list_prompt_templates: '读取脚本模板', generate_prompt: '组装脚本草稿',
  save_prompt_version: '保存脚本版本', list_prompt_versions: '读取脚本历史',
};

export async function desktopCall<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const label = labels[command] || '执行操作';
  try {
    let result: T;
    if (isPreview()) {
      const { previewCall } = await import('./preview');
      result = await previewCall(command, args) as T;
    } else {
      if (!isTauri()) throw new Error('需要桌面环境；请运行 make dev server。界面演示可使用开发地址 ?preview=1。');
      result = await invoke<T>(command, args);
    }
    writeLog(label + '完成', 'success');
    return result;
  } catch (error) {
    writeLog(label + '失败：' + String(error), 'error');
    throw error;
  }
}
