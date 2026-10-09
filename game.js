// 微信小游戏入口
const { Match3Game, LEVELS } = require('./game-core.js');
const { ProfileStore } = require('./profile-store.js');

const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
const info = wx.getSystemInfoSync();
const dpr = info.pixelRatio || 1;

canvas.width = info.windowWidth * dpr;
canvas.height = info.windowHeight * dpr;
ctx.scale(dpr, dpr);

const W = info.windowWidth;
const H = info.windowHeight;

// ===== 档案存储：真实文件系统 =====
// USER_DATA_PATH 本身按微信用户隔离，天然「每个用户数据分开」；
// 每个玩家档案再单独存成一个 profiles/<id>.json 文件。
const fsm = wx.getFileSystemManager();
const BASE = wx.env.USER_DATA_PATH;
try { fsm.mkdirSync(BASE + '/profiles'); } catch (e) {}
const fileAdapter = {
  readFile(name) { try { return fsm.readFileSync(BASE + '/' + name, 'utf8'); } catch (e) { return null; } },
  writeFile(name, str) { try { fsm.writeFileSync(BASE + '/' + name, str, 'utf8'); } catch (e) {} },
  removeFile(name) { try { fsm.unlinkSync(BASE + '/' + name); } catch (e) {} },
};
const store = new ProfileStore(fileAdapter);

// 首次运行：把旧版单存档（match3_level）迁移成第一个档案，避免老玩家进度丢失
try {
  if (store.count() === 0) {
    let legacy = 0;
    try { legacy = parseInt(wx.getStorageSync('match3_level') || '0', 10) || 0; } catch (e) {}
    store.migrateLegacy(legacy);
    try { wx.removeStorageSync('match3_level'); } catch (e) {}
  }
} catch (e) {}

// ---- 音效（优先 wx.createWebAudioContext，无需音频文件）----
class SoundSynth {
  constructor() { this.ac = null; }
  ensure() {
    if (this.ac) { if (this.ac.state === 'suspended' && this.ac.resume) this.ac.resume(); return; }
    try {
      if (typeof wx !== 'undefined' && wx.createWebAudioContext) this.ac = wx.createWebAudioContext();
    } catch (e) { this.ac = null; }
  }
  tone(freq, dur, type, gain, when) {
    if (!this.ac) return;
    const t0 = this.ac.currentTime + (when || 0);
    const osc = this.ac.createOscillator();
    const g = this.ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.2, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(this.ac.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
  }
  play(name, combo) {
    this.ensure();
    if (!this.ac) return;
    switch (name) {
      case 'swap': this.tone(420, 0.08, 'triangle', 0.12); break;
      case 'invalid': this.tone(150, 0.18, 'sawtooth', 0.12); break;
      case 'match': { const base = 520 + (combo || 1) * 60; this.tone(base, 0.10, 'sine', 0.18); this.tone(base * 1.5, 0.12, 'sine', 0.10, 0.02); break; }
      case 'special': this.tone(880, 0.12, 'square', 0.12); this.tone(1320, 0.14, 'sine', 0.10, 0.03); break;
      case 'ice': this.tone(1250, 0.06, 'triangle', 0.08); break;
      case 'chain': this.tone(1800, 0.05, 'square', 0.07); this.tone(2600, 0.05, 'sine', 0.05, 0.02); break;
      case 'win': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.18, i * 0.12)); break;
      case 'lose': [440, 349, 262].forEach((f, i) => this.tone(f, 0.25, 'sawtooth', 0.14, i * 0.14)); break;
    }
  }
}
const sound = new SoundSynth();

// ===== 状态 =====
let screen = 'profiles';   // 'profiles' | 'game'
let game = null;
let currentProfile = null;
let layout = null;
let last = 0;
let profileRows = [];
let newBtn = null;
let switchBtn = null;

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function inRect(x, y, r) { return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h; }

function bindGameEvents(g) {
  g.on('swap', e => sound.play(e.valid ? 'swap' : 'invalid'));
  g.on('match', e => sound.play('match', e.combo));
  g.on('special', () => sound.play('special'));
  g.on('ice', () => sound.play('ice'));
  g.on('chain', () => sound.play('chain'));
  g.on('win', () => sound.play('win'));
  g.on('lose', () => sound.play('lose'));
}

function startProfile(id) {
  const p = store.get(id);
  if (!p) return;
  currentProfile = p;
  store.setCurrent(id);
  game = new Match3Game(8, 6, { level: p.level || 0 });
  bindGameEvents(game);
  screen = 'game';
  last = 0;
}

function saveProgress() {
  if (currentProfile && game) store.update(currentProfile.id, { level: game.levelIndex });
}

function isLastLevel() { return game && game.levelIndex >= LEVELS.length - 1; }

// ---- 档案选择界面 ----
function drawProfiles() {
  layout = null;
  ctx.fillStyle = '#15151c';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px sans-serif';
  ctx.fillText('选择玩家', W / 2, 78);
  ctx.fillStyle = '#8a8a97';
  ctx.font = '13px sans-serif';
  ctx.fillText('每个玩家的进度独立保存', W / 2, 104);

  const profiles = store.list();
  profileRows = [];
  const rowW = Math.min(W - 48, 420);
  const x = (W - rowW) / 2;
  const rowH = 64, gap = 12;
  let y = 140;
  for (const p of profiles) {
    ctx.fillStyle = '#23232c';
    roundRect(ctx, x, y, rowW, rowH, 12); ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '18px sans-serif';
    ctx.fillText(String(p.name), x + 20, y + 28);
    ctx.fillStyle = '#8a8a97';
    ctx.font = '13px sans-serif';
    ctx.fillText('第 ' + ((p.level || 0) + 1) + ' 关', x + 20, y + 48);

    const delR = 14, delX = x + rowW - 28, delY = y + rowH / 2;
    ctx.beginPath(); ctx.arc(delX, delY, delR, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(239,68,68,0.9)'; ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(delX - 5, delY - 5); ctx.lineTo(delX + 5, delY + 5);
    ctx.moveTo(delX + 5, delY - 5); ctx.lineTo(delX - 5, delY + 5);
    ctx.stroke();

    profileRows.push({ id: p.id, x, y, w: rowW, h: rowH, delX, delY, delR });
    y += rowH + gap;
  }

  const btnH = 52;
  const btnY = Math.min(y + 6, H - btnH - 30);
  newBtn = { x, y: btnY, w: rowW, h: btnH };
  ctx.fillStyle = '#2e7d5b';
  roundRect(ctx, x, btnY, rowW, btnH, 12); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = '17px sans-serif';
  ctx.fillText('＋ 新建玩家', W / 2, btnY + btnH / 2 + 6);
  ctx.textAlign = 'left';
}

// ---- 游戏界面 ----
function drawGame(dt) {
  game.update(dt);
  layout = game.render(ctx, { width: W, height: H, topOffset: 110, bg: '#15151c', boardBg: '#23232c' });

  // 顶部：玩家名 + 切换按钮
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.font = '15px sans-serif';
  ctx.fillText('玩家：' + (currentProfile ? currentProfile.name : ''), 14, 26);
  switchBtn = { x: W - 92, y: 8, w: 80, h: 26 };
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  roundRect(ctx, switchBtn.x, switchBtn.y, switchBtn.w, switchBtn.h, 13); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = '13px sans-serif';
  ctx.fillText('切换玩家', W - 52, 25);

  // HUD
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = '20px sans-serif';
  ctx.fillText('第 ' + (game.levelIndex + 1) + ' 关', W / 2, 52);
  ctx.fillText('分数 ' + game.score + '   步数 ' + game.movesLeft + ' / 目标 ' + game.targetScore, W / 2, 80);
  const iceLeft = game._iceRemaining();
  if (iceLeft > 0) {
    ctx.fillStyle = '#8fd3ff';
    ctx.font = '16px sans-serif';
    ctx.fillText('剩余冰块 ' + iceLeft, W / 2, 102);
  }
  const chainLeft = game._chainRemaining();
  if (chainLeft > 0) {
    ctx.fillStyle = '#cfcfd8';
    ctx.font = '16px sans-serif';
    ctx.fillText('剩余锁链 ' + chainLeft, W / 2, iceLeft > 0 ? 124 : 102);
  }

  if (game.won || game.lost) {
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = 'bold 34px sans-serif';
    if (game.won) {
      ctx.fillText(isLastLevel() ? '全部通关！' : '第 ' + (game.levelIndex + 1) + ' 关达成！', W / 2, H / 2 - 20);
      ctx.font = '18px sans-serif';
      ctx.fillText(isLastLevel() ? '点击重新开始' : '点击进入下一关', W / 2, H / 2 + 16);
    } else {
      ctx.fillText('步数用尽', W / 2, H / 2 - 20);
      ctx.font = '18px sans-serif';
      ctx.fillText('得分 ' + game.score + ' / 目标 ' + game.targetScore, W / 2, H / 2 + 16);
      ctx.fillText('点击重试本关', W / 2, H / 2 + 48);
    }
  }
}

function draw(ts) {
  if (!last) last = ts;
  const dt = (ts - last) / 1000;
  last = ts;
  if (screen === 'profiles') drawProfiles();
  else if (game) drawGame(dt);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ===== 触摸 =====
wx.onTouchStart((e) => {
  sound.ensure();
  if (!e.touches || !e.touches[0]) return;
  const px = e.touches[0].clientX;
  const py = e.touches[0].clientY;

  if (screen === 'profiles') {
    for (const r of profileRows) {
      const dx = px - r.delX, dy = py - r.delY;
      if (dx * dx + dy * dy <= (r.delR + 8) * (r.delR + 8)) { confirmDelete(r.id); return; }
    }
    for (const r of profileRows) { if (inRect(px, py, r)) { startProfile(r.id); return; } }
    if (newBtn && inRect(px, py, newBtn)) { newProfile(); return; }
    return;
  }

  if (switchBtn && inRect(px, py, switchBtn)) { saveProgress(); screen = 'profiles'; return; }
  if (!game || !layout) return;
  if (game.won) {
    if (!isLastLevel()) { game.nextLevel(); saveProgress(); }
    else game.init();
    return;
  }
  if (game.lost) { game.init(); return; }
  if (game.inputLocked()) return;
  const cell = game.cellAt(layout, px, py);
  if (!cell) return;
  if (!game.selected) {
    const cc = game.grid[cell.r][cell.c];
    if (cc && cc.chain > 0) { sound.play('invalid'); return; } // 锁链不可选中
    game.selected = cell; return;
  }
  const prev = game.selected;
  if (prev.r === cell.r && prev.c === cell.c) { game.selected = null; return; }
  if (Match3Game.areAdjacent(prev, cell)) {
    game.requestSwap(prev, cell);
    game.selected = null;
  } else {
    const cc = game.grid[cell.r][cell.c];
    if (cc && cc.chain > 0) { sound.play('invalid'); game.selected = null; return; }
    game.selected = cell;
  }
});

// ---- 档案操作 ----
function newProfile() {
  const defName = '玩家' + (store.count() + 1);
  try {
    wx.showModal({
      title: '新建玩家',
      editable: true,
      placeholderText: '输入玩家名称',
      success: (res) => { if (res.confirm) { const p = store.create(res.content || defName); startProfile(p.id); } },
      fail: () => { const p = store.create(defName); startProfile(p.id); },
    });
  } catch (e) { const p = store.create(defName); startProfile(p.id); }
}

function confirmDelete(id) {
  const p = store.get(id);
  if (!p) return;
  try {
    wx.showModal({
      title: '删除玩家',
      content: '确定删除「' + p.name + '」？该玩家的进度将一并删除。',
      success: (res) => { if (res.confirm) store.remove(id); },
    });
  } catch (e) { store.remove(id); }
}
