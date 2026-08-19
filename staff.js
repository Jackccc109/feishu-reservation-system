/**
 * 员工账号管理（后台统一管理，一人一店）
 * 员工数据存 data/staff.json；首次启动时用 .env 播种
 * 每个员工账号绑定一个门店：store = { code, name, address, slots[], maxPerSlot }
 * 密码以 sha256(username+password) 哈希存储
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const STAFF_FILE = path.join(DATA_DIR, 'staff.json');

// 默认门店配置（.env 可覆盖，作为播种值）
const DEFAULT_SLOTS = (() => {
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
})();

function hashPassword(username, password) {
  return crypto.createHash('sha256').update(username + '::' + password).digest('hex');
}

function loadStaff() {
  try {
    if (fs.existsSync(STAFF_FILE)) {
      return JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return [];
}

function saveStaff(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STAFF_FILE, JSON.stringify(list, null, 2));
}

// 门店配置补齐（老数据迁移：无 store 字段的补默认门店；无 activities 的用原配置建默认活动）
function normalizeStore(s) {
  if (!s.store) {
    s.store = {
      code: process.env.STORE_CODE || 'default',
      name: process.env.STORE_NAME || '优品生活馆',
      address: process.env.STORE_ADDRESS || '',
      slots: DEFAULT_SLOTS,
      maxPerSlot: parseInt(process.env.MAX_PER_SLOT) || 1
    };
  }
  s.store.code = s.store.code || 'default';
  s.store.name = s.store.name || '优品生活馆';
  s.store.address = s.store.address || '';
  if (!Array.isArray(s.store.slots) || s.store.slots.length === 0) s.store.slots = DEFAULT_SLOTS;
  s.store.maxPerSlot = parseInt(s.store.maxPerSlot) || 1;
  // 一店多活动：仅当 activities 字段缺失（老数据/新建）时用原标题/地址/时段/上限封装为默认活动；
  // 空数组表示用户已删光活动，不再自动复活
  if (!Array.isArray(s.store.activities)) {
    s.store.activities = [{
      id: 'act-' + (s.store.code || 'default').replace(/[^a-zA-Z0-9]/g, '') + '-1',
      title: s.store.name,
      address: s.store.address,
      slots: s.store.slots,
      maxPerSlot: s.store.maxPerSlot,
      enabled: true,
      createdAt: new Date().toISOString()
    }];
  }
  // 门店标题/地址/上限为门店独立字段，不与活动互相覆盖
  return s;
}

// 角色补齐：老账号默认 super（保留现有管理员权限），新账号默认 store
function normalizeRole(s) {
  if (!s.role) s.role = 'super';
  return s;
}

// 活动操作
function addActivity(staffEntry, act) {
  const list = ensureSeed();
  const s = list.find(x => x.id === staffEntry.id);
  if (!s) throw new Error('账号不存在');
  const id = 'act-' + crypto.randomBytes(4).toString('hex');
  const item = {
    id,
    title: (act.title || '').trim() || '未命名活动',
    address: (act.address || '').trim(),
    slots: Array.isArray(act.slots) && act.slots.length ? act.slots : DEFAULT_SLOTS,
    maxPerSlot: parseInt(act.maxPerSlot) || 1,
    enabled: act.enabled !== false,
    createdAt: new Date().toISOString()
  };
  s.store.activities.push(item);
  saveStaff(list);
  return item;
}

function updateActivity(staffEntry, actId, patch) {
  const list = ensureSeed();
  const s = list.find(x => x.id === staffEntry.id);
  if (!s) throw new Error('账号不存在');
  const act = s.store.activities.find(a => a.id === actId);
  if (!act) throw new Error('活动不存在');
  if (patch.title !== undefined) act.title = (patch.title || '').trim() || act.title;
  if (patch.address !== undefined) act.address = (patch.address || '').trim();
  if (Array.isArray(patch.slots) && patch.slots.length) act.slots = patch.slots;
  if (patch.maxPerSlot !== undefined) act.maxPerSlot = parseInt(patch.maxPerSlot) || 1;
  if (patch.enabled !== undefined) act.enabled = !!patch.enabled;
  saveStaff(list);
  return act;
}

function removeActivity(staffEntry, actId) {
  const list = ensureSeed();
  const s = list.find(x => x.id === staffEntry.id);
  if (!s) throw new Error('账号不存在');
  const before = s.store.activities.length;
  s.store.activities = s.store.activities.filter(a => a.id !== actId);
  if (s.store.activities.length === before) throw new Error('活动不存在');
  saveStaff(list);
  return s.store.activities;
}

// 首次启动播种：.env 的 ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_PHONE / STORE_*
function ensureSeed() {
  let list = loadStaff();
  if (list.length === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const seed = {
      id: crypto.randomBytes(6).toString('hex'),
      username,
      password: hashPassword(username, password),
      phone: process.env.ADMIN_PHONE || '',
      enabled: true,
      role: 'super',
      createdAt: new Date().toISOString(),
      store: {
        code: process.env.STORE_CODE || 'default',
        name: process.env.STORE_NAME || '优品生活馆',
        address: process.env.STORE_ADDRESS || '',
        slots: DEFAULT_SLOTS,
        maxPerSlot: parseInt(process.env.MAX_PER_SLOT) || 1,
        activities: [{
          id: 'act-' + (process.env.STORE_CODE || 'default').replace(/[^a-zA-Z0-9]/g, '') + '-1',
          title: process.env.STORE_NAME || '优品生活馆',
          address: process.env.STORE_ADDRESS || '',
          slots: DEFAULT_SLOTS,
          maxPerSlot: parseInt(process.env.MAX_PER_SLOT) || 1,
          enabled: true,
          createdAt: new Date().toISOString()
        }]
      }
    };
    list = [seed];
    saveStaff(list);
  } else {
    // 老数据迁移
    let changed = false;
    list = list.map(s => {
      const before = JSON.stringify(s);
      const normalized = normalizeStore(normalizeRole(s));
      if (JSON.stringify(normalized) !== before) changed = true;
      return normalized;
    });
    if (changed) saveStaff(list);
  }
  return list;
}

function listStaff() {
  return ensureSeed();
}

function findByUsername(username) {
  return ensureSeed().find(s => s.username === username && s.enabled);
}

function findById(id) {
  return ensureSeed().find(s => s.id === id);
}

// 按门店编码查员工（顾客端路由用）
function findByStoreCode(code) {
  return ensureSeed().find(s => s.enabled && s.store && s.store.code === code);
}

function addStaff({ username, password, phone, store, role }) {
  const list = ensureSeed();
  if (!username || !password) throw new Error('账号和密码不能为空');
  if (list.find(s => s.username === username)) throw new Error('账号已存在');
  if (store && store.code && list.find(s => s.store && s.store.code === store.code)) {
    throw new Error('该门店编码已被使用');
  }
  const item = normalizeStore({
    id: crypto.randomBytes(6).toString('hex'),
    username,
    password: hashPassword(username, password),
    passwordPlain: password, // 明文，供总管理员查看（内部系统）
    phone: (phone || '').trim(),
    enabled: true,
    role: role === 'super' ? 'super' : 'store', // 默认门店角色
    createdAt: new Date().toISOString(),
    store: store ? {
      code: store.code || 'default',
      name: store.name || '优品生活馆',
      address: store.address || '',
      slots: store.slots || DEFAULT_SLOTS,
      maxPerSlot: parseInt(store.maxPerSlot) || 1
    } : undefined
  });
  list.push(item);
  saveStaff(list);
  return item;
}

function removeStaff(id) {
  let list = ensureSeed();
  if (list.length <= 1) throw new Error('至少保留一个管理员账号');
  const item = list.find(s => s.id === id);
  if (!item) throw new Error('账号不存在');
  // 至少保留一个 super
  if (item.role === 'super' && list.filter(s => s.role === 'super').length <= 1) {
    throw new Error('至少保留一个总管理员账号');
  }
  list = list.filter(s => s.id !== id);
  saveStaff(list);
  return list;
}

function updateStaff(id, patch) {
  let list = ensureSeed();
  const item = list.find(s => s.id === id);
  if (!item) throw new Error('账号不存在');
  if (patch.username) item.username = patch.username;
  if (patch.password) {
    item.password = hashPassword(item.username, patch.password);
    item.passwordPlain = patch.password;
  }
  if (patch.phone !== undefined) item.phone = (patch.phone || '').trim();
  if (patch.role === 'super' || patch.role === 'store') {
    // 至少保留一个 super
    if (item.role === 'super' && patch.role !== 'super' && list.filter(s => s.role === 'super').length <= 1) {
      throw new Error('至少保留一个总管理员账号');
    }
    item.role = patch.role;
  }
  // 门店配置更新（标题/地址/时段/每时段上限）
  if (patch.store) {
    if (patch.store.code && patch.store.code !== item.store.code) {
      if (list.find(s => s.id !== id && s.store && s.store.code === patch.store.code)) {
        throw new Error('该门店编码已被其他账号使用');
      }
      item.store.code = patch.store.code;
    }
    if (patch.store.name !== undefined) item.store.name = patch.store.name;
    if (patch.store.address !== undefined) item.store.address = patch.store.address;
    if (Array.isArray(patch.store.slots) && patch.store.slots.length > 0) item.store.slots = patch.store.slots;
    if (patch.store.maxPerSlot !== undefined) item.store.maxPerSlot = parseInt(patch.store.maxPerSlot) || 1;
    // 门店信息仅作用于门店层（标题/编码），不影响活动
  }
  saveStaff(list);
  return item;
}

function checkPassword(staff, password) {
  return staff.password === hashPassword(staff.username, password);
}

module.exports = {
  DEFAULT_SLOTS,
  listStaff, findByUsername, findById, findByStoreCode,
  addStaff, removeStaff, updateStaff, checkPassword,
  addActivity, updateActivity, removeActivity
};
