// 注入看板页面的桥接脚本：让看板页面的「我已授权 · 保存会话」能直接调扩展同步。
// 1) 设置 window.__quotaSyncExt 标记，供看板检测扩展是否已装
// 2) 监听看板页面发来的 postMessage('quota-sync')，转发给 background 执行同步，再回传结果

window.__quotaSyncExt = true;

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data || {};
  if (d.type === 'quota-sync') {
    chrome.runtime
      .sendMessage({ type: 'sync-all' })
      .then((res) => {
        window.postMessage({ type: 'quota-sync-done', ok: !!(res && res.ok), deepseek: (res && res.deepseek) || '' }, '*');
      })
      .catch(() => {
        window.postMessage({ type: 'quota-sync-done', ok: false }, '*');
      });
  }
});

// background 请求：回传当前页 localStorage 快照（DeepSeek 的 Bearer 会话令牌存于 localStorage 而非 cookie，
// 需要用户开着已登录的 platform.deepseek.com 标签页才能读到）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'read-localstorage') {
    const snapshot = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        if (v && v.length < 200000) snapshot[k] = v;
      }
    } catch {
      /* ignore */
    }
    sendResponse({ ok: true, url: location.href, localStorage: snapshot });
  }
});
