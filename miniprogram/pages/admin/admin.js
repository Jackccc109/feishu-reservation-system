// pages/admin/admin.js
const api = require('../../utils/api.js');

function getToday() {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function statusText(s) {
  return { pending: '待签到', checked_in: '已签到', cancelled: '已取消' }[s] || s;
}

function extractCode(raw) {
  if (!raw) return '';
  const m = raw.match(/[?&]code=([^&]+)/);
  if (m) return decodeURIComponent(m[1]);
  return raw.trim().toUpperCase();
}

Page({
  data: {
    date: getToday(),
    stats: null,
    list: [],
    statusFilter: '',
    search: '',
    loading: false
  },

  onShow() {
    this.loadAll();
  },

  async loadAll() {
    this.setData({ loading: true });
    try {
      const [stats, listRes] = await Promise.all([
        api.getAdminStats(this.data.date),
        api.getAdminReservations('date=' + encodeURIComponent(this.data.date))
      ]);
      this.setData({
        stats: stats || null,
        list: this.normalize(listRes.reservations || [])
      });
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  normalize(list) {
    return list.map(r => ({ ...r, statusText: statusText(r.status) }));
  },

  onDate(e) {
    this.setData({ date: e.detail.value });
    this.loadAll();
  },

  onSearch(e) { this.setData({ search: e.detail.value }); },

  doSearch() { this.loadList(); },

  filterStatus(e) {
    this.setData({ statusFilter: e.currentTarget.dataset.status });
    this.loadList();
  },

  async loadList() {
    this.setData({ loading: true });
    try {
      let q = 'date=' + encodeURIComponent(this.data.date);
      if (this.data.statusFilter) q += '&status=' + this.data.statusFilter;
      if (this.data.search) q += '&search=' + encodeURIComponent(this.data.search);
      const listRes = await api.getAdminReservations(q);
      this.setData({ list: this.normalize(listRes.reservations || []) });
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  scanCheckin() {
    wx.scanCode({
      scanType: ['qrCode'],
      success: async (res) => {
        const code = extractCode(res.result);
        if (!code) {
          wx.showToast({ title: '未识别到预约码', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '签到中' });
        try {
          const r = await api.checkin({ code });
          wx.hideLoading();
          if (r.success) {
            wx.showModal({
              title: '签到成功',
              content: `${r.reservation.name} · ${r.reservation.timeSlot} · 排队号${r.reservation.queueNumber}`,
              showCancel: false
            });
            this.loadAll();
          } else {
            wx.showModal({ title: '签到失败', content: r.error || '请重试', showCancel: false });
          }
        } catch (e) {
          wx.hideLoading();
          wx.showModal({ title: '错误', content: (e && e.error) || '网络错误', showCancel: false });
        }
      },
      fail: () => { /* 取消 */ }
    });
  }
});
