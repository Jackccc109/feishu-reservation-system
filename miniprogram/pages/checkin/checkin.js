// pages/checkin/checkin.js
const api = require('../../utils/api.js');

function extractCode(raw) {
  if (!raw) return '';
  const m = raw.match(/[?&]code=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  return raw.trim().toUpperCase();
}

Page({
  data: {
    activeTab: 'scan',
    signinCode: '',
    phoneTail: '',
    result: null,
    loading: false,
    error: ''
  },

  onLoad() {
    // 员工功能：需先通过管理口令登录，否则跳回管理登录页
    if (!api.getAdminToken()) {
      wx.redirectTo({ url: '/pages/admin/admin' });
    }
  },

  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab, error: '', result: null });
  },

  scanCode() {
    wx.scanCode({
      scanType: ['qrCode'],
      success: (res) => {
        const code = extractCode(res.result);
        if (!code) {
          wx.showToast({ title: '未识别到预约码', icon: 'none' });
          return;
        }
        this.doCheckin({ code });
      },
      fail: () => { /* 用户取消，忽略 */ }
    });
  },

  onSigninCode(e) { this.setData({ signinCode: e.detail.value }); },
  onPhoneTail(e) { this.setData({ phoneTail: e.detail.value }); },

  submitCode() {
    const v = this.data.signinCode.trim().toUpperCase();
    if (!v) return wx.showToast({ title: '请输入签到验证码', icon: 'none' });
    this.doCheckin({ signinCode: v });
  },

  submitPhone() {
    const v = this.data.phoneTail.trim();
    if (!/^\d{4}$/.test(v)) return wx.showToast({ title: '请输入手机尾号后4位', icon: 'none' });
    this.doCheckin({ phone: v });
  },

  async doCheckin(body) {
    this.setData({ loading: true, error: '', result: null });
    try {
      const res = await api.checkin(body);
      if (res.success) {
        this.setData({ result: res, error: '' });
        wx.vibrateShort({ type: 'medium' });
      } else {
        this.setData({ error: res.error || '签到失败' });
      }
    } catch (e) {
      this.setData({ error: (e && e.error) || '网络错误' });
    } finally {
      this.setData({ loading: false });
    }
  }
});
