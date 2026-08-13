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
    // 微信资料
    avatarUrl: '',
    nickname: '',
    openid: '',
    // 表单
    name: '',
    phone: '',
    phoneFromWx: false,     // 手机号是否来自微信
    partyOptions: ['1人', '2人', '3人', '4人', '5人', '6人', '其他'],
    partyIndex: 1,
    customParty: '',
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
    this.wxLogin();
  },

  // 微信登录，拿到 openid（用于写入飞书识别顾客）
  wxLogin() {
    wx.login({
      success: async (res) => {
        if (!res.code) return;
        try {
          const r = await api.wxLogin(res.code);
          if (r.openid) this.setData({ openid: r.openid });
        } catch (e) { /* 不影响主流程 */ }
      }
    });
  },

  async loadSettings() {
    try {
      const s = await api.getSettings();
      this.setData({ storeName: s.storeName || '门店名称', storeAddress: s.storeAddress || '' });
    } catch (e) { /* 忽略，用默认值 */ }
  },

  async loadSlots() {
    try {
      const res = await api.getSlots(this.data.date);
      const slots = res.slots || [];
      const labels = slots.map(s => {
        const tag = s.available > 0 ? `（剩${s.available}）` : '（已满）';
        return s.slot + tag;
      });
      this.setData({ slots, slotLabels: labels, slotError: '', slotIndex: 0 });
    } catch (e) {
      this.setData({ slotError: '时段加载失败，请重试', slots: [], slotLabels: [] });
    }
  },

  // 微信头像选择
  onChooseAvatar(e) {
    const { avatarUrl } = e.detail;
    this.setData({ avatarUrl });
  },

  // 微信昵称输入（type=nickname 自动带出微信昵称）
  onNickname(e) {
    this.setData({ nickname: e.detail.value });
  },

  onName(e) { this.setData({ name: e.detail.value }); },
  onPhone(e) {
    this.setData({ phone: e.detail.value, phoneFromWx: false });
  },
  onParty(e) { this.setData({ partyIndex: Number(e.detail.value) }); },
  onCustomParty(e) { this.setData({ customParty: e.detail.value }); },
  onDate(e) {
    this.setData({ date: e.detail.value });
    this.loadSlots();
  },
  onSlot(e) { this.setData({ slotIndex: Number(e.detail.value) }); },

  // 微信一键获取手机号
  async getPhoneNumber(e) {
    const { code, errMsg } = e.detail;
    if (errMsg !== 'getPhoneNumber:ok' || !code) {
      wx.showToast({ title: '已取消，可手动输入', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '获取中', mask: true });
    try {
      const r = await api.wxPhone(code);
      if (r.phone) {
        this.setData({ phone: r.phone, phoneFromWx: true });
        wx.showToast({ title: '已自动填入', icon: 'success' });
      } else {
        wx.showToast({ title: r.error || '获取失败', icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: (err && err.error) || '获取失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  getPartySize() {
    const idx = this.data.partyIndex;
    if (idx === this.data.partyOptions.length - 1) {
      const n = parseInt(this.data.customParty, 10);
      return (n && n > 0) ? n : 0;
    }
    return idx + 1;
  },

  async onSubmit() {
    const { name, phone, date, slots, slotIndex, nickname, openid } = this.data;
    const partySize = this.getPartySize();
    if (!name.trim()) return wx.showToast({ title: '请输入姓名', icon: 'none' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return wx.showToast({ title: '手机号格式不正确', icon: 'none' });
    if (!partySize) return wx.showToast({ title: '请填写体验人数', icon: 'none' });
    if (!slots.length || slotIndex >= slots.length) return wx.showToast({ title: '请选择时段', icon: 'none' });

    const timeSlot = slots[slotIndex].slot;
    this.setData({ submitting: true });
    try {
      const res = await api.reserve({
        name, phone, partySize, date, timeSlot,
        nickname: nickname || null,
        openid: openid || null
      });
      if (res.success) {
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
