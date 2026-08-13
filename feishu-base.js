/**
 * 飞书多维表格 Base API 封装
 * 替代 SQLite，所有数据存储在飞书多维表格中，天然支持跨端数据同步
 *
 * 飞书 API 文档: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1
 */

const crypto = require('crypto');

// ===== 配置（从环境变量读取） =====
let APP_TOKEN;     // 多维表格 ID（从飞书 Base URL 中获取）
let TABLE_ID;      // 数据表 ID
let ACCESS_TOKEN;  // tenant_access_token
let TOKEN_EXPIRES; // token 过期时间戳
let APP_ID;
let APP_SECRET;

function init(config) {
  APP_TOKEN = config.appToken;
  TABLE_ID = config.tableId;
  APP_ID = config.appId;
  APP_SECRET = config.appSecret;
}

const BASE_URL = 'https://open.feishu.cn/open-apis/bitable/v1';

// ===== 飞书字段名（用户创建 Base 时使用的中文字段名） =====
const FIELDS = {
  code:         '预约码',        // 文本
  signinCode:   '签到验证码',    // 文本
  name:         '姓名',          // 文本
  phone:        '手机号',        // 文本
  partySize:    '到店人数',      // 数字
  date:         '预约日期',      // 文本 (YYYY-MM-DD)
  timeSlot:     '预约时段',      // 文本
  scene:        '体验场景',      // 文本
  queueNumber:  '排队号',        // 数字
  status:       '状态',          // 文本 (待签到/已签到/已取消)
  createdAt:    '创建时间',      // 文本 (ISO)
  checkedInAt:  '签到时间',      // 文本 (ISO 或空)
  nickname:     '微信昵称',      // 文本
  openid:       'openid',         // 文本
};

// ===== Token 管理 =====
async function getAccessToken() {
  if (ACCESS_TOKEN && TOKEN_EXPIRES && Date.now() < TOKEN_EXPIRES - 300000) {
    return ACCESS_TOKEN;
  }

  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET })
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取飞书 access_token 失败: ${data.msg}`);
  }

  ACCESS_TOKEN = data.tenant_access_token;
  TOKEN_EXPIRES = Date.now() + data.expire * 1000;
  return ACCESS_TOKEN;
}

// ===== 通用 API 请求 =====
async function apiRequest(method, path, body = null, retries = 2) {
  const token = await getAccessToken();
  const url = `${BASE_URL}${path}`;

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  };

  if (body) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(url, opts);
    const data = await res.json();

    if (data.code === 0) return data.data;

    // 写冲突（并发）→ 稍后重试
    if (data.code === 1254291 && retries > 0) {
      await sleep(800);
      return apiRequest(method, path, body, retries - 1);
    }

    // token 过期 → 刷新后重试
    if (data.code === 99991663 || data.code === 99991664) {
      ACCESS_TOKEN = null;
      if (retries > 0) return apiRequest(method, path, body, retries - 1);
    }

    throw new Error(`飞书 API 错误 [${data.code}]: ${data.msg}`);
  } catch (err) {
    if (err.message.startsWith('飞书 API 错误')) throw err;
    throw new Error(`网络异常: ${err.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 记录转换：飞书格式 → 内部格式 =====
function recordToInternal(record) {
  const f = record.fields;
  return {
    recordId:   record.record_id,
    id:         f[FIELDS.code] || record.record_id,
    code:       f[FIELDS.code] || '',
    signinCode: (f[FIELDS.signinCode] || '').toString(),
    name:       f[FIELDS.name] || '',
    phone:      f[FIELDS.phone] || '',
    nickname:   f[FIELDS.nickname] || '',
    openid:     f[FIELDS.openid] || '',
    partySize:  parseInt(f[FIELDS.partySize]) || 1,
    party_size: parseInt(f[FIELDS.partySize]) || 1,
    date:       f[FIELDS.date] || '',
    timeSlot:   f[FIELDS.timeSlot] || '',
    time_slot:  f[FIELDS.timeSlot] || '',
    scene:      f[FIELDS.scene] || null,
    queueNumber: parseInt(f[FIELDS.queueNumber]) || 1,
    queue_number: parseInt(f[FIELDS.queueNumber]) || 1,
    status:     f[FIELDS.status] || 'pending',
    signin_code: (f[FIELDS.signinCode] || '').toString(),
    created_at: f[FIELDS.createdAt] || '',
    createdAt:  f[FIELDS.createdAt] || '',
    checked_in_at: f[FIELDS.checkedInAt] || null,
    checkedInAt: f[FIELDS.checkedInAt] || null
  };
}

// ===== 列出记录（支持筛选） =====
async function listRecords(filter = null, sort = null, pageSize = 500, pageToken = null) {
  const params = new URLSearchParams();
  params.set('page_size', pageSize);
  if (filter) params.set('filter', filter);
  if (sort) params.set('sort', sort);
  if (pageToken) params.set('page_token', pageToken);

  const data = await apiRequest(
    'GET',
    `/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?${params.toString()}`
  );

  return {
    records: (data.items || []).map(recordToInternal),
    hasMore: data.has_more || false,
    pageToken: data.page_token || null
  };
}

// ===== 获取全部记录（自动分页） =====
async function listAllRecords(filter = null, sort = null) {
  let allRecords = [];
  let pageToken = null;

  do {
    const result = await listRecords(filter, sort, 500, pageToken);
    allRecords = allRecords.concat(result.records);
    pageToken = result.pageToken;
  } while (pageToken);

  return allRecords;
}

// ===== 创建记录 =====
async function createRecord(fields) {
  const body = { fields: {} };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) {
      body.fields[key] = value;
    }
  }

  const data = await apiRequest(
    'POST',
    `/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`,
    body
  );

  return {
    record_id: data.record.record_id,
    ...recordToInternal(data.record)
  };
}

// ===== 更新记录 =====
async function updateRecord(recordId, fields) {
  const body = { fields: {} };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) {
      body.fields[key] = value;
    }
  }

  const data = await apiRequest(
    'PUT',
    `/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/${recordId}`,
    body
  );

  return recordToInternal(data.record);
}

// ===== 删除记录 =====
async function deleteRecord(recordId) {
  return apiRequest(
    'DELETE',
    `/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/${recordId}`
  );
}

// ===== 确保飞书表格包含所需字段（幂等，启动时可调用） =====
async function ensureFields() {
  const needed = [
    { name: FIELDS.nickname, type: 1 },  // 文本
    { name: FIELDS.openid, type: 1 }     // 文本
  ];
  try {
    const data = await apiRequest('GET', `/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields?page_size=200`);
    const existing = (data.items || []).map(f => f.field_name);
    for (const f of needed) {
      if (!existing.includes(f.name)) {
        await apiRequest('POST', `/apps/${APP_TOKEN}/tables/${TABLE_ID}/fields`, {
          field_name: f.name,
          type: f.type
        });
        console.log('  + 新增飞书字段:', f.name);
      }
    }
  } catch (e) {
    console.warn('  [warn] 检查/新增飞书字段失败（不影响主流程）:', e.message);
  }
}

// ===== 飞书 filter 表达式构建 =====
function buildFilter(conditions) {
  if (!conditions || conditions.length === 0) return null;
  if (conditions.length === 1) return conditions[0];
  return `AND(${conditions.join(',')})`;
}

function eq(fieldCn, value) {
  return `CurrentValue.[${fieldCn}]="${value}"`;
}

function neq(fieldCn, value) {
  return `CurrentValue.[${fieldCn}]!="${value}"`;
}

function contains(fieldCn, value) {
  return `CurrentValue.[${fieldCn}].contains("${value}")`;
}

// ====================================================================
// 以下函数与原 db.js 接口完全一致，方便 server.js 无缝切换
// ====================================================================

// 生成唯一码（8位 hex + 时间戳前缀，无需查飞书）
function genUniqueCode() {
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return ts + rand;
}

// ===== 设置（改用环境变量 + 飞书 Base 第一行的 settings） =====
const settings = {
  storeName: '武汉光谷旗舰店',
  storeAddress: '北京市朝阳区建国路88号',
  maxPerSlot: '1'
};

function getSettings() {
  return { ...settings };
}

function getSetting(key) {
  return settings[key] || null;
}

function setSetting(key, value) {
  settings[key] = String(value);
}

// ===== 创建预约 =====
// existingCount: 外部已查好的同日同时段非取消记录数，避免重复 API 调用
async function createReservation({ name, phone, partySize, date, timeSlot, scene, existingCount, nickname, openid }) {
  const code = genUniqueCode();
  const signinCode = genUniqueCode();

  let queueNumber;
  if (existingCount !== undefined) {
    queueNumber = existingCount + 1;
  } else {
    const filter = buildFilter([
      eq(FIELDS.date, date),
      eq(FIELDS.timeSlot, timeSlot),
      neq(FIELDS.status, '已取消')
    ]);
    const existing = await listAllRecords(filter);
    queueNumber = existing.length + 1;
  }

  const now = new Date().toISOString();

  const record = await createRecord({
    [FIELDS.code]: code,
    [FIELDS.signinCode]: signinCode,
    [FIELDS.name]: name,
    [FIELDS.phone]: phone,
    [FIELDS.nickname]: nickname || '',
    [FIELDS.openid]: openid || '',
    [FIELDS.partySize]: partySize,
    [FIELDS.date]: date,
    [FIELDS.timeSlot]: timeSlot,
    [FIELDS.scene]: scene || '',
    [FIELDS.queueNumber]: queueNumber,
    [FIELDS.status]: '待签到',
    [FIELDS.createdAt]: now,
    [FIELDS.checkedInAt]: ''
  });

  return {
    id: record.id,
    name, phone, partySize, date, timeSlot, scene,
    queueNumber,
    status: 'pending',
    code,
    signinCode,
    createdAt: now,
    recordId: record.recordId
  };
}

// ===== 按预约码查询 =====
async function getReservationByCode(code) {
  const filter = eq(FIELDS.code, code.toUpperCase());
  const result = await listRecords(filter, null, 1);
  return result.records.length > 0 ? result.records[0] : null;
}

// ===== 按签到验证码查询 =====
async function getReservationBySigninCode(code) {
  const filter = eq(FIELDS.signinCode, code.toUpperCase());
  const result = await listRecords(filter, null, 1);
  return result.records.length > 0 ? result.records[0] : null;
}

// ===== 按日期查预约列表 =====
async function getReservationsByDate(date, statusFilter) {
  const conditions = [eq(FIELDS.date, date)];
  if (statusFilter) {
    conditions.push(eq(FIELDS.status, statusFilter === 'checked_in' ? '已签到' : statusFilter === 'cancelled' ? '已取消' : '待签到'));
  }
  const filter = buildFilter(conditions);
  const all = await listAllRecords(filter);

  // 按创建时间倒序
  all.sort((a, b) => {
    if (a.created_at < b.created_at) return 1;
    if (a.created_at > b.created_at) return -1;
    return 0;
  });

  return all;
}

// ===== 获取当天待签到 =====
async function getPendingByDate(date) {
  const filter = buildFilter([
    eq(FIELDS.date, date),
    eq(FIELDS.status, '待签到')
  ]);
  const all = await listAllRecords(filter);
  all.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return all;
}

// ===== 获取当天已签到 =====
async function getCheckedInByDate(date) {
  const filter = buildFilter([
    eq(FIELDS.date, date),
    eq(FIELDS.status, '已签到')
  ]);
  const all = await listAllRecords(filter);
  all.sort((a, b) => (a.checked_in_at < b.checked_in_at ? -1 : 1));
  return all;
}

// ===== 时段余量 =====
async function getSlotAvailability(date, timeSlot) {
  const filter = buildFilter([
    eq(FIELDS.date, date),
    eq(FIELDS.timeSlot, timeSlot),
    neq(FIELDS.status, '已取消')
  ]);
  const all = await listAllRecords(filter);
  return all.length;
}

// ===== 按手机尾号查待签 =====
async function findPendingByPhoneTail(tail, date) {
  // 飞书 filter 不支持 substr，查当日所有待签到，本地过滤
  const filter = buildFilter([
    eq(FIELDS.date, date),
    eq(FIELDS.status, '待签到')
  ]);
  const all = await listAllRecords(filter);
  return all.filter(r => r.phone && r.phone.slice(-4) === tail);
}

// ===== 同一手机号当天是否已有待签 =====
async function findExistingPending(phone, date) {
  const filter = buildFilter([
    eq(FIELDS.phone, phone),
    eq(FIELDS.date, date),
    eq(FIELDS.status, '待签到')
  ]);
  const result = await listRecords(filter, null, 1);
  return result.records.length > 0 ? result.records[0] : null;
}

// ===== 更新状态 =====
async function updateReservationStatus(code, status, checkedInAt) {
  const r = await getReservationByCode(code);
  if (!r) throw new Error('未找到该预约记录');

  const fields = {
    [FIELDS.status]: status === 'checked_in' ? '已签到' : status === 'cancelled' ? '已取消' : '待签到'
  };
  if (checkedInAt) {
    fields[FIELDS.checkedInAt] = checkedInAt;
  }

  return updateRecord(r.recordId, fields);
}

// ===== 改签 =====
async function updateReservationDateSlot(code, date, timeSlot) {
  const r = await getReservationByCode(code);
  if (!r) throw new Error('未找到该预约记录');

  return updateRecord(r.recordId, {
    [FIELDS.date]: date,
    [FIELDS.timeSlot]: timeSlot
  });
}

// ===== 签到（备用） =====
async function checkin(code) {
  const r = await getReservationByCode(code);
  if (!r) return { error: '预约码无效' };
  if (r.status === 'cancelled') return { error: '该预约已被取消' };
  if (r.status === 'checked_in') return { error: '该预约已签到' };

  const now = new Date().toISOString();
  await updateReservationStatus(code, 'checked_in', now);
  return { success: true, ...r, status: 'checked_in', checkedInAt: now };
}

async function checkinBySigninCode(signinCode) {
  const r = await getReservationBySigninCode(signinCode);
  if (!r) return { error: '签到验证码无效' };
  if (r.status === 'cancelled') return { error: '该预约已被取消' };
  if (r.status === 'checked_in') return { error: '该预约已签到' };

  const now = new Date().toISOString();
  await updateReservationStatus(r.code, 'checked_in', now);
  return { success: true, ...r, status: 'checked_in', checkedInAt: now };
}

// ===== 统计 =====
async function getStats(date) {
  const all = await listAllRecords(eq(FIELDS.date, date));
  const stats = { total: all.length, pending: 0, checkedIn: 0, cancelled: 0 };
  for (const r of all) {
    if (r.status === 'pending') stats.pending++;
    else if (r.status === 'checked_in') stats.checkedIn++;
    else if (r.status === 'cancelled') stats.cancelled++;
  }
  return stats;
}

// ===== 搜索 =====
async function searchReservations(date, query) {
  const all = await listAllRecords(eq(FIELDS.date, date));
  const q = query.toLowerCase();
  return all.filter(r => {
    return (r.name && r.name.toLowerCase().includes(q)) ||
           (r.phone && r.phone.includes(q)) ||
           (r.code && r.code.toLowerCase().includes(q));
  }).sort((a, b) => {
    if (a.created_at < b.created_at) return 1;
    if (a.created_at > b.created_at) return -1;
    return 0;
  });
}

module.exports = {
  init,
  // 设置
  getSettings, getSetting, setSetting,
  // 预约
  createReservation,
  getReservationByCode,
  getReservationBySigninCode,
  getReservationsByDate,
  getPendingByDate,
  getCheckedInByDate,
  getSlotAvailability,
  findPendingByPhoneTail,
  findExistingPending,
  updateReservationStatus,
  updateReservationDateSlot,
  checkin,
  checkinBySigninCode,
  // 统计 & 搜索
  getStats,
  searchReservations,
  // 字段初始化
  ensureFields
};
