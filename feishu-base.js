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
  // 门店设置（从环境变量读入，替代原硬编码）
  if (config.storeName)     settings.storeName = config.storeName;
  if (config.storeAddress)  settings.storeAddress = config.storeAddress;
  if (config.maxPerSlot)    settings.maxPerSlot = String(config.maxPerSlot);
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
  store:        '门店',           // 文本（门店编码，多门店隔离）
  activity:     '活动ID',          // 文本（活动ID，一店多活动）
};

// ===== 状态映射：飞书表格存中文，内部逻辑统一用英文 =====
const STATUS_CN_TO_EN = { '待签到': 'pending', '已签到': 'checked_in', '已取消': 'cancelled' };
const STATUS_EN_TO_CN = { 'pending': '待签到', 'checked_in': '已签到', 'cancelled': '已取消' };

// ===== Token 管理 =====
let tokenPromise = null; // 并发去重：多个请求同时过期时只刷一次 token

async function getAccessToken() {
  if (ACCESS_TOKEN && TOKEN_EXPIRES && Date.now() < TOKEN_EXPIRES - 300000) {
    return ACCESS_TOKEN;
  }
  // 已有刷新在进行中 → 复用同一个 promise，避免并发重复刷 token（飞书接口有限流）
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    const res = await fetchWithTimeout('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
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
  })().finally(() => {
    tokenPromise = null;
  });

  return tokenPromise;
}

// fetch 带超时（默认 10s），防止飞书 API 挂起导致请求悬挂
async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
    const res = await fetchWithTimeout(url, opts);
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
    // 网络错误/超时：重试（最多 retries 次）
    if (retries > 0) {
      await sleep(800);
      return apiRequest(method, path, body, retries - 1);
    }
    throw new Error(`网络异常: ${err.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== 记录转换：飞书格式 → 内部格式（状态统一转为英文） =====
function recordToInternal(record) {
  const f = record.fields;
  const statusCn = f[FIELDS.status] || '待签到';
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
    status:     STATUS_CN_TO_EN[statusCn] || statusCn, // 中文 → 英文，全系统统一用英文
    signin_code: (f[FIELDS.signinCode] || '').toString(),
    created_at: f[FIELDS.createdAt] || '',
    createdAt:  f[FIELDS.createdAt] || '',
    checked_in_at: f[FIELDS.checkedInAt] || null,
    checkedInAt: f[FIELDS.checkedInAt] || null,
    store:      f[FIELDS.store] || 'default', // 门店编码（老数据无门店 → default）
    activity:   f[FIELDS.activity] || ''      // 活动ID（老数据为空 → 默认活动）
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
    { name: FIELDS.openid, type: 1 },    // 文本
    { name: FIELDS.store, type: 1 },     // 文本（门店编码）
    { name: FIELDS.activity, type: 1 }   // 文本（活动ID）
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

// 生成唯一码（6位大写 hex，与前端 UI「6位验证码」保持一致）
function genUniqueCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ===== 设置（默认值；可由 .env 覆盖，见 init()） =====
const settings = {
  storeName: '优品生活馆',
  storeAddress: '',
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
async function createReservation({ name, phone, partySize, date, timeSlot, scene, existingCount, nickname, openid, store, activity }) {
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
    [FIELDS.checkedInAt]: '',
    [FIELDS.store]: store || 'default',
    [FIELDS.activity]: activity || ''
  });

  return {
    id: record.id,
    name, phone, partySize, date, timeSlot, scene,
    queueNumber,
    status: 'pending',
    code,
    signinCode,
    createdAt: now,
    recordId: record.recordId,
    store: store || 'default',
    activity: activity || ''
  };
}

// 门店过滤条件追加（多门店隔离；老数据无门店 → default）
function withStore(conditions, store) {
  if (store) conditions.push(eq(FIELDS.store, store));
  return conditions;
}

// 活动过滤条件追加（时段余量按活动隔离）
function withActivity(conditions, activity) {
  if (activity) conditions.push(eq(FIELDS.activity, activity));
  return conditions;
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
async function getReservationsByDate(date, statusFilter, store, activity) {
  const conditions = withActivity(withStore([eq(FIELDS.date, date)], store), activity);
  if (statusFilter) {
    // 英文状态 → 飞书中文状态查询
    conditions.push(eq(FIELDS.status, STATUS_EN_TO_CN[statusFilter] || statusFilter));
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
async function getPendingByDate(date, store) {
  const filter = buildFilter(withStore([
    eq(FIELDS.date, date),
    eq(FIELDS.status, '待签到')
  ], store));
  const all = await listAllRecords(filter);
  all.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return all;
}

// ===== 获取当天已签到 =====
async function getCheckedInByDate(date, store) {
  const filter = buildFilter([
    eq(FIELDS.date, date),
    eq(FIELDS.status, '已签到')
  ]);
  const all = await listAllRecords(filter);
  all.sort((a, b) => (a.checked_in_at < b.checked_in_at ? -1 : 1));
  return all;
}

// ===== 时段余量 =====
async function getSlotAvailability(date, timeSlot, store) {
  const filter = buildFilter(withStore([
    eq(FIELDS.date, date),
    eq(FIELDS.timeSlot, timeSlot),
    neq(FIELDS.status, '已取消')
  ], store));
  const all = await listAllRecords(filter);
  return all.length;
}

// ===== 按手机尾号查待签 =====
async function findPendingByPhoneTail(tail, date, store) {
  // 飞书 filter 不支持 substr，查当日所有待签到，本地过滤
  const filter = buildFilter(withStore([
    eq(FIELDS.date, date),
    eq(FIELDS.status, '待签到')
  ], store));
  const all = await listAllRecords(filter);
  return all.filter(r => r.phone && r.phone.slice(-4) === tail);
}

// ===== 按手机号查全部预约（顾客"我的预约"页，跨日期） =====
async function findReservationsByPhone(phone, store) {
  const filter = buildFilter(withStore([eq(FIELDS.phone, phone)], store));
  const all = await listAllRecords(filter);
  // 按创建时间倒序（最近的排最前）
  all.sort((a, b) => {
    if (a.created_at < b.created_at) return 1;
    if (a.created_at > b.created_at) return -1;
    return 0;
  });
  return all;
}

// ===== 按微信 openid 查全部预约（顾客微信登录后查看，跨日期） =====
async function findReservationsByOpenid(openid, store) {
  const filter = buildFilter(withStore([eq(FIELDS.openid, openid)], store));
  const all = await listAllRecords(filter);
  all.sort((a, b) => {
    if (a.created_at < b.created_at) return 1;
    if (a.created_at > b.created_at) return -1;
    return 0;
  });
  return all;
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

// 签到验证码签到（today: 可选，YYYY-MM-DD，传入后仅允许当天签到，与扫码/尾号路径一致）
async function checkinBySigninCode(signinCode, today) {
  const r = await getReservationBySigninCode(signinCode);
  if (!r) return { error: '签到验证码无效' };
  if (r.status === 'cancelled') return { error: '该预约已被取消' };
  if (r.status === 'checked_in') return { error: '该预约已签到' };
  if (today && r.date !== today) return { error: `该预约日期为 ${r.date}，仅限当天签到` };

  const now = new Date().toISOString();
  await updateReservationStatus(r.code, 'checked_in', now);
  return { success: true, ...r, status: 'checked_in', checkedInAt: now };
}

// ===== 统计 =====
async function getStats(date, store) {
  const all = await listAllRecords(buildFilter(withStore([eq(FIELDS.date, date)], store)));
  const stats = { total: all.length, pending: 0, checkedIn: 0, cancelled: 0 };
  for (const r of all) {
    if (r.status === 'pending') stats.pending++;
    else if (r.status === 'checked_in') stats.checkedIn++;
    else if (r.status === 'cancelled') stats.cancelled++;
  }
  return stats;
}

// ===== 搜索 =====
async function searchReservations(date, query, store) {
  const all = await listAllRecords(buildFilter(withStore([eq(FIELDS.date, date)], store)));
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
  findReservationsByPhone,
  findReservationsByOpenid,
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
