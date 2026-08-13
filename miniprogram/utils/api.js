// utils/api.js —— 封装对 ECS 上 Node.js 后端的请求
function getBaseUrl() {
  try {
    const app = getApp();
    return (app && app.globalData && app.globalData.BASE_URL) || 'http://118.178.252.29:3000';
  } catch (e) {
    return 'http://118.178.252.29:3000';
  }
}
const BASE_URL = getBaseUrl();

function request(path, method, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method: method || 'GET',
      data: data || {},
      header: { 'Content-Type': 'application/json' },
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(res.data || { error: '请求失败(' + res.statusCode + ')' });
        }
      },
      fail: (err) => reject({ error: (err && err.errMsg) || '网络错误' })
    });
  });
}

module.exports = {
  BASE_URL,
  // 门店设置
  getSettings: () => request('/api/settings'),
  // 时段余量
  getSlots: (date) => request('/api/slots?date=' + encodeURIComponent(date)),
  // 创建预约
  reserve: (data) => request('/api/reserve', 'POST', data),
  // 二维码图片地址（直接用于 <image src>）
  getQrcodeUrl: (code) => BASE_URL + '/api/qrcode/' + encodeURIComponent(code),
  // 按预约码查询
  getReservation: (code) => request('/api/reservation/' + encodeURIComponent(code)),
  // 签到
  checkin: (data) => request('/api/checkin', 'POST', data),
  // 管理统计
  getAdminStats: (date) => request('/api/admin/stats?date=' + encodeURIComponent(date)),
  // 管理预约列表
  getAdminReservations: (query) => request('/api/admin/reservations?' + query)
};
