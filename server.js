/**
 * 预约签到系统 — 飞书版
 * 数据层使用飞书多维表格 Base API，天然支持跨端数据同步
 * 前端 UI 保持不变
 */
require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const db = require('./feishu-base');
const staff = require('./staff');

// 初始化飞书配置（门店信息/maxPerSlot 也从 .env 读取）
db.init({
  appToken: process.env.FEISHU_APP_TOKEN,
  tableId:  process.env.FEISHU_TABLE_ID,
  appId:    process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  storeName: process.env.STORE_NAME,
  storeAddress: process.env.STORE_ADDRESS,
  maxPerSlot: process.env.MAX_PER_SLOT
});

const app = express();
const PORT = process.env.PORT || 3000;

// ============ 管理端账号密码登录（员工库统一管理） ============
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[warn] 未设置 ADMIN_PASSWORD，管理端使用默认密码 admin123，正式部署前请在 .env 中修改！');
}
// 首次启动播种员工账号（data/staff.json，由 .env 初始化）
try {
  staff.ensureSeed();
} catch (e) {
  console.warn('[warn] 员工账号初始化失败:', e.message);
}

// 登录会话：token -> { staff, expiry }（内存态，重启后需重新登录）
const adminSessions = new Map();
const SESSION_TTL = 12 * 3600 * 1000; // 12 小时

function getSession(req) {
  const header = req.get('x-admin-token') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!header) return null;
  const s = adminSessions.get(header);
  if (!s || Date.now() > s.expiry) {
    adminSessions.delete(header);
    return null;
  }
  return s;
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: '未登录或登录已过期，请重新登录' });
  req.staff = session.staff;
  next();
}

// ============ 短信验证码（查看顾客完整手机号授权） ============
const smsCodes = new Map();       // staffId -> { code, phone, expiresAt, attempts }
const unlockSessions = new Map(); // unlockToken -> expiry（5 分钟内可查看完整手机号）
const SMS_TTL = 5 * 60 * 1000;
const UNLOCK_TTL = 5 * 60 * 1000;

// 发送短信：配置了阿里云短信则真实发送，否则打印到控制台（开发调试用）
async function sendSms(phone, code) {
  const provider = process.env.SMS_PROVIDER;
  if (provider === 'aliyun' && process.env.SMS_ALIYUN_ACCESS_KEY_ID && process.env.SMS_ALIYUN_ACCESS_KEY_SECRET) {
    // 阿里云短信（需配置签名与模板，模板参数固定为 code）
    const crypto = require('crypto');
    const params = {
      AccessKeyId: process.env.SMS_ALIYUN_ACCESS_KEY_ID,
      Action: 'SendSms',
      Format: 'JSON',
      PhoneNumbers: phone,
      RegionId: 'cn-hangzhou',
      SignName: process.env.SMS_ALIYUN_SIGN_NAME || '',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: Date.now().toString() + Math.random(),
      SignatureVersion: '1.0',
      TemplateCode: process.env.SMS_ALIYUN_TEMPLATE_CODE || '',
      TemplateParam: JSON.stringify({ code }),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2017-05-25'
    };
    const sortedKeys = Object.keys(params).sort();
    const canonical = sortedKeys.map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    const stringToSign = 'GET&%2F&' + encodeURIComponent(canonical);
    const signature = crypto.createHmac('sha1', process.env.SMS_ALIYUN_ACCESS_KEY_SECRET + '&')
      .update(stringToSign).digest('base64');
    const url = 'https://dysmsapi.aliyuncs.com/?' + canonical + '&Signature=' + encodeURIComponent(signature);
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    if (data.Code !== 'OK') {
      throw new Error('短信发送失败: ' + (data.Message || data.Code));
    }
    console.log('[短信] 已发送验证码到', phone);
    return;
  }
  console.log(`[短信验证码][开发模式] 发送至 ${phone}：${code}（未配置 SMS_PROVIDER=aliyun，正式环境请配置）`);
}

// 请求是否已解锁完整手机号查看权限
function isUnlocked(req) {
  const t = req.get('x-unlock-token');
  if (!t) return false;
  const exp = unlockSessions.get(t);
  if (!exp || Date.now() > exp) {
    unlockSessions.delete(t);
    return false;
  }
  return true;
}

// ============ 微信小程序配置 & 工具 ============
const WECHAT_APP_ID = process.env.WECHAT_APP_ID || '';
const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET || '';
let wxAccessToken = '';
let wxTokenExpire = 0;

async function getWxAccessToken() {
  if (wxAccessToken && Date.now() < wxTokenExpire - 60000) return wxAccessToken;
  if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) throw new Error('未配置 WECHAT_APP_ID / WECHAT_APP_SECRET，无法获取微信 access_token');
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}`;
  const res = await fetchWithTimeout(url);
  const data = await res.json();
  if (data.errcode) throw new Error('获取微信 access_token 失败: ' + (data.errmsg || data.errcode));
  wxAccessToken = data.access_token;
  wxTokenExpire = Date.now() + (data.expires_in || 7200) * 1000;
  return wxAccessToken;
}

// ============ 工具函数 ============
function maskPhone(phone) {
  return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
}

// 带超时的 fetch（默认 10s）
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 本地时区日期（Asia/Shanghai），避免 UTC 错位导致凌晨时段签到/统计算错日期
function getLocalToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

// 校验日期是否在可预约范围（今天 ~ 今天+14天），与前端日历一致
function isValidReserveDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const today = getLocalToday();
  const max = new Date();
  max.setHours(0, 0, 0, 0);
  const maxStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(max.getTime() + 14 * 86400000));
  return dateStr >= today && dateStr <= maxStr;
}

// ============ 门店工具（多门店：配置跟随管理者账号，顾客端按 store 参数路由） ============
// 解析门店编码：优先 URL 参数，其次默认门店
function resolveStore(req) {
  const code = (req.query.store || req.body.store || '').trim();
  if (code) {
    const s = staff.findByStoreCode(code);
    if (s) return s.store;
  }
  // 默认门店：第一个启用的员工账号的门店
  const first = staff.listStaff().find(s => s.enabled);
  return first ? first.store : staff.DEFAULT_SLOTS && { code: 'default', name: '优品生活馆', address: '', slots: staff.DEFAULT_SLOTS, maxPerSlot: 1 };
}

// 解析活动：act 参数 → 该门店活动；缺省 → 第一个启用活动
function resolveActivity(req, store) {
  const acts = (store.activities || []).filter(a => a.enabled);
  if (!acts.length) return store.activities[0] || null;
  const actId = (req.query.act || req.body.act || '').trim();
  if (actId) {
    const hit = acts.find(a => a.id === actId);
    if (hit) return hit;
  }
  return acts[0];
}

// 管理端目标门店：super 可切换任意门店（?store=），store 角色锁定本店
// 注意：始终用实时数据（staff.json），不能用会话快照——否则创建/删除活动后列表不刷新
function resolveTargetStore(req) {
  const fresh = staff.findById(req.staff.id) || req.staff;
  if (req.staff.role === 'super') {
    const code = (req.query.store || req.body.store || '').trim();
    if (code) {
      const s = staff.findByStoreCode(code);
      if (s) return { store: s.store, staffEntry: s };
    }
  }
  return { store: fresh.store, staffEntry: fresh };
}

// ============ 中间件 ============
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 全局错误处理 wrapper
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// 简单内存限流：同 IP 每分钟最多 limit 次（防手机尾号枚举签到等滥用）
const rateBuckets = new Map();
function rateLimit(limit = 30, windowMs = 60000) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count++;
    rateBuckets.set(ip, bucket);
    if (bucket.count > limit) {
      return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
    }
    next();
  };
}

// ============ API 路由 ============

// 获取门店设置（顾客端：门店 + 活动列表 + 当前活动标题/地址/时段）
app.get('/api/settings', (req, res) => {
  const store = resolveStore(req);
  const act = resolveActivity(req, store);
  const acts = (store.activities || []).map(a => ({ id: a.id, title: a.title, enabled: a.enabled !== false }));
  res.json({
    storeCode: store.code,
    storeName: store.name,
    storeAddress: act ? act.address : '', // 兼容字段
    storePhone: store.phone || '',
    contact: (act && (act.contact || store.phone)) || '', // 活动联系方式（默认门店电话）
    activity: act ? {
      id: act.id,
      title: act.title,
      address: act.address,
      slots: act.slots,
      background: act.background || '',
      contact: act.contact || ''
    } : null,
    activities: acts
  });
});

// 获取某天的可约时段：只返回未约满且未过时间的时段（已约的时段直接隐藏，取消后恢复）
app.get('/api/slots', asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: '日期不能为空' });

  const store = resolveStore(req);
  const act = resolveActivity(req, store);
  if (!act) return res.status(400).json({ error: '该门店暂无活动' });
  const storeSlots = act.slots || [];
  const maxPerSlot = parseInt(act.maxPerSlot) || 1;

  // 一次性获取当日该门店该活动所有记录，本地统计各时段
  const allRecords = await db.getReservationsByDate(date, null, store.code, act.id);
  const countBySlot = {};
  for (const r of allRecords) {
    if (r.status !== 'cancelled') { // 状态已统一为英文，已取消记录不再占位
      countBySlot[r.timeSlot] = (countBySlot[r.timeSlot] || 0) + 1;
    }
  }

  const today = getLocalToday();
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const slots = storeSlots
    .filter(slot => {
      // 已约满（达到上限）的时段不再显示，直至取消释放
      if ((countBySlot[slot] || 0) >= maxPerSlot) return false;
      // 当天：结束时间已过的时段不再显示
      if (date === today) {
        const end = slot.split('-')[1];
        const [eh, em] = end.split(':').map(Number);
        if (nowMinutes >= eh * 60 + em) return false;
      }
      return true;
    })
    .map(slot => ({
      slot,
      max: maxPerSlot,
      current: countBySlot[slot] || 0,
      available: Math.max(0, maxPerSlot - (countBySlot[slot] || 0))
    }));

  res.json({ date, slots });
}));

// 创建预约
app.post('/api/reserve', asyncHandler(async (req, res) => {
  const { name, phone, partySize, date, timeSlot, scene, nickname, openid } = req.body;

  const store = resolveStore(req);
  const act = resolveActivity(req, store);
  if (!act) return res.status(400).json({ error: '该门店暂无可用活动' });
  const storeSlots = act.slots || [];
  const maxPerSlot = parseInt(act.maxPerSlot) || 1;

  if (!name || !name.trim()) return res.status(400).json({ error: '请输入姓名' });
  if (!phone || !phone.trim()) return res.status(400).json({ error: '请输入手机号' });
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  if (!partySize || partySize < 1) return res.status(400).json({ error: '请填写体验人数' });
  if (!date) return res.status(400).json({ error: '请选择预约日期' });
  if (!isValidReserveDate(date)) return res.status(400).json({ error: '预约日期超出可预约范围（今天起 14 天内）' });
  if (!timeSlot) return res.status(400).json({ error: '请选择预约时段' });

  // 校验时段是否属于该活动的时段列表
  if (!storeSlots.includes(timeSlot)) {
    return res.status(400).json({ error: '所选时段不可用' });
  }

  // ===== 性能优化：合并余量+查重为 1 次飞书 API 调用 =====
  const dayRecords = await db.getReservationsByDate(date, null, store.code, act.id); // 一次查当日该门店该活动所有记录

  // 本地计算时段余量（排除已取消）
  const activeRecords = dayRecords.filter(r => r.status !== 'cancelled');
  const slotCount = activeRecords.filter(r => r.timeSlot === timeSlot).length;
  if (slotCount >= maxPerSlot) {
    return res.status(400).json({ error: '该时段已约满，请选择其他时段' });
  }

  // 本地检查手机号是否已预约（排除已取消，取消后可重新预约）
  const existing = activeRecords.find(r => r.phone === phone);
  if (existing) {
    return res.status(400).json({ error: `该手机号当天已有预约（${existing.timeSlot}），请勿重复预约` });
  }

  const reservation = await db.createReservation({
    name: name.trim(),
    phone,
    partySize: parseInt(partySize),
    date,
    timeSlot,
    scene: scene || null,
    nickname: nickname || null,
    openid: openid || null,
    existingCount: slotCount,
    store: store.code,
    activity: act.id
  });

  // ===== 并发兜底：写入后二次复查，若时段超量则标记为已取消并提示 =====
  const afterCount = (await db.getReservationsByDate(date, null, store.code, act.id))
    .filter(r => r.status === 'pending' && r.timeSlot === timeSlot).length;
  if (afterCount > maxPerSlot) {
    await db.updateReservationStatus(reservation.code, 'cancelled');
    return res.status(400).json({ error: '该时段刚刚被约满，请选择其他时段' });
  }

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
      // 改为 URL 而非 data URL，微信内可长按保存
      qrCode: `/api/qrcode/${reservation.code}`,
      storeCode: store.code,
      storeName: store.name,
      activityId: act.id,
      activityTitle: act.title,
      storeAddress: act.address
    }
  });
}));

// 顾客"我的预约"：按微信 openid 或手机号查全部预约（跨日期，倒序，限当前门店）
app.get('/api/customer/reservations', asyncHandler(async (req, res) => {
  const { phone, openid } = req.query;
  const store = resolveStore(req);
  let list;
  if (openid) {
    // 微信登录后按 openid 查（小程序顾客端）
    list = await db.findReservationsByOpenid(openid, store.code);
  } else if (phone) {
    if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
    list = await db.findReservationsByPhone(phone, store.code);
  } else {
    return res.status(400).json({ error: '缺少查询参数（openid 或 phone）' });
  }

  res.json({
    storeCode: store.code,
    storeName: store.name,
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
      signinCode: r.signinCode,
      createdAt: r.created_at,
      storeName: store.name,
      storePhone: store.phone || '',
      activityId: r.activity || '',
      activityTitle: activityTitleOf(store, r.activity)
    }))
  });
}));

// 活动标题查询（无则返回空）
function activityTitleOf(store, actId) {
  if (!store || !store.activities) return '';
  const a = store.activities.find(x => x.id === actId);
  return a ? a.title : '';
}

// ============ 微信小程序：登录 & 手机号 ============
// wx.login 返回的 code → openid（用于写入飞书，识别顾客）
app.post('/api/wx/login', asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '缺少 login code' });
  if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) return res.status(500).json({ error: '服务端未配置微信 AppID/AppSecret' });

  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_APP_ID}&secret=${WECHAT_APP_SECRET}&js_code=${code}&grant_type=authorization_code`;
  const r = await fetchWithTimeout(url);
  const data = await r.json();
  if (data.errcode) return res.status(400).json({ error: '微信登录失败: ' + (data.errmsg || data.errcode) });
  res.json({ openid: data.openid });
}));

// 手机号快速验证：button open-type=getPhoneNumber 返回的 code → 明文手机号
// 注意：个人主体小程序无法使用该组件，需手动输入手机号
app.post('/api/wx/phone', asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '缺少手机号 code' });
  const token = await getWxAccessToken();
  const apiRes = await fetchWithTimeout('https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=' + token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  });
  const data = await apiRes.json();
  if (data.errcode) return res.status(400).json({ error: '获取手机号失败: ' + (data.errmsg || data.errcode) });
  res.json({ phone: data.phone_info.phoneNumber });
}));

// 二维码图片接口（返回真实 PNG，微信内可长按保存）
app.get('/api/qrcode/:code', asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const r = await db.getReservationByCode(code);
  if (!r) return res.status(404).end();

  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  // 顾客扫码 → 打开 H5 查看预约详情页（只读，不触发签到；签到由店员在管理端操作），带门店+活动参数
  const checkinUrl = `${baseUrl}/?store=${encodeURIComponent(r.store)}&act=${encodeURIComponent(r.activity || '')}&code=${code}`;
  const pngBuffer = await QRCode.toBuffer(checkinUrl, {
    width: 240, margin: 2,
    color: { dark: '#1a1a1a', light: '#ffffff' }
  });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(pngBuffer);
}));

// 按预约码查询
app.get('/api/reservation/:code', asyncHandler(async (req, res) => {
  const r = await db.getReservationByCode(req.params.code.toUpperCase());
  if (!r) return res.status(404).json({ error: '未找到该预约记录' });

  // 门店名取该记录所属门店
  const st = staff.findByStoreCode(r.store);
  const storeName = st ? st.store.name : '门店预约';
  res.json({
    code: r.code,
    name: r.name,
    phone: maskPhone(r.phone),
    partySize: r.party_size,
    date: r.date,
    timeSlot: r.time_slot,
    scene: r.scene,
    queueNumber: r.queue_number,
    signinCode: r.signinCode,
    status: r.status,
    checkedInAt: r.checked_in_at,
    store: r.store,
    storeName,
    storePhone: st ? (st.store.phone || '') : '',
    activityId: r.activity || '',
    activityTitle: st ? activityTitleOf(st.store, r.activity) : ''
  });
}));

// 签到（三种方式：手机尾号 / 签到验证码 / 扫码）— 仅店员管理端可用，且仅能签本门店预约
app.post('/api/checkin', requireAdmin, rateLimit(30, 60000), asyncHandler(async (req, res) => {
  const { code, phone, signinCode } = req.body;
  const today = getLocalToday();
  const myStore = req.staff.store.code;
  let method = '';

  const ensureMyStore = (r) => {
    if (r && r.store !== myStore) {
      return { error: '该预约不属于本门店，无法签到' };
    }
    return null;
  };

  if (signinCode && signinCode.trim()) {
    // 验证码签到（6位，仅限当天）
    const result = await db.checkinBySigninCode(signinCode.trim().toUpperCase(), today);
    if (result.error) return res.status(400).json({ error: result.error });
    const storeErr = ensureMyStore(result);
    if (storeErr) return res.status(400).json({ error: storeErr.error });
    method = '验证码';
    return finishCheckin(res, result, method);

  } else if (code && code.trim()) {
    // 扫码签到
    const r = await db.getReservationByCode(code.trim().toUpperCase());
    if (!r) return res.status(400).json({ error: '预约码无效，请检查后重试' });
    const storeErr = ensureMyStore(r);
    if (storeErr) return res.status(400).json({ error: storeErr.error });
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

    const matches = await db.findPendingByPhoneTail(tail, today, myStore);
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
      storeName: '门店预约'
    }
  });
}

// ============ 忘记密码：短信验证码自助重置（公开接口，加限流防滥用） ============
// 第一步：输入账号 → 发验证码到该账号绑定的手机号
app.post('/api/admin/forgot/send', rateLimit(5, 60000), asyncHandler(async (req, res) => {
  const username = ((req.body || {}).username || '').trim();
  if (!username) return res.status(400).json({ error: '请输入账号' });
  const s = staff.findByUsername(username);
  if (!s) return res.status(400).json({ error: '账号不存在' });
  if (!s.phone || !/^1[3-9]\d{9}$/.test(s.phone)) {
    return res.status(400).json({ error: '该账号未绑定手机号，请联系总管理员重置' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  smsCodes.set(s.id, { code, phone: s.phone, expiresAt: Date.now() + SMS_TTL, attempts: 0, purpose: 'reset' });
  try {
    await sendSms(s.phone, code);
    res.json({ success: true, phoneMasked: maskPhone(s.phone), expiresIn: SMS_TTL });
  } catch (e) {
    smsCodes.delete(s.id);
    res.status(500).json({ error: e.message });
  }
}));

// 第二步：验证码 + 新密码 → 重置
app.post('/api/admin/forgot/reset', rateLimit(10, 60000), (req, res) => {
  const { username, code, password } = req.body || {};
  const u = ((username || '').trim());
  const s = staff.findByUsername(u);
  if (!s) return res.status(400).json({ error: '账号不存在' });
  const rec = smsCodes.get(s.id);
  if (!rec || rec.purpose !== 'reset') return res.status(400).json({ error: '请先获取验证码' });
  if (rec.phone !== s.phone) { smsCodes.delete(s.id); return res.status(400).json({ error: '手机号已变更，请重新获取验证码' }); }
  if (Date.now() > rec.expiresAt) { smsCodes.delete(s.id); return res.status(400).json({ error: '验证码已过期，请重新获取' }); }
  rec.attempts++;
  if (rec.attempts > 5) { smsCodes.delete(s.id); return res.status(400).json({ error: '尝试次数过多，请重新获取验证码' }); }
  if (String(code).trim() !== rec.code) return res.status(400).json({ error: '验证码错误' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  smsCodes.delete(s.id);
  staff.updateStaff(s.id, { password: String(password) });
  res.json({ success: true, message: '密码已重置，请用新密码登录' });
});

// 总管理员免旧密码重置任意账号（门店管理 → 重置密码）
app.post('/api/admin/staff/:id/reset-password', requireAdmin, (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ error: '仅总管理员可重置密码' });
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  try {
    staff.updateStaff(req.params.id, { password: String(password) });
    res.json({ success: true, message: '密码已重置' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============ 图片上传（活动背景等，仅登录后） ============
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
try { require('fs').mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (file.originalname.match(/\.(jpg|jpeg|png|webp|gif)$/i) || [])[1] || 'png';
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (/^\.(jpg|jpeg|png|webp|gif)$/i.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error('仅支持 jpg/png/webp/gif 图片'));
  }
});
app.post('/api/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  res.json({ success: true, url: '/uploads/' + req.file.filename });
});
// 上传错误处理
app.use((err, req, res, next) => {
  if (err && (err.code === 'LIMIT_FILE_SIZE')) return res.status(400).json({ error: '图片不能超过 2MB' });
  if (err && err.message === '仅支持 jpg/png/webp/gif 图片') return res.status(400).json({ error: err.message });
  next(err);
});

// ============ 管理端账号密码登录 ============
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const s = staff.findByUsername((username || '').trim());
  if (!s || !staff.checkPassword(s, password || '')) {
    return res.status(401).json({ error: '账号或密码错误' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, { staff: s, expiry: Date.now() + SESSION_TTL });
  res.json({
    success: true, token, expiresIn: SESSION_TTL,
    staff: {
      username: s.username,
      role: s.role || 'store',
      phoneMasked: maskPhone(s.phone || ''),
      store: {
        code: s.store.code, name: s.store.name, address: s.store.address,
        activities: (s.store.activities || []).map(a => ({ id: a.id, title: a.title, enabled: a.enabled !== false }))
      }
    }
  });
});

// 退出登录
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const header = req.get('x-admin-token') || '';
  adminSessions.delete(header);
  res.json({ success: true });
});

// ============ 员工账号管理（后台统一管理；super 管全部，store 只看自己） ============
app.get('/api/admin/staff', requireAdmin, (req, res) => {
  let list = staff.listStaff();
  if (req.staff.role !== 'super') {
    // 门店角色只能看到自己（用于改密码）
    list = list.filter(s => s.id === req.staff.id);
  }
  const out = list.map(s => ({
    id: s.id, username: s.username, phone: s.phone, enabled: s.enabled, createdAt: s.createdAt,
    role: s.role || 'store',
    passwordPlain: req.staff.role === 'super' ? (s.passwordPlain || '') : undefined,
    store: {
      code: s.store.code, name: s.store.name, address: s.store.address,
      slots: s.store.slots, maxPerSlot: s.store.maxPerSlot,
      activities: (s.store.activities || []).map(a => ({ id: a.id, title: a.title, enabled: a.enabled !== false }))
    }
  }));
  res.json({ staff: out, role: req.staff.role || 'store' });
});

app.post('/api/admin/staff', requireAdmin, (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ error: '仅总管理员可添加员工' });
  try {
    const item = staff.addStaff({
      username: (req.body.username || '').trim(),
      password: req.body.password || '',
      phone: req.body.phone,
      role: req.body.role,
      store: req.body.store // {code,name,address,slots,maxPerSlot}
    });
    res.json({ success: true, staff: { id: item.id, username: item.username, phone: item.phone, role: item.role, store: item.store } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/staff/:id', requireAdmin, (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ error: '仅总管理员可删除员工' });
  try {
    staff.removeStaff(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 批量导入员工（CSV 解析后提交；返回逐条结果）— 仅总管理员
app.post('/api/admin/staff/batch', requireAdmin, (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ error: '仅总管理员可批量导入' });
  const rows = Array.isArray(req.body.staff) ? req.body.staff : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的数据' });
  if (rows.length > 200) return res.status(400).json({ error: '单次最多导入 200 条' });
  const created = [];
  const errors = [];
  rows.forEach((row, i) => {
    const username = (row.username || '').trim();
    const password = (row.password || '').trim();
    const phone = (row.phone || '').trim();
    const storeCode = (row.storeCode || '').trim();
    const storeName = (row.storeName || '').trim();
    if (!username || !password) {
      errors.push({ row: i + 1, error: '账号或密码为空' });
      return;
    }
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) {
      errors.push({ row: i + 1, error: `手机号格式不正确: ${phone}` });
      return;
    }
    if (storeCode && !/^[a-zA-Z0-9_-]+$/.test(storeCode)) {
      errors.push({ row: i + 1, error: `门店编码只能含英文/数字/下划线: ${storeCode}` });
      return;
    }
    try {
      const item = staff.addStaff({
        username, password,
        phone,
        store: { code: storeCode, name: storeName }
      });
      created.push({ row: i + 1, username: item.username, storeCode: item.store.code });
    } catch (e) {
      errors.push({ row: i + 1, error: e.message });
    }
  });
  res.json({ success: true, created, errors });
});

// 更新员工：super 可改任意；store 只能改自己（密码/手机号/本店活动配置），不能改角色
app.put('/api/admin/staff/:id', requireAdmin, (req, res) => {
  try {
    const targetId = req.params.id;
    if (req.staff.role !== 'super' && targetId !== req.staff.id) {
      return res.status(403).json({ error: '仅可修改自己的账号' });
    }
    const patch = {};
    if (req.body.password) {
      // 修改密码需验证旧密码（super 重置无明文旧账号时可不传）
      const target = staff.findById(targetId);
      if (target && req.body.oldPassword !== undefined) {
        if (!staff.checkPassword(target, req.body.oldPassword)) {
          return res.status(400).json({ error: '旧密码不正确' });
        }
      }
      patch.password = req.body.password;
    }
    if (req.body.phone !== undefined) patch.phone = req.body.phone;
    if (req.body.role && req.staff.role === 'super') patch.role = req.body.role;
    if (req.body.store !== undefined && (req.staff.role === 'super' || targetId === req.staff.id)) {
      patch.store = req.body.store;
    }
    const item = staff.updateStaff(targetId, patch);
    res.json({ success: true, staff: { id: item.id, username: item.username, phone: item.phone, role: item.role, store: item.store } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============ 活动管理（super 可管任意门店；store 只能管本店） ============
app.get('/api/admin/activities', requireAdmin, (req, res) => {
  const { store } = resolveTargetStore(req);
  res.json({
    storeCode: store.code,
    activities: (store.activities || []).map(a => ({ id: a.id, title: a.title, address: a.address, slots: a.slots, maxPerSlot: a.maxPerSlot, enabled: a.enabled !== false, background: a.background || '', contact: a.contact || '', createdAt: a.createdAt }))
  });
});

app.post('/api/admin/activities', requireAdmin, (req, res) => {
  const { staffEntry } = resolveTargetStore(req);
  try {
    const act = staff.addActivity(staffEntry, {
      title: req.body.title,
      address: req.body.address,
      slots: req.body.slots,
      maxPerSlot: req.body.maxPerSlot,
      background: req.body.background,
      contact: req.body.contact
    });
    res.json({ success: true, activity: act });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/admin/activities/:actId', requireAdmin, (req, res) => {
  const { staffEntry } = resolveTargetStore(req);
  try {
    const act = staff.updateActivity(staffEntry, req.params.actId, {
      title: req.body.title,
      address: req.body.address,
      slots: req.body.slots,
      maxPerSlot: req.body.maxPerSlot,
      enabled: req.body.enabled,
      background: req.body.background,
      contact: req.body.contact
    });
    res.json({ success: true, activity: act });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/admin/activities/:actId', requireAdmin, (req, res) => {
  const { staffEntry } = resolveTargetStore(req);
  try {
    const activities = staff.removeActivity(staffEntry, req.params.actId);
    res.json({ success: true, activities: activities.map(a => ({ id: a.id, title: a.title, enabled: a.enabled !== false })) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 一键同步活动：把当前门店的活动复制到指定门店（仅总管理员；同标题活动跳过）
app.post('/api/admin/activities/sync', requireAdmin, (req, res) => {
  if (req.staff.role !== 'super') return res.status(403).json({ error: '仅总管理员可同步活动' });
  const { store } = resolveTargetStore(req);
  const targets = Array.isArray(req.body.targetStores) ? req.body.targetStores : [];
  if (!targets.length) return res.status(400).json({ error: '请选择目标门店' });
  const sourceActs = (store.activities || []).filter(a => a.enabled !== false);
  if (!sourceActs.length) return res.status(400).json({ error: '当前门店没有可同步的活动' });
  const results = [];
  for (const code of targets) {
    const s = staff.findByStoreCode(code);
    if (!s) { results.push({ storeCode: code, error: '门店不存在' }); continue; }
    if (s.store.code === store.code) { results.push({ storeCode: code, error: '不能同步到自身' }); continue; }
    const existingTitles = (s.store.activities || []).map(a => a.title);
    let added = 0, skipped = 0;
    for (const act of sourceActs) {
      if (existingTitles.includes(act.title)) { skipped++; continue; }
      staff.addActivity(s, { title: act.title, address: act.address, slots: act.slots, maxPerSlot: act.maxPerSlot });
      added++;
    }
    results.push({ storeCode: code, added, skipped });
  }
  res.json({ success: true, results });
});

// 活动二维码：?store=X&act=Y → PNG（H5 活动页链接）
app.get('/api/activity-qr', asyncHandler(async (req, res) => {
  const store = resolveStore(req);
  const act = resolveActivity(req, store);
  if (!act) return res.status(404).json({ error: '活动不存在' });
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const link = `${baseUrl}/?store=${encodeURIComponent(store.code)}&act=${encodeURIComponent(act.id)}`;
  const pngBuffer = await QRCode.toBuffer(link, {
    width: 320, margin: 2,
    color: { dark: '#1a1a1a', light: '#ffffff' }
  });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(pngBuffer);
}));

// ============ 查看顾客完整手机号：短信验证码授权 ============
// 发送验证码到当前登录员工的绑定手机号
app.post('/api/admin/verify/send', requireAdmin, asyncHandler(async (req, res) => {
  // 实时读取员工库，避免会话快照过期
  const s = staff.findById(req.staff.id) || req.staff;
  if (!s.phone || !/^1[3-9]\d{9}$/.test(s.phone)) {
    return res.status(400).json({ error: '当前账号未绑定手机号，请先在员工管理中配置' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  smsCodes.set(s.id, { code, phone: s.phone, expiresAt: Date.now() + SMS_TTL, attempts: 0 });
  try {
    await sendSms(s.phone, code);
    res.json({ success: true, phoneMasked: maskPhone(s.phone), expiresIn: SMS_TTL });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// 校验验证码 → 签发 5 分钟解锁令牌（此后可查看顾客完整手机号）
app.post('/api/admin/verify/check', requireAdmin, (req, res) => {
  const s = staff.findById(req.staff.id) || req.staff;
  const { code } = req.body || {};
  const rec = smsCodes.get(s.id);
  if (!rec) return res.status(400).json({ error: '请先获取验证码' });
  if (rec.phone !== s.phone) {
    smsCodes.delete(s.id);
    return res.status(400).json({ error: '手机号已变更，请重新获取验证码' });
  }
  if (Date.now() > rec.expiresAt) {
    smsCodes.delete(s.id);
    return res.status(400).json({ error: '验证码已过期，请重新获取' });
  }
  rec.attempts++;
  if (rec.attempts > 5) {
    smsCodes.delete(s.id);
    return res.status(400).json({ error: '尝试次数过多，请重新获取验证码' });
  }
  if (String(code).trim() !== rec.code) {
    return res.status(400).json({ error: '验证码错误' });
  }
  smsCodes.delete(s.id);
  const unlockToken = crypto.randomBytes(24).toString('hex');
  unlockSessions.set(unlockToken, Date.now() + UNLOCK_TTL);
  res.json({ success: true, unlockToken, expiresIn: UNLOCK_TTL });
});

// 手动锁定（提前结束查看权限）
app.post('/api/admin/verify/lock', requireAdmin, (req, res) => {
  const t = req.get('x-unlock-token');
  if (t) unlockSessions.delete(t);
  res.json({ success: true });
});

// ============ 管理端 API（全部要求登录会话，数据限本门店） ============

app.get('/api/admin/stats', requireAdmin, asyncHandler(async (req, res) => {
  const { date, act } = req.query;
  const filterDate = date || getLocalToday();
  const { store } = resolveTargetStore(req);
  // 按活动拆分统计：一次拉当日该门店记录，本地分组；act 参数则只统计该活动
  let dayRecords = await db.getReservationsByDate(filterDate, null, store.code);
  if (act) dayRecords = dayRecords.filter(r => (r.activity || '') === act);
  const stats = { total: dayRecords.length, pending: 0, checkedIn: 0, cancelled: 0, byActivity: [] };
  const actMap = {};
  for (const a of (store.activities || [])) actMap[a.id] = a.title;
  const actAgg = {};
  for (const r of dayRecords) {
    if (r.status === 'pending') stats.pending++;
    else if (r.status === 'checked_in') stats.checkedIn++;
    else if (r.status === 'cancelled') stats.cancelled++;
    const key = r.activity || '';
    if (!actAgg[key]) actAgg[key] = { total: 0, pending: 0, checkedIn: 0, cancelled: 0 };
    const g = actAgg[key];
    g.total++;
    if (r.status === 'pending') g.pending++;
    else if (r.status === 'checked_in') g.checkedIn++;
    else if (r.status === 'cancelled') g.cancelled++;
  }
  stats.byActivity = (store.activities || [])
    .map(a => ({ activityId: a.id, activityTitle: a.title, ...(actAgg[a.id] || { total: 0, pending: 0, checkedIn: 0, cancelled: 0 }) }))
    .filter(a => a.total > 0);
  res.json({ date: filterDate, storeCode: store.code, ...stats });
}));

app.get('/api/admin/reservations', requireAdmin, asyncHandler(async (req, res) => {
  const { date, status: statusFilter, search, act } = req.query;
  const filterDate = date || getLocalToday();
  const { store: myStore } = resolveTargetStore(req);

  let list;
  if (search) {
    list = await db.searchReservations(filterDate, search, myStore.code);
  } else {
    list = await db.getReservationsByDate(filterDate, statusFilter || null, myStore.code);
  }
  if (act) list = list.filter(r => (r.activity || '') === act);

  res.json({
    storeCode: myStore.code,
    reservations: list.map(r => ({
      code: r.code,
      name: r.name,
      phone: isUnlocked(req) ? r.phone : maskPhone(r.phone), // 短信授权解锁后才返回完整手机号
      phoneUnlocked: isUnlocked(req),
      partySize: r.party_size,
      date: r.date,
      timeSlot: r.time_slot,
      scene: r.scene,
      queueNumber: r.queue_number,
      status: r.status, // 英文状态，前端 statusMap 直接可用
      signinCode: r.signin_code,
      createdAt: r.created_at,
      checkedInAt: r.checked_in_at
    }))
  });
}));

app.get('/api/admin/queue', requireAdmin, asyncHandler(async (req, res) => {
  const today = getLocalToday();
  const { store: myStore } = resolveTargetStore(req);
  const act = req.query.act || '';

  let pending = await db.getPendingByDate(today, myStore.code);
  let checkedIn = await db.getCheckedInByDate(today, myStore.code);
  if (act) {
    pending = pending.filter(r => (r.activity || '') === act);
    checkedIn = checkedIn.filter(r => (r.activity || '') === act);
  }

  res.json({
    storeCode: myStore.code,
    pending: pending.map(r => ({
      code: r.code, name: r.name, phone: isUnlocked(req) ? r.phone : maskPhone(r.phone),
      partySize: r.party_size, timeSlot: r.time_slot,
      queueNumber: r.queue_number, status: 'pending'
    })),
    checkedIn: checkedIn.map(r => ({
      code: r.code, name: r.name, phone: isUnlocked(req) ? r.phone : maskPhone(r.phone),
      partySize: r.party_size, timeSlot: r.time_slot,
      queueNumber: r.queue_number, status: 'checked_in',
      checkedInAt: r.checked_in_at
    }))
  });
}));

// 管理端：按手机号查该顾客全部预约（跨日期，限本门店）
app.get('/api/admin/customer/:phone', requireAdmin, asyncHandler(async (req, res) => {
  const phone = req.params.phone;
  if (!/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  const { store } = resolveTargetStore(req);
  const list = await db.findReservationsByPhone(phone, store.code);
  res.json({
    storeCode: store.code,
    phone: isUnlocked(req) ? phone : maskPhone(phone),
    reservations: list.map(r => ({
      code: r.code,
      name: r.name,
      phone: isUnlocked(req) ? r.phone : maskPhone(r.phone),
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

// 取消预约（仅本门店）
app.delete('/api/admin/reservation/:code', requireAdmin, asyncHandler(async (req, res) => {
  const code = req.params.code.toUpperCase();
  const r = await db.getReservationByCode(code);
  if (!r) return res.status(404).json({ error: '未找到该预约记录' });
  const { store: myStore } = resolveTargetStore(req);
  if (r.store !== myStore.code) return res.status(400).json({ error: '该预约不属于当前门店' });
  if (r.status === 'checked_in') return res.status(400).json({ error: '已签到的预约不可取消' });
  if (r.status === 'cancelled') return res.status(400).json({ error: '该预约已被取消' });

  await db.updateReservationStatus(code, 'cancelled');
  res.json({ success: true, message: '已取消预约，时段已恢复' });
}));

// 改签
app.put('/api/admin/reservation/:code', requireAdmin, asyncHandler(async (req, res) => {
  const { date, timeSlot } = req.body;
  if (!date) return res.status(400).json({ error: '请选择新日期' });
  if (!timeSlot) return res.status(400).json({ error: '请选择新时段' });
  if (!isValidReserveDate(date)) return res.status(400).json({ error: '目标日期超出可预约范围' });

  const code = req.params.code.toUpperCase();
  const r = await db.getReservationByCode(code);
  if (!r) return res.status(404).json({ error: '未找到该预约记录' });
  const { store: myStore } = resolveTargetStore(req);
  if (r.store !== myStore.code) return res.status(400).json({ error: '该预约不属于当前门店' });
  if (r.status === 'checked_in') return res.status(400).json({ error: '已签到的预约不可改签' });
  if (r.status === 'cancelled') return res.status(400).json({ error: '已取消的预约不可改签' });
  if (!(myStore.activities || []).length) return res.status(400).json({ error: '该门店暂无活动' });
  // 时段校验用预约所属活动的时段（门店层 slots 已弃用）
  const rAct = (myStore.activities || []).find(a => a.id === r.activity) || myStore.activities[0];
  const actSlots = rAct.slots || [];
  if (!actSlots.includes(timeSlot)) {
    return res.status(400).json({ error: '所选时段不可用' });
  }

  // 目标时段容量检查（排除已取消，按活动过滤）
  const maxPerSlot = parseInt(rAct.maxPerSlot) || 1;
  const dayRecords = await db.getReservationsByDate(date, null, myStore.code, r.activity);
  const active = dayRecords.filter(x => x.status !== 'cancelled' && x.code !== code);
  const slotCount = active.filter(x => x.timeSlot === timeSlot).length;
  if (slotCount >= maxPerSlot) {
    return res.status(400).json({ error: '目标时段已约满，请选择其他时段' });
  }

  // 同手机号同日冲突检查（改签后不应与自己当天其他预约重复）
  const selfConflict = active.find(x => x.phone === r.phone && x.date === date);
  if (selfConflict) {
    return res.status(400).json({ error: `该手机号在 ${date} 已有预约（${selfConflict.timeSlot}），不能改签至此日期` });
  }

  await db.updateReservationDateSlot(code, date, timeSlot);
  res.json({ success: true, message: '改签成功', reservation: { date, timeSlot, name: r.name } });
}));

// ============ 门店二维码（按门店生成：预约码 → 带 store 参数的 H5 页） ============
app.get('/api/store-qr', asyncHandler(async (req, res) => {
  const store = resolveStore(req);
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const act0 = resolveActivity(req, store);
  const reserveUrl = `${baseUrl}/?store=${encodeURIComponent(store.code)}&act=${encodeURIComponent(act0 ? act0.id : "")}`;
  const adminUrl = `${baseUrl}/admin`;

  const [reserve, checkin] = await Promise.all([
    QRCode.toDataURL(reserveUrl, { width: 320, margin: 2, color: { dark: '#1a1a1a', light: '#ffffff' } }),
    QRCode.toDataURL(adminUrl, { width: 320, margin: 2, color: { dark: '#1a1a1a', light: '#ffffff' } })
  ]);
  res.json({ storeCode: store.code, storeName: store.name, reserve, checkin });
}));

app.get('/store-qr', (req, res) => res.sendFile(path.join(__dirname, 'public', 'store-qr.html')));

// ============ 页面路由 ============
// /admin 管理后台（数据接口已鉴权，页面本身引导登录）
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// /checkin 已并入管理端：旧二维码/旧链接扫码后跳转管理后台（需口令，店员签到）
app.get('/checkin', (req, res) => res.redirect('/admin'));

// 404 → JSON（必须放在所有路由之后）
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  next();
});

// ============ 统一错误处理 ============
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.path, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误：' + err.message });
});

// ============ 启动服务 ============
async function startServer() {
  // 启动检查并自动创建飞书新字段（微信昵称 / openid / 门店）
  try {
    await db.ensureFields();
  } catch (e) {
    console.warn('[warn] 飞书字段检查失败:', e.message);
  }

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
    console.log('   管理端:     各管理者账号登录后管理本门店（标题/时段在员工管理中配置）');
    console.log('');
  });
}

startServer();
