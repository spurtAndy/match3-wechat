// 微信小游戏入口
const { Match3Game, LEVELS } = require('./game-core.js');

let savedLevel = 0;
try { savedLevel = parseInt(wx.getStorageSync('match3_level') || '0', 10) || 0; } catch (e) {}
const game = new Match3Game(8, 6, { level: savedLevel });
const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
const info = wx.getSystemInfoSync();
const dpr = info.pixelRatio || 1;

canvas.width = info.windowWidth * dpr;
canvas.height = info.windowHeight * dpr;
ctx.scale(dpr, dpr);

const W = info.windowWidth;
const H = info.windowHeight;
let layout = null;
let last = 0;

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
game.on('swap', e => sound.play(e.valid ? 'swap' : 'invalid'));
game.on('match', e => sound.play('match', e.combo));
game.on('special', () => sound.play('special'));
game.on('ice', () => sound.play('ice'));
game.on('chain', () => sound.play('chain'));
game.on('win', () => sound.play('win'));
game.on('lose', () => sound.play('lose'));

function isLastLevel() { return game.levelIndex >= LEVELS.length - 1; }

function draw(ts) {
  if (!last) last = ts;
  const dt = (ts - last) / 1000;
  last = ts;
  game.update(dt);
  layout = game.render(ctx, {
    width: W,
    height: H,
    topOffset: 90,
    bg: '#15151c',
    boardBg: '#23232c',
  });
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = '20px sans-serif';
  ctx.fillText('第 ' + (game.levelIndex + 1) + ' 关', W / 2, 40);
  let mid = '分数 ' + game.score + '   步数 ' + game.movesLeft + ' / 目标 ' + game.targetScore;
  ctx.fillText(mid, W / 2, 70);
  const iceLeft = game._iceRemaining();
  if (iceLeft > 0) {
    ctx.fillStyle = '#8fd3ff';
    ctx.font = '16px sans-serif';
    ctx.fillText('剩余冰块 ' + iceLeft, W / 2, 92);
  }
  const chainLeft = game._chainRemaining();
  if (chainLeft > 0) {
    ctx.fillStyle = '#cfcfd8';
    ctx.font = '16px sans-serif';
    ctx.fillText('剩余锁链 ' + chainLeft, W / 2, iceLeft > 0 ? 114 : 92);
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
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

wx.onTouchStart((e) => {
  if (!layout || !e.touches || !e.touches[0]) return;
  sound.ensure();
  if (game.won) {
    if (!isLastLevel()) { game.nextLevel(); try { wx.setStorageSync('match3_level', game.levelIndex); } catch (err) {} }
    else game.init();
    return;
  }
  if (game.lost) { game.init(); return; }
  if (game.inputLocked()) return;
  const t = e.touches[0];
  const cell = game.cellAt(layout, t.clientX, t.clientY);
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
    game.selected = cell;
  }
});
