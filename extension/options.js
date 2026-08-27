// options 页面逻辑：保存配置 / 测试连接 / 立即同步
const $ = (id) => document.getElementById(id);
const msg = $('msg');

function show(text, cls) {
  msg.textContent = text;
  msg.className = cls || '';
}

async function load() {
  const cfg = await chrome.storage.local.get(['dashboard', 'token']);
  $('dashboard').value = cfg.dashboard || '';
  $('token').value = cfg.token || '';
}

async function save() {
  const dashboard = $('dashboard').value.trim();
  const token = $('token').value.trim();
  await chrome.storage.local.set({ dashboard, token });
  show('✅ 已保存', 'ok');
  setTimeout(() => (msg.textContent = ''), 2000);
}

async function test() {
  const dashboard = $('dashboard').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  if (!dashboard) return show('请先填写看板地址', 'err');

  show('正在测试…');
  try {
    const r = await fetch(dashboard + '/api/auth/status');
    if (!r.ok) return show(`连接失败：HTTP ${r.status}（地址对了吗？）`, 'err');

    if (token) {
      const r2 = await fetch(dashboard + '/api/auth/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ providerId: 'ark', fields: {} }),
      });
      if (r2.status === 401) return show('看板可达，但 token 不匹配', 'err');
    }
    show('✅ 连接成功' + (token ? '，token 校验通过' : ''), 'ok');
  } catch (e) {
    show('连接失败：' + e.message, 'err');
  }
}

async function syncNow() {
  show('正在同步…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'sync-all' });
    show(res && res.ok ? '✅ 已同步方舟/MiniMax（智谱需在智谱官网页面触发）' : '同步失败', res && res.ok ? 'ok' : 'err');
  } catch (e) {
    show('同步失败：' + e.message, 'err');
  }
}

$('saveBtn').addEventListener('click', save);
$('testBtn').addEventListener('click', test);
$('syncBtn').addEventListener('click', syncNow);
load();
