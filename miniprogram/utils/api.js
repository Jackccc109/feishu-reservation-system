// utils/api.js —— 封装对 Node.js 后端的请求（顾客端 + 员工端）
// 注意：小程序正式上线要求 HTTPS + request 合法域名白名单，
// 本地开发请在开发者工具中勾选「不校验合法域名」。
function getBaseUrl() {
  try {
    const app = getApp();
    return (app && app.globalData && app.globalData.BASE_URL) || 'http://localhost:3000';
  } catch (e) {
    return 'http://localhost:3000';
  }
}
const BASE_URL = getBaseUrl();

// 门店编码（多门店路由）
// 优先级：本地存储 storeCode（开发者工具控制台可 wx.setStorageSync('storeCode','xxx') 覆盖）> globalData.storeCode > 缺省 ''
function getStoreCode() {
  try {
    const fromStorage = wx.getStorageSync('storeCode');
    if (fromStorage) return fromStorage;
    const app = getApp();
    return (app && app.globalData && app.globalData.storeCode) || '';
  } catch (e) {
    return '';
  }
}

// 活动编码（一店多活动；存储覆盖 > globalData.activityCode）
function getActivityCode() {
  try {
    const fromStorage = wx.getStorageSync('activityCode');
    if (fromStorage) return fromStorage;
    const app = getApp();
    return (app && app.globalData && app.globalData.activityCode) || '';
  } catch (e) {
    return '';
  }
}

// 给 GET url 追加门店+活动参数
function withStore(url) {
  let u = url;
  const sc = getStoreCode();
  if (sc) u += (u.includes('?') ? '&' : '?') + 'store=' + encodeURIComponent(sc);
  const ac = getActivityCode();
  if (ac) u += (u.includes('?') ? '&' : '?') + 'act=' + encodeURIComponent(ac);
  return u;
}

// 员工端登录会话：存本地缓存，管理接口自动带上
const ADMIN_TOKEN_KEY = 'adminToken';

function getAdminToken() {
  return wx.getStorageSync(ADMIN_TOKEN_KEY) || '';
}

function setAdminToken(token) {
  if (token) wx.setStorageSync(ADMIN_TOKEN_KEY, token);
  else wx.removeStorageSync(ADMIN_TOKEN_KEY);
}

function request(path, method, data, { needAdmin = false, unlock = false } = {}) {
  return new Promise((resolve, reject) => {
    const header = { 'Content-Type': 'application/json' };
    if (needAdmin) {
      const token = getAdminToken();
      if (token) header['X-Admin-Token'] = token;
    }
    if (unlock) {
      const ut = wx.getStorageSync('unlockToken');
      if (ut) header['X-Unlock-Token'] = ut;
    }
    wx.request({
      url: BASE_URL + path,
      method: method || 'GET',
      data: data || {},
      header,
      success: (res) => {
        if (res.statusCode === 401 && needAdmin) {
          reject({ error: 'NEED_LOGIN', statusCode: 401 });
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
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
  getAdminToken,
  setAdminToken,
  // 门店设置
  getSettings: () => request(withStore('/api/settings')),
  // 可约时段
  getSlots: (date) => request(withStore('/api/slots?date=' + encodeURIComponent(date))),
  // 创建预约（自动带门店编码）
  reserve: (data) => request('/api/reserve', 'POST', { ...data, store: getStoreCode() || undefined, act: getActivityCode() || undefined }),
  // 二维码图片地址（直接用于 <image src>）
  getQrcodeUrl: (code) => BASE_URL + '/api/qrcode/' + encodeURIComponent(code),
  // 按预约码查询
  getReservation: (code) => request(withStore('/api/reservation/' + encodeURIComponent(code))),
  // 顾客"我的预约"：按手机号查全部预约
  getCustomerReservations: (phone) => request(withStore('/api/customer/reservations?phone=' + encodeURIComponent(phone))),
  // 顾客"我的预约"：按微信 openid 查全部预约（登录后自动展示）
  getCustomerReservationsByOpenid: (openid) => request(withStore('/api/customer/reservations?openid=' + encodeURIComponent(openid))),
  // 微信登录：wx.login 的 code → openid
  wxLogin: (code) => request('/api/wx/login', 'POST', { code }),
  // ===== 员工端（管理/签到，需账号密码登录） =====
  // 账号密码登录 → 返回会话 token
  adminLogin: (username, password) => request('/api/admin/login', 'POST', { username, password }),
  // 退出登录
  adminLogout: () => request('/api/admin/logout', 'POST', {}, { needAdmin: true }),
  // 签到（扫一扫/验证码/手机尾号）
  checkin: (data) => request('/api/checkin', 'POST', data, { needAdmin: true }),
  // 管理统计（解锁后返回完整手机号）
  getAdminStats: (date) => request('/api/admin/stats?date=' + encodeURIComponent(date), 'GET', {}, { needAdmin: true }),
  // 今日排队看板
  getAdminQueue: (unlock) => request('/api/admin/queue', 'GET', {}, { needAdmin: true, unlock }),
  // 管理预约列表
  getAdminReservations: (query, unlock) => request('/api/admin/reservations?' + query, 'GET', {}, { needAdmin: true, unlock }),
  // 改签
  adminReschedule: (code, data) => request('/api/admin/reservation/' + encodeURIComponent(code), 'PUT', data, { needAdmin: true }),
  // 取消预约
  adminCancel: (code) => request('/api/admin/reservation/' + encodeURIComponent(code), 'DELETE', {}, { needAdmin: true }),
  // 短信验证：发送验证码到员工手机
  adminVerifySend: () => request('/api/admin/verify/send', 'POST', {}, { needAdmin: true }),
  // 短信验证：校验验证码 → 解锁令牌
  adminVerifyCheck: (code) => request('/api/admin/verify/check', 'POST', { code }, { needAdmin: true }),
  // 短信验证：手动锁定
  adminVerifyLock: () => request('/api/admin/verify/lock', 'POST', {}, { needAdmin: true, unlock: true })
};
