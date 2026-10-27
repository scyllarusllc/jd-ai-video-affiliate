export const statusSyncEvent = 'jd-workbench-sync-status';
export function requestStatusSync() { window.dispatchEvent(new Event(statusSyncEvent)); }
