const marker = document.getElementById('marker');
const status = document.getElementById('status');
function read() {
  marker.value = localStorage.getItem('jd-profile-probe') || '';
  status.textContent = marker.value ? `已保存标记：${marker.value}` : '此存储中还没有标记';
}
document.getElementById('save').onclick = () => {
  localStorage.setItem('jd-profile-probe', marker.value);
  read();
};
document.getElementById('clear').onclick = () => {
  localStorage.removeItem('jd-profile-probe');
  read();
};
read();

document.getElementById('download').onclick = () => {
  const url = URL.createObjectURL(new Blob(['JD Affiliate native download check\n'], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'jd-affiliate-download-check.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  document.getElementById('download-status').textContent = '已提交下载请求，请在主窗口下载记录中查看保存结果。';
};
