import { desktopCall as invoke, isPreview } from './bridge';
import { invoke as nativeInvoke } from '@tauri-apps/api/core';

export type LoginStatus = 'logged_in' | 'logged_out' | 'unknown';
export const loginStatusLabels: Record<LoginStatus, string> = { logged_in: '已登录', logged_out: '未登录', unknown: '待验证' };

export type Account = { id: string; platform: 'doubao' | 'jd'; name: string; archived: boolean };
type AccountStore = { accounts: Account[]; legacyImported: boolean };
const legacyKey = 'jd-affiliate-prototype-accounts-v1';

// Isolate the desktop bridge so an Electron adapter can replace it later.
export const accountService = {
  async requestLoginCheck(): Promise<void> {
    if (!isPreview()) await nativeInvoke('request_login_sync');
  },
  async loginStates(): Promise<Record<string, LoginStatus>> {
    if (isPreview()) return {};
    // Background checks stay out of the execution log; only changes are logged.
    return nativeInvoke('account_login_states');
  },
  async load(): Promise<Account[]> {
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
  rename(id: string, name: string, expectedName: string) {
    return invoke<Account>('rename_account', { accountId: id, name, expectedName });
  },
  archive(id: string, archived: boolean) {
    return invoke('archive_account', { accountId: id, archived });
  },
  open(id: string, probe: boolean) {
    return invoke('open_account', { accountId: id, probe });
  },
};
