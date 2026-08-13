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
    name: '',
    phone: '',
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
    const { name, phone, date, slots, slotIndex } = this.data;
    const partySize = this.getPartySize();
    if (!name.trim()) return wx.showToast({ title: '请输入姓名', icon: 'none' });
    if (!/^1[3-9]\d{9}$/.test(phone)) return wx.showToast({ title: '手机号格式不正确', icon: 'none' });
    if (!partySize) return wx.showToast({ title: '请填写体验人数', icon: 'none' });
    if (!slots.length || slotIndex >= slots.length) return wx.showToast({ title: '请选择时段', icon: 'none' });

    const timeSlot = slots[slotIndex].slot;
    this.setData({ submitting: true });
    try {
      const res = await api.reserve({ name, phone, partySize, date, timeSlot });
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
