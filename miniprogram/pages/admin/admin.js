// pages/admin/admin.js —— 员工端：账号密码登录后 排队看板/改签/取消/扫码签到/查看完整手机号
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
    authed: false,       // 是否已通过账号密码登录
    username: '',
    password: '',
    loginLoading: false,
    date: getToday(),
    stats: null,
    list: [],
    queueGroups: [],
    statusFilter: '',
    search: '',
    loading: false,
    // 短信解锁
    unlocked: false,
    verifyShow: false,
    verifyPhone: '',
    verifyCode: '',
    verifyError: '',
    verifySending: false,
    verifySent: false,
    // 改签
    rsShow: false,
    rsCode: '',
    rsName: '',
    rsDate: '',
    rsSlot: '',
    rsSlotLabels: [],
    rsSlotIndex: 0,
    rsError: '',
    rsLoading: false
  },

  onShow() {
    if (api.getAdminToken()) {
      this.setData({ authed: true, unlocked: !!wx.getStorageSync('unlockToken') });
      this.loadAll();
    } else {
      this.setData({ authed: false });
    }
  },

  onUsername(e) { this.setData({ username: e.detail.value }); },
  onPassword(e) { this.setData({ password: e.detail.value }); },

  // 账号密码登录 → 拿会话 token
  async doLogin() {
    const username = this.data.username.trim();
    const password = this.data.password;
    if (!username || !password) return wx.showToast({ title: '请输入账号和密码', icon: 'none' });
    this.setData({ loginLoading: true });
    try {
      const r = await api.adminLogin(username, password);
      if (r && r.token) {
        api.setAdminToken(r.token);
        this.setData({ authed: true, password: '', loginLoading: false, unlocked: !!wx.getStorageSync('unlockToken') });
        wx.showToast({ title: '登录成功', icon: 'success' });
        this.loadAll();
      } else {
        this.setData({ loginLoading: false });
        wx.showToast({ title: '登录失败', icon: 'none' });
      }
    } catch (e) {
      this.setData({ loginLoading: false });
      wx.showToast({ title: (e && e.error) || '登录失败', icon: 'none' });
    }
  },

  // 退出登录
  async logout() {
    try { await api.adminLogout(); } catch (e) { /* ignore */ }
    api.setAdminToken('');
    wx.removeStorageSync('unlockToken');
    this.setData({ authed: false, username: '', password: '', unlocked: false });
  },

  async loadAll() {
    this.setData({ loading: true });
    const unlocked = !!wx.getStorageSync('unlockToken');
    try {
      const [stats, listRes, queueRes] = await Promise.all([
        api.getAdminStats(this.data.date),
        api.getAdminReservations('date=' + encodeURIComponent(this.data.date), unlocked),
        api.getAdminQueue(unlocked)
      ]);
      const groups = {};
      (queueRes.pending || []).forEach(r => {
        if (!groups[r.timeSlot]) groups[r.timeSlot] = [];
        groups[r.timeSlot].push(r);
      });
      this.setData({
        stats: stats || null,
        list: this.normalize(listRes.reservations || []),
        queueGroups: Object.keys(groups).sort().map(slot => ({ slot, list: groups[slot] })),
        unlocked
      });
    } catch (e) {
      if (e && e.error === 'NEED_LOGIN') {
        api.setAdminToken('');
        this.setData({ authed: false });
      } else {
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
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
    const unlocked = !!wx.getStorageSync('unlockToken');
    try {
      let q = 'date=' + encodeURIComponent(this.data.date);
      if (this.data.statusFilter) q += '&status=' + this.data.statusFilter;
      if (this.data.search) q += '&search=' + encodeURIComponent(this.data.search);
      const listRes = await api.getAdminReservations(q, unlocked);
      this.setData({ list: this.normalize(listRes.reservations || []) });
    } catch (e) {
      if (e && e.error === 'NEED_LOGIN') {
        api.setAdminToken('');
        this.setData({ authed: false });
      } else {
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  /* ============ 取消预约 ============ */
  onCancel(e) {
    const { code, name } = e.currentTarget.dataset;
    wx.showModal({
      title: '取消预约',
      content: `确定要取消「${name}」的预约吗？取消后该时段将恢复可用。`,
      success: (r) => {
        if (!r.confirm) return;
        api.adminCancel(code)
          .then(() => {
            wx.showToast({ title: '已取消', icon: 'success' });
            this.loadAll();
          })
          .catch(err => wx.showToast({ title: (err && err.error) || '取消失败', icon: 'none' }));
      }
    });
  },

  /* ============ 改签 ============ */
  onReschedule(e) {
    const { code, name, date, slot } = e.currentTarget.dataset;
    this.setData({
      rsShow: true, rsCode: code, rsName: name,
      rsDate: date, rsSlot: slot,
      rsSlotLabels: [], rsSlotIndex: 0, rsError: ''
    });
    this.loadRsSlots(date);
  },

  async loadRsSlots(date) {
    try {
      const res = await api.getSlots(date);
      const labels = (res.slots || []).map(s => s.slot);
      this.setData({ rsSlotLabels: labels, rsSlotIndex: 0, rsError: labels.length ? '' : '该日期暂无可用时段' });
    } catch (e) {
      this.setData({ rsSlotLabels: [], rsError: '时段加载失败' });
    }
  },

  onRsDate(e) {
    const date = e.detail.value;
    this.setData({ rsDate: date, rsSlotLabels: [], rsSlotIndex: 0 });
    this.loadRsSlots(date);
  },

  onRsSlot(e) { this.setData({ rsSlotIndex: Number(e.detail.value) }); },

  closeReschedule() {
    this.setData({ rsShow: false });
  },

  async confirmReschedule() {
    const { rsCode, rsDate, rsSlotLabels, rsSlotIndex } = this.data;
    const timeSlot = rsSlotLabels[rsSlotIndex];
    if (!rsDate || !timeSlot) return this.setData({ rsError: '请选择新日期和时段' });
    this.setData({ rsLoading: true, rsError: '' });
    try {
      await api.adminReschedule(rsCode, { date: rsDate, timeSlot });
      this.setData({ rsShow: false, rsLoading: false });
      wx.showToast({ title: '改签成功', icon: 'success' });
      this.loadAll();
    } catch (e) {
      this.setData({ rsLoading: false, rsError: (e && e.error) || '改签失败' });
    }
  },

  /* ============ 查看完整手机号（短信验证码授权） ============ */
  openVerify() {
    if (this.data.unlocked) {
      wx.showModal({
        title: '已解锁',
        content: '当前已解锁查看完整手机号，确定要锁定吗？',
        success: (r) => { if (r.confirm) this.lockUnlock(); }
      });
      return;
    }
    this.setData({ verifyShow: true, verifyCode: '', verifyError: '', verifyPhone: '', verifySent: false });
  },

  closeVerify() {
    this.setData({ verifyShow: false });
  },

  onVerifyCode(e) { this.setData({ verifyCode: e.detail.value }); },

  async sendVerifyCode() {
    this.setData({ verifySending: true, verifyError: '' });
    try {
      const r = await api.adminVerifySend();
      this.setData({ verifySending: false, verifySent: true, verifyPhone: r.phoneMasked || '' });
    } catch (e) {
      this.setData({ verifySending: false, verifyError: (e && e.error) || '发送失败' });
    }
  },

  async checkVerifyCode() {
    const code = this.data.verifyCode.trim();
    if (!/^\d{6}$/.test(code)) return this.setData({ verifyError: '请输入6位验证码' });
    this.setData({ verifyError: '' });
    try {
      const r = await api.adminVerifyCheck(code);
      wx.setStorageSync('unlockToken', r.unlockToken);
      this.setData({ verifyShow: false, unlocked: true });
      wx.showToast({ title: '已解锁', icon: 'success' });
      this.loadAll();
    } catch (e) {
      this.setData({ verifyError: (e && e.error) || '验证失败' });
    }
  },

  async lockUnlock() {
    try { await api.adminVerifyLock(); } catch (e) { /* ignore */ }
    wx.removeStorageSync('unlockToken');
    this.setData({ unlocked: false });
    this.loadAll();
  },

  /* ============ 员工签到页 / 扫码签到 ============ */
  goCheckin() {
    wx.navigateTo({ url: '/pages/checkin/checkin' });
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
          if (e && e.error === 'NEED_LOGIN') {
            api.setAdminToken('');
            this.setData({ authed: false });
          } else {
            wx.showModal({ title: '错误', content: (e && e.error) || '网络错误', showCancel: false });
          }
        }
      },
      fail: () => { /* 取消 */ }
    });
  }
});
