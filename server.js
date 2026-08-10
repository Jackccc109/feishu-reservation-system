/**
 * 预约签到系统 — 飞书版
 * 数据层使用飞书多维表格 Base API，天然支持跨端数据同步
 * 前端 UI 保持不变
 */
require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const db = require('./feishu-base');

// 初始化飞书配置
db.init({
  appToken: process.env.FEISHU_APP_TOKEN,
  tableId:  process.env.FEISHU_TABLE_ID,
  appId:    process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET
});

const app = express();
const PORT = process.env.PORT || 3000;

// ============ 工具函数 ============
function maskPhone(phone) {
  return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
}

/**
 * 统一生成 20 分钟粒度的时段列表（10:00-22:00）
 */
function getTimeSlotsForDate() {
  const slots = [];
  let h = 10, m = 0;
  const endMin = 22 * 60;
  const pad = v => String(v).padStart(2, '0');
  while (h * 60 + m < endMin) {
    const nextM = m + 20;
    const nh = nextM >= 60 ? h + 1 : h;
    const nm = nextM >= 60 ? nextM - 60 : nextM;
    slots.push(`${pad(h)}:${pad(m)}-${pad(nh)}:${pad(nm)}`);
    h = nh;
    m = nm;
  }
  return slots;
}

// ============ 中间件 ============
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 全局错误处理 wrapper
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// ============ API 路由 ============

// 获取门店设置
app.get('/api/settings', (req, res) => {
  const settings = db.getSettings();
  res.json({
    storeName: settings.storeName,
    storeAddress: settings.storeAddress,
    timeSlots: getTimeSlotsForDate()
  });
});

// 获取某天的时段余量
app.get('/api/slots', asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: '日期不能为空' });

  const timeSlots = getTimeSlotsForDate();
  const maxPerSlot = parseInt(db.getSetting('maxPerSlot')) || 1;

  // 批量查询所有时段的余量
  const slots = [];
  for (const slot of timeSlots) {
    const current = await db.getSlotAvailability(date, slot);
    slots.push({ slot, max: maxPerSlot, current, available: Math.max(0, maxPerSlot - current) });
  }

  res.json({ date, slots });
}));

// 创建预约
app.post('/api/reserve', asyncHandler(async (req, res) => {
  const { name, phone, partySize, date, timeSlot, scene } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: '请输入姓名' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (!partySize || partySize < 1) return res.status(400).json({ error: '请填写体验人数' });
  if (!date) return res.status(400).json({ error: '请选择预约日期' });
  if (!timeSlot) return res.status(400).json({ error: '请选择预约时段' });

  // 校验时段是否有效
  const validSlots = getTimeSlotsForDate();
  if (!validSlots.includes(timeSlot)) {
    return res.status(400).json({ error: '所选时段不可用' });
  }

  // 检查时段余量
  const maxPerSlot = parseInt(db.getSetting('maxPerSlot')) || 1;
  const slotCount = await db.getSlotAvailability(date, timeSlot);
  if (slotCount >= maxPerSlot) {
    return res.status(400).json({ error: '该时段已约满，请选择其他时段' });
  }

  // 同一手机号当天是否已预约
  const existing = await db.findExistingPending(phone, date);
  if (existing) {
    return res.status(400).json({ error: `该手机号当天已有预约（${existing.time_slot}），请勿重复预约` });
  }

  const reservation = await db.createReservation({
    name: name.trim(),
    phone,
    partySize: parseInt(partySize),
    date,
    timeSlot,
    scene: scene || null
  });

  const settings = db.getSettings();

  // 生成二维码（指向服务器地址）
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const checkinUrl = `${baseUrl}/checkin?code=${reservation.code}`;
  const qrDataUrl = await QRCode.toDataURL(checkinUrl, {
    width: 240, margin: 2,
    color: { dark: '#1a1a1a', light: '#ffffff' }
  });

  res.json({
    success: true,
    reservation: {
      id: reservation.id,
      code: reservation.code,
      signinCode: reservation.signinCode,
      queueNumber: reservation.queueNumber,
      name: reservation.name,
      partySize: reservation.partySize,
      date,
      timeSlot,
      scene: reservation.scene,
      ahead: 0,
      qrCode: qrDataUrl,
      storeName: settings.storeName,
      storeAddress: settings.storeAddress
    }
  });
}));

// 按预约码查询
app.get('/api/reservation/:code', asyncHandler(async (req, res) => {
  const r = await db.getReservationByCode(req.params.code.toUpperCase());
  if (!r) return res.status(404).json({ error: '未找到该预约记录' });

  const settings = db.getSettings();
  res.json({
    code: r.code,
    name: r.name,
    phone: maskPhone(r.phone),
    partySize: r.party_size,
    date: r.date,
    timeSlot: r.time_slot,
    scene: r.scene,
    queueNumber: r.queue_number,
    status: r.status,
    checkedInAt: r.checked_in_at,
    storeName: settings.storeName
  });
}));

// 签到（三种方式：手机尾号 / 签到验证码 / 扫码）
app.post('/api/checkin', asyncHandler(async (req, res) => {
  const { code, phone, signinCode } = req.body;
  const today = new Date().toISOString().split('T')[0];
  let method = '';

  if (signinCode && signinCode.trim()) {
    // 验证码签到
    const result = await db.checkinBySigninCode(signinCode.trim().toUpperCase());
    if (result.error) return res.status(400).json({ error: result.error });
    method = '验证码';
    return finishCheckin(res, result, method);

  } else if (code && code.trim()) {
    // 扫码签到
    const r = await db.getReservationByCode(code.trim().toUpperCase());
    if (!r) return res.status(400).json({ error: '预约码无效，请检查后重试' });
    if (r.status === 'cancelled') return res.status(400).json({ error: '该预约已被取消' });
    if (r.status === 'checked_in') return res.status(400).json({ error: '该预约已签到' });
    if (r.date !== today) return res.status(400).json({ error: `该预约日期为 ${r.date}，仅限当天签到` });

    await db.updateReservationStatus(r.code, 'checked_in', new Date().toISOString());
    method = '扫码';
    return finishCheckin(res, { ...r, status: 'checked_in' }, method);

  } else if (phone && phone.trim()) {
    // 手机尾号签到
    const tail = phone.trim();
    if (!/^\d{4}$/.test(tail)) return res.status(400).json({ error: '请输入手机尾号后4位' });

    const matches = await db.findPendingByPhoneTail(tail, today);
    if (matches.length === 0) return res.status(400).json({ error: '未找到匹配的待签到预约' });
    if (matches.length > 1) return res.status(400).json({ error: `找到${matches.length}个匹配预约，请使用验证码签到` });

    const r = matches[0];
    await db.updateReservationStatus(r.code, 'checked_in', new Date().toISOString());
    method = '手机尾号';
    return finishCheckin(res, { ...r, status: 'checked_in' }, method);

  } else {
    return res.status(400).json({ error: '请选择签到方式' });
  }
}));

function finishCheckin(res, r, method) {
  const settings = db.getSettings();
  res.json({
    success: true,
    message: '签到成功！',
    method,
    reservation: {
      code: r.code,
      name: r.name,
      partySize: r.party_size,
      date: r.date,
      timeSlot: r.time_slot,
      queueNumber: r.queue_number,
      ahead: 0,
      storeName: settings.storeName
    }
  });
}

// ============ 管理端 API ============

app.get('/api/admin/stats', asyncHandler(async (req, res) => {
  const { date } = req.query;
  const filterDate = date || new Date().toISOString().split('T')[0];
  const stats = await db.getStats(filterDate);
  res.json({ date: filterDate, ...stats });
}));

app.get('/api/admin/reservations', asyncHandler(async (req, res) => {
  const { date, status: statusFilter, search } = req.query;
  const filterDate = date || new Date().toISOString().split('T')[0];

  let list;
  if (search) {
    list = await db.searchReservations(filterDate, search);
  } else {
    list = await db.getReservationsByDate(filterDate, statusFilter || null);
  }

  if (statusFilter) {
    const statusMap = {
      'pending': 'pending',
      'checked_in': 'checked_in',
      'cancelled': 'cancelled'
    };
    const target = statusMap[statusFilter] || statusFilter;
    list = list.filter(r => r.status === target);
  }

  res.json({
    reservations: list.map(r => ({
      code: r.code,
      name: r.name,
      phone: maskPhone(r.phone),
      partySize: r.party_size,
      date: r.date,
      timeSlot: r.time_slot,
      scene: r.scene,
      queueNumber: r.queue_number,
      status: r.status,
      signinCode: r.signin_code,
      createdAt: r.created_at,
      checkedInAt: r.checked_in_at
    }))
  });
}));

app.get('/api/admin/queue', asyncHandler(async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const pending = await db.getPendingByDate(today);
  const checkedIn = await db.getCheckedInByDate(today);

  res.json({
    pending: pending.map(r => ({
      code: r.code, name: r.name, phone: r.phone,
      partySize: r.party_size, timeSlot: r.time_slot,
      queueNumber: r.queue_number, status: 'pending'
    })),
    checkedIn: checkedIn.map(r => ({
      code: r.code, name: r.name, phone: r.phone,
      partySize: r.party_size, timeSlot: r.time_slot,
      queueNumber: r.queue_number, status: 'checked_in',
      checkedInAt: r.checked_in_at
    }))
  });
}));

// 取消预约
app.delete('/api/admin/reservation/:code', asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const r = await db.getReservationByCode(code);
  if (!r) return res.status(404).json({ error: '未找到该预约记录' });
  if (r.status === 'checked_in') return res.status(400).json({ error: '已签到的预约不可取消' });
  if (r.status === 'cancelled') return res.status(400).json({ error: '该预约已被取消' });

  await db.updateReservationStatus(code, 'cancelled');
  res.json({ success: true, message: '已取消预约，时段已恢复' });
}));

// 改签
app.put('/api/admin/reservation/:code', asyncHandler(async (req, res) => {
  const { date, timeSlot } = req.body;
  if (!date) return res.status(400).json({ error: '请选择新日期' });
  if (!timeSlot) return res.status(400).json({ error: '请选择新时段' });

  const code = req.params.code.toUpperCase();
  const r = await db.getReservationByCode(code);
  if (!r) return res.status(404).json({ error: '未找到该预约记录' });
  if (r.status === 'checked_in') return res.status(400).json({ error: '已签到的预约不可改签' });
  if (r.status === 'cancelled') return res.status(400).json({ error: '已取消的预约不可改签' });

  const validSlots = getTimeSlotsForDate();
  if (!validSlots.includes(timeSlot)) {
    return res.status(400).json({ error: '所选时段不可用' });
  }

  const maxPerSlot = parseInt(db.getSetting('maxPerSlot')) || 1;
  const slotCount = await db.getSlotAvailability(date, timeSlot);
  if (slotCount >= maxPerSlot) {
    return res.status(400).json({ error: '目标时段已约满，请选择其他时段' });
  }

  await db.updateReservationDateSlot(code, date, timeSlot);
  res.json({ success: true, message: '改签成功', reservation: { date, timeSlot, name: r.name } });
}));

// ============ 门店固定二维码（预约码 + 签到码） ============
let storeQRCodes = { reserve: '', checkin: '' };

async function generateStoreQRCodes() {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const reserveUrl = `${baseUrl}/`;
  const checkinUrl = `${baseUrl}/checkin`;

  storeQRCodes.reserve = await QRCode.toDataURL(reserveUrl, {
    width: 320, margin: 2,
    color: { dark: '#1a1a1a', light: '#ffffff' }
  });

  storeQRCodes.checkin = await QRCode.toDataURL(checkinUrl, {
    width: 320, margin: 2,
    color: { dark: '#1a1a1a', light: '#ffffff' }
  });
}

app.get('/api/store-qr', (req, res) => {
  res.json(storeQRCodes);
});

app.get('/store-qr', (req, res) => res.sendFile(path.join(__dirname, 'public', 'store-qr.html')));

// ============ 页面路由 ============
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/checkin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ============ 启动服务 ============
async function startServer() {
  await generateStoreQRCodes();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ========================================');
    console.log('   预约签到系统已启动（飞书多维表格版）');
    console.log('  ========================================');
    console.log('');
    console.log('   预约页面:   http://localhost:' + PORT);
    console.log('   签到页面:   http://localhost:' + PORT + '/checkin');
    console.log('   管理后台:   http://localhost:' + PORT + '/admin');
    console.log('   门店二维码: http://localhost:' + PORT + '/store-qr');
    console.log('');
  });
}

startServer();
