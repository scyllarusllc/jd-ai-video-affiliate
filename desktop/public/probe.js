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
