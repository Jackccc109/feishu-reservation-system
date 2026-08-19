// pages/mine/mine.js —— 我的预约（登录账号自动展示 + 手机号辅助查询）
const api = require('../../utils/api.js');

Page({
  data: {
    openid: '',
    loading: false,
    list: [],
    statusText: { pending: '待签到', checked_in: '已签到', cancelled: '已取消' },
    statusClass: { pending: 'st-pending', checked_in: 'st-done', cancelled: 'st-cancel' }
  },

  onShow() {
    const openid = wx.getStorageSync('openid');
    this.setData({ openid: openid || '' });
    if (openid) {
      // 已微信登录 → 自动展示该微信的预约
      this.loadReservations(openid);
    } else {
      this.setData({ list: [] });
    }
  },

  onPullDownRefresh() {
    const openid = this.data.openid;
    if (openid) {
      this.loadReservations(openid, () => wx.stopPullDownRefresh());
    } else {
      wx.stopPullDownRefresh();
    }
  },

  async loadReservations(openid, done) {
    this.setData({ loading: true });
    try {
      const res = await api.getCustomerReservationsByOpenid(openid);
      // 为每条预约生成签到二维码地址
      const list = (res.reservations || []).map(r => ({ ...r, qrUrl: api.getQrcodeUrl(r.code) }));
      this.setData({ list, loading: false });
    } catch (e) {
      this.setData({ loading: false, list: [] });
      wx.showToast({ title: (e && e.error) || '查询失败', icon: 'none' });
    }
    if (done) done();
  },

  goReserve() {
    wx.switchTab({ url: '/pages/reserve/reserve' });
  },

  // 员工入口：管理端（扫一扫签到 + 预约管理），需账号密码登录
  goStaff() {
    wx.navigateTo({ url: '/pages/admin/admin' });
  }
});
