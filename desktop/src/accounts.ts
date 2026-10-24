import { invoke, isTauri } from '@tauri-apps/api/core';

export type Account = { id: string; platform: 'doubao' | 'jd'; name: string; archived: boolean };
type AccountStore = { accounts: Account[]; legacyImported: boolean };
const legacyKey = 'jd-affiliate-prototype-accounts-v1';

// Isolate the desktop bridge so an Electron adapter can replace it later.
export const accountService = {
  async load(): Promise<Account[]> {
    if (!isTauri()) throw new Error('账号管理需要桌面环境，请使用 npm run desktop。');
    let store = await invoke<AccountStore>('list_accounts');
    if (!store.legacyImported) {
      const raw = localStorage.getItem(legacyKey);
      const legacy: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(legacy)) throw new Error('旧账号列表格式异常，已保留原数据，请核对后重试。');
      await invoke('import_legacy_accounts', { accounts: legacy });
      // Keep the original value as a recovery copy; SQLite records import completion.
      store = await invoke<AccountStore>('list_accounts');
    }
    return store.accounts;
  },
  create(platform: Account['platform'], name: string) {
    return invoke<Account>('create_account', { platform, name });
  },
  archive(id: string, archived: boolean) {
    return invoke('archive_account', { accountId: id, archived });
  },
  open(id: string, probe: boolean) {
    return invoke('open_account', { accountId: id, probe });
  },
};
