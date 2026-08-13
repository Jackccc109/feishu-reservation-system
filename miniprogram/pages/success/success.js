// pages/success/success.js
const api = require('../../utils/api.js');

Page({
  data: {
    reservation: null,
    qrUrl: '',
    loading: true
  },

  async onLoad(options) {
    const code = options.code;
    if (!code) {
      wx.showToast({ title: '缺少预约码', icon: 'none' });
      this.setData({ loading: false });
      return;
    }
    try {
      const r = await api.getReservation(code);
      this.setData({
        reservation: r,
        qrUrl: api.getQrcodeUrl(code),
        loading: false
      });
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
      this.setData({ loading: false });
    }
  },

  backHome() {
    wx.reLaunch({ url: '/pages/reserve/reserve' });
  }
});
