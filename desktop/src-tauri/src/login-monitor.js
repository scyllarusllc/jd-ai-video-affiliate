(() => {
  const token = '__SESSION_TOKEN__';
  let sawAccountUI = false;
  function detect() {
    // Read visible UI only: hidden login templates must not override the active screen.
    const visible = [...document.querySelectorAll('body *')].filter(el =>
      el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'
    ).map(el => (el.innerText || '').trim()).filter(Boolean);
    if (visible.some(text => /^(登录成功|扫码成功|已登录)$/.test(text))) return 'logged_in';
    if (visible.some(text => /^(登录|扫码登录|密码登录|短信登录|登录\/注册|登录或注册)$/.test(text))) {
      sawAccountUI = false;
      return 'logged_out';
    }
    if (visible.some(text => /^(退出登录|退出账号)$/.test(text))) return 'logged_in';
    const host = new URL(window.location.href).hostname;
    const privateDrive = (host === 'doubao.com' || host.endsWith('.doubao.com'))
      && [...document.querySelectorAll('a[href]')].some(link => {
        try {
          const target = new URL(link.getAttribute('href'), window.location.href);
          return target.origin === new URL(window.location.href).origin && target.pathname === '/chat/drive/';
        } catch { return false; }
      });
    if (privateDrive && visible.some(text => text === '体验套餐')) {
      sawAccountUI = true;
      return 'logged_in';
    }
    // A collapsed sidebar keeps the verified account DOM. Hidden templates alone
    // cannot establish login; explicit login prompts above always invalidate it.
    if (sawAccountUI && privateDrive && [...document.querySelectorAll('body *')].some(el => (el.textContent || '').trim() === '体验套餐')) return 'logged_in';
    sawAccountUI = false;
    return 'unknown';
  }
  const frameStates = new Map();
  window.addEventListener('message', event => {
    if (window.top !== window.self || event.data?.token !== token) return;
    let host;
    try { host = new URL(event.origin).hostname; } catch { return; }
    if (!['jd.com', '360buylogin.com', 'doubao.com', 'bytedance.com'].some(domain => host === domain || host.endsWith('.' + domain))) return;
    const frame = [...document.querySelectorAll('iframe')].find(el => el.contentWindow === event.source);
    if (!frame || !frame.getClientRects().length || getComputedStyle(frame).visibility === 'hidden') return;
    if (!['logged_in', 'logged_out', 'unknown'].includes(event.data.status)) return;
    frameStates.set(frame, { status: event.data.status, time: Date.now() });
  });
  function report() {
    if (!document.body) return;
    let status = detect();
    if (window.top !== window.self) {
      window.top.postMessage({ token, status }, '*');
      return;
    }
    const states = [status];
    for (const [frame, state] of frameStates) {
      if (!frame.isConnected || !frame.getClientRects().length || Date.now() - state.time > 6000) frameStates.delete(frame);
      else states.push(state.status);
    }
    status = states.includes('logged_in') ? 'logged_in' : states.includes('logged_out') ? 'logged_out' : 'unknown';
    // Native navigation handler consumes this URL and cancels navigation. No request
    // leaves the webview and the remote site receives no native command permissions.
    window.location.href = `https://session-status.invalid/${token}/${status}`;
  }
  window.addEventListener('DOMContentLoaded', report);
  window.addEventListener('jd-status-probe', report);
  setInterval(report, 2000);
})();
