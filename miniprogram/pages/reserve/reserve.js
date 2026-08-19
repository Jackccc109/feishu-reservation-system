// pages/reserve/reserve.js
const api = require('../../utils/api.js');

function getToday() {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

Page({
  data: {
    storeName: '门店名称',
    storeAddress: '',
    storeLine: '',       // 小字：门店名称(+地址)
    activityTitle: '', // 大标题：当前活动标题（预约归属校验）
    // 微信登录
    openid: '',
    loggedIn: false,        // 是否已微信登录（登录后才能预约）
    loginLoading: false,    // 微信登录请求中
    // 表单
    name: '',
    phone: '',
    partyOptions: ['1人', '2人', '3人', '4人', '5人', '6人', '其他'],
    partyIndex: 1,
    customParty: '',
    activities: [],       // 门店活动列表
    activityLabels: [],
    activityIndex: 0,
    multiActivity: false, // 是否有多个活动（WXML 不能写 > 表达式）
    date: getToday(),
    slots: [],
    slotLabels: [],
    slotIndex: 0,
    slotError: '',
    submitting: false
  },

  onLoad() {
    this.loadSettings();
    this.loadSlots();
    this.initLogin();
  },

  // 切回本页时重新拉取门店设置/时段（tab 切换、storeCode 变更后生效）
  onShow() {
    this.loadSettings();
    this.loadSlots();
  },

  // 转发给朋友：顾客获取小程序链接的入口
  onShareAppMessage() {
    return {
      title: `${this.data.storeName} - 到店预约`,
      path: '/pages/reserve/reserve'
    };
  },

  // 微信登录（登录后才能预约）：优先用本地缓存的 openid，否则 wx.login 换取
  initLogin() {
    const saved = wx.getStorageSync('openid');
    if (saved) {
      this.setData({ openid: saved, loggedIn: true });
      this.fillSavedProfile(); // 自动带出上次填过的姓名/手机号
      return;
    }
    this.wxLogin();
  },

  // 微信登录，拿到 openid（用于写入飞书识别顾客）
  // 注：微信登录只能拿到匿名 openid，拿不到真实姓名/手机号；
  // 姓名和手机号在顾客首次手动填写后本地记忆，下次登录自动带出。
  wxLogin() {
    return new Promise(resolve => {
      this.setData({ loginLoading: true });
      wx.login({
        success: async (res) => {
          if (!res.code) { this.setData({ loginLoading: false }); return resolve(false); }
          try {
            const r = await api.wxLogin(res.code);
            if (r.openid) {
              wx.setStorageSync('openid', r.openid);
              this.setData({ openid: r.openid, loggedIn: true, loginLoading: false });
              wx.showToast({ title: '登录成功', icon: 'success' });
              this.fillSavedProfile();
              resolve(true);
            } else {
              this.setData({ loginLoading: false });
              resolve(false);
            }
          } catch (e) {
            this.setData({ loginLoading: false });
            wx.showToast({ title: '登录失败，请检查后端配置', icon: 'none' });
            resolve(false);
          }
        },
        fail: () => { this.setData({ loginLoading: false }); resolve(false); }
      });
    });
  },

  // 登录后自动带出上次填过的姓名/手机号（首次需手动填一次）
  fillSavedProfile() {
    const savedName = wx.getStorageSync('custName');
    const savedPhone = wx.getStorageSync('custPhone');
    this.setData({
      name: savedName || this.data.name,
      phone: savedPhone || this.data.phone
    });
  },

  async loadSettings() {
    try {
      const s = await api.getSettings();
      const acts = (s.activities || []).filter(a => a.enabled !== false);
      const actTitle = (s.activity && s.activity.title) || '';
      const actAddr = (s.activity && s.activity.address) || s.storeAddress || '';
      this.setData({
        storeName: s.storeName || '门店名称',           // 门店标题（小字）
        activityTitle: actTitle,                            // 活动名称（大标题）
        storeAddress: actAddr,
        storeLine: (s.storeName || '') + (actAddr ? ' · ' + actAddr : ''),
        activities: acts,
        activityLabels: acts.map(a => a.title),
        activityIndex: 0,
        multiActivity: acts.length > 1
      });
      // 指定了 activityCode 时选中对应活动
      if (acts.length > 1) {
        const saved = wx.getStorageSync('activityCode') || (getApp().globalData && getApp().globalData.activityCode) || '';
        const idx = acts.findIndex(a => a.id === saved);
        if (idx >= 0) this.setData({ activityIndex: idx });
      }
    } catch (e) { /* 忽略，用默认值 */ }
  },

  // 切换活动 → 重新拉时段
  onActivity(e) {
    const idx = Number(e.detail.value);
    const act = this.data.activities[idx];
    if (!act) return;
    this.setData({ activityIndex: idx, activityTitle: act.title, storeAddress: act.address || '', slotError: '', slots: [], slotLabels: [] });
    wx.setStorageSync('activityCode', act.id);
    this.loadSlots();
  },

  async loadSlots() {
    try {
      const res = await api.getSlots(this.data.date);
      const slots = res.slots || [];
      // 后端已过滤：只返回未约满且未过时间的时段，直接展示时段名
      const labels = slots.map(s => s.slot);
      this.setData({ slots, slotLabels: labels, slotError: '', slotIndex: 0 });
      if (!slots.length) {
        this.setData({ slotError: '该日期暂无可用时段' });
      }
    } catch (e) {
      this.setData({ slotError: '时段加载失败，请重试', slots: [], slotLabels: [] });
    }
  },

  onName(e) { this.setData({ name: e.detail.value }); },
  onPhone(e) { this.setData({ phone: e.detail.value }); },
  onParty(e) { this.setData({ partyIndex: Number(e.detail.value) }); },
  onCustomParty(e) { this.setData({ customParty: e.detail.value }); },
  onDate(e) {
    this.setData({ date: e.detail.value });
    this.loadSlots();
  },
  onSlot(e) { this.setData({ slotIndex: Number(e.detail.value) }); },

  getPartySize() {
    const idx = this.data.partyIndex;
    if (idx === this.data.partyOptions.length - 1) {
      const n = parseInt(this.data.customParty, 10);
      return (n && n > 0) ? n : 0;
    }
    return idx + 1;
  },

  async onSubmit() {
    const { name, phone, date, slots, slotIndex, openid, loggedIn } = this.data;
    if (!loggedIn || !openid) return wx.showToast({ title: '请先点击微信登录', icon: 'none' });
    const partySize = this.getPartySize();
    if (!name.trim()) return wx.showToast({ title: '请输入姓名', icon: 'none' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return wx.showToast({ title: '手机号格式不正确', icon: 'none' });
    if (!partySize) return wx.showToast({ title: '请填写体验人数', icon: 'none' });
    if (!slots.length || slotIndex >= slots.length) return wx.showToast({ title: '请选择时段', icon: 'none' });

    const timeSlot = slots[slotIndex].slot;
    this.setData({ submitting: true });
    try {
      const res = await api.reserve({
        name: name.trim(), phone, partySize, date, timeSlot,
        openid: openid || null
      });
      if (res.success) {
        // 预约成功 → 记住姓名/手机号，下次登录自动带出
        wx.setStorageSync('custName', name.trim());
        wx.setStorageSync('custPhone', phone);
        wx.redirectTo({ url: '/pages/success/success?code=' + res.reservation.code });
      } else {
        wx.showToast({ title: res.error || '预约失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: (e && e.error) || '网络错误', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  }
});
