// 消除游戏核心引擎（平台无关，含动画状态机 + 特殊方块 + 事件 + 多关卡 / 冰块 / 锁链）
// 同时支持 微信小游戏(require) 与 网页(<script> 全局 GameCore)
(function (global) {
  'use strict';

  const COLORS = [
    '#EF4444', // 红
    '#3B82F6', // 蓝
    '#22C55E', // 绿
    '#FACC15', // 黄
    '#A855F7', // 紫
    '#F97316', // 橙
  ];

  const PHASE = { IDLE: 'idle', SWAP: 'swap', SWAPBACK: 'swapback', CLEAR: 'clear', FALL: 'fall' };
  const SPECIAL = { NONE: 'none', ROW: 'row', COL: 'col', BOMB: 'bomb' };

  // 关卡配置：目标分 / 步数 递增，后期加入冰块(ice)与锁链(chain)障碍
  // ice: 'border'|'center'|'checker'  iceLayers: 冰层数(2=需敲两次)
  // chain: 'scatter'  chainCount: 锁链数量  chainLayers: 锁链层数
  const LEVELS = [
    { id: 1, target: 500,  moves: 25 },
    { id: 2, target: 800,  moves: 22 },
    { id: 3, target: 1100, moves: 20 },
    { id: 4, target: 1400, moves: 20, ice: 'border',  iceLayers: 1 },
    { id: 5, target: 1700, moves: 18, ice: 'center',  iceLayers: 1 },
    { id: 6, target: 2000, moves: 18, ice: 'checker', iceLayers: 1 },
    { id: 7, target: 2300, moves: 18, chain: 'scatter', chainCount: 8 },
    { id: 8, target: 2600, moves: 18, ice: 'checker', iceLayers: 2, chain: 'scatter', chainCount: 6 },
  ];

  function randInt(n) { return Math.floor(Math.random() * n); }
  function easeInOut(t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; }
  function easeOut(t) { return t * (2 - t); }
  function key(r, c) { return r + ',' + c; }
  function parseKey(k) { const p = k.split(','); return [parseInt(p[0], 10), parseInt(p[1], 10)]; }
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  class Match3Game {
    constructor(size = 8, colorCount = 6, opts = {}) {
      this.size = size;
      this.colorCount = Math.min(colorCount, COLORS.length);
      this.levelIndex = opts.level != null ? opts.level : 0;
      this.levelCfg = LEVELS[this.levelIndex] || LEVELS[0];
      this._initTarget = opts.target != null ? opts.target : this.levelCfg.target;
      this._initMoves = opts.moves != null ? opts.moves : this.levelCfg.moves;
      this.score = 0;
      this.selected = null;
      this.phase = PHASE.IDLE;
      this.anim = null;
      this.skip = null;
      this.combo = 0;
      this.pops = [];
      this.won = false;
      this.lost = false;
      this.lastSwap = null;
      this._pendingSpecials = null;
      this._handlers = {};
      this.ice = [];
      this.chainTotal = 0;
      this.init();
    }

    // ---- 事件 ----
    on(evt, cb) {
      if (!this._handlers[evt]) this._handlers[evt] = [];
      this._handlers[evt].push(cb);
    }
    emit(evt, payload) {
      const list = this._handlers[evt];
      if (!list) return;
      for (const cb of list) cb(payload);
    }

    setLevel(i) {
      this.levelIndex = Math.max(0, Math.min(i, LEVELS.length - 1));
      this.levelCfg = LEVELS[this.levelIndex];
      this._initTarget = this.levelCfg.target;
      this._initMoves = this.levelCfg.moves;
      this.init();
    }
    nextLevel() {
      if (this.levelIndex < LEVELS.length - 1) this.setLevel(this.levelIndex + 1);
      else this.setLevel(this.levelIndex); // 已是最后一关，重玩
    }

    init() {
      this.targetScore = this._initTarget;
      this.movesLeft = this._initMoves;
      this.score = 0;
      this.selected = null;
      this.phase = PHASE.IDLE;
      this.anim = null;
      this.skip = null;
      this.combo = 0;
      this.pops = [];
      this.won = false;
      this.lost = false;
      this.lastSwap = null;
      this._pendingSpecials = null;
      this.chainTotal = 0;
      this._buildIce();
      this._buildBoard();
      this._buildChains();
      if (!this.hasPossibleMove()) this.init();
    }

    _buildIce() {
      const n = this.size;
      const pat = this.levelCfg.ice;
      const layers = this.levelCfg.iceLayers || 1;
      this.ice = Array.from({ length: n }, () => new Array(n).fill(0));
      if (!pat) return;
      if (pat === 'border') {
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
          if (r === 0 || c === 0 || r === n - 1 || c === n - 1) this.ice[r][c] = layers;
      } else if (pat === 'center') {
        const a = Math.floor(n / 2) - 2, b = Math.floor(n / 2) + 1;
        for (let r = a; r <= b; r++) for (let c = a; c <= b; c++) this.ice[r][c] = layers;
      } else if (pat === 'checker') {
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
          if ((r + c) % 2 === 0) this.ice[r][c] = layers;
      }
    }

    _buildChains() {
      const cfg = this.levelCfg;
      if (!cfg.chain) { this.chainTotal = 0; return; }
      const n = this.size;
      const count = cfg.chainCount || 0;
      const layers = cfg.chainLayers || 1;
      const pool = [];
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) pool.push([r, c]);
      for (let i = pool.length - 1; i > 0; i--) { const j = randInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      let placed = 0;
      for (const [r, c] of pool) {
        if (placed >= count) break;
        const cell = this.grid[r][c];
        if (cell) { cell.chain = layers; placed++; }
      }
      this.chainTotal = placed;
    }

    _iceRemaining() {
      let n = 0;
      for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) if (this.ice[r][c] > 0) n++;
      return n;
    }

    _chainRemaining() {
      let n = 0;
      for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) {
        const cell = this.grid[r][c];
        if (cell && cell.chain > 0) n++;
      }
      return n;
    }

    _buildBoard() {
      this.grid = [];
      for (let r = 0; r < this.size; r++) {
        const row = [];
        for (let c = 0; c < this.size; c++) {
          let color, attempts = 0;
          do {
            color = randInt(this.colorCount);
            attempts++;
          } while (attempts < 50 && this._createsMatchAt(row, this.grid, r, c, color));
          row.push({ c: color, s: SPECIAL.NONE, chain: 0 });
        }
        this.grid.push(row);
      }
    }

    _createsMatchAt(row, grid, r, c, color) {
      if (c >= 2 && row[c - 1] && row[c - 2] && row[c - 1].c === color && row[c - 2].c === color) return true;
      if (r >= 2 && grid[r - 1][c] && grid[r - 2][c] && grid[r - 1][c].c === color && grid[r - 2][c].c === color) return true;
      return false;
    }

    inBounds(r, c) {
      return r >= 0 && r < this.size && c >= 0 && c < this.size;
    }

    static areAdjacent(a, b) {
      return Math.abs(a.r - b.r) + Math.abs(a.c - b.c) === 1;
    }

    swap(a, b) {
      const t = this.grid[a.r][a.c];
      this.grid[a.r][a.c] = this.grid[b.r][b.c];
      this.grid[b.r][b.c] = t;
    }

    // 返回所有 >=3 同色连段（横/竖），用于检测与特殊方块生成
    findRuns() {
      const runs = [];
      const G = this.grid;
      for (let r = 0; r < this.size; r++) {
        let start = 0;
        for (let c = 1; c <= this.size; c++) {
          const same = c < this.size && G[r][c] && G[r][start] && G[r][c].c === G[r][start].c;
          if (!same) {
            const len = c - start;
            if (len >= 3 && G[r][start]) { const cells = []; for (let k = start; k < c; k++) cells.push({ r, c: k }); runs.push({ cells, dir: 'h', color: G[r][start].c, len }); }
            start = c;
          }
        }
      }
      for (let c = 0; c < this.size; c++) {
        let start = 0;
        for (let r = 1; r <= this.size; r++) {
          const same = r < this.size && G[r][c] && G[start][c] && G[r][c].c === G[start][c].c;
          if (!same) {
            const len = r - start;
            if (len >= 3 && G[start][c]) { const cells = []; for (let k = start; k < r; k++) cells.push({ r: k, c }); runs.push({ cells, dir: 'v', color: G[start][c].c, len }); }
            start = r;
          }
        }
      }
      return runs;
    }

    hasPossibleMove() {
      const test = (a, b) => {
        const ca = this.grid[a.r][a.c], cb = this.grid[b.r][b.c];
        if (!ca || !cb || ca.chain > 0 || cb.chain > 0) return false;
        this.swap(a, b);
        const ok = this.findRuns().length > 0;
        const sp = (this.grid[a.r][a.c] && this.grid[a.r][a.c].s !== SPECIAL.NONE) ||
                   (this.grid[b.r][b.c] && this.grid[b.r][b.c].s !== SPECIAL.NONE);
        this.swap(a, b);
        return ok || sp;
      };
      for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) {
        if (c + 1 < this.size && test({ r, c }, { r, c: c + 1 })) return true;
        if (r + 1 < this.size && test({ r, c }, { r: r + 1, c })) return true;
      }
      return false;
    }

    _reshuffle() {
      let guard = 0;
      do {
        const flat = [];
        for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) flat.push(this.grid[r][c]);
        for (let i = flat.length - 1; i > 0; i--) { const j = randInt(i + 1); [flat[i], flat[j]] = [flat[j], flat[i]]; }
        let idx = 0;
        for (let r = 0; r < this.size; r++) for (let c = 0; c < this.size; c++) this.grid[r][c] = flat[idx++];
        guard++;
      } while ((this.findRuns().length > 0 || !this.hasPossibleMove()) && guard < 50);
    }

    // ---- 动画状态机 ----
    inputLocked() { return this.phase !== PHASE.IDLE; }

    requestSwap(a, b) {
      if (this.phase !== PHASE.IDLE || this.won || this.lost) return;
      if (!Match3Game.areAdjacent(a, b)) return;
      const ca = this.grid[a.r][a.c], cb = this.grid[b.r][b.c];
      if (!ca || !cb || ca.chain > 0 || cb.chain > 0) return; // 锁链方块不可交换
      this.swap(a, b);
      const runs = this.findRuns();
      const specialInvolved = (this.grid[a.r][a.c] && this.grid[a.r][a.c].s !== SPECIAL.NONE) ||
                             (this.grid[b.r][b.c] && this.grid[b.r][b.c].s !== SPECIAL.NONE);
      this.swap(a, b);
      const valid = runs.length > 0 || specialInvolved;
      this.combo = 0;
      this.lastSwap = { a: { r: a.r, c: a.c }, b: { r: b.r, c: b.c } };
      this._pendingSpecials = specialInvolved ? [key(a.r, a.c), key(b.r, b.c)] : null;
      this.phase = PHASE.SWAP;
      this.anim = { a: { r: a.r, c: a.c }, b: { r: b.r, c: b.c }, t: 0, dur: 0.16, valid };
      this.skip = new Set([key(a.r, a.c), key(b.r, b.c)]);
      this.emit('swap', { valid });
    }

    _computeClear() {
      const runs = this.findRuns();
      if (runs.length === 0 && !this._pendingSpecials) return null;
      const clearSet = new Set();
      const createMap = new Map();
      for (const run of runs) for (const cell of run.cells) clearSet.add(key(cell.r, cell.c));
      if (runs.length) {
        const sorted = runs.slice().sort((a, b) => b.len - a.len);
        for (const run of sorted) {
          if (run.len < 4) continue;
          const type = run.len >= 5 ? SPECIAL.BOMB : (run.dir === 'h' ? SPECIAL.ROW : SPECIAL.COL);
          let pick = null;
          if (this.lastSwap) {
            const inRun = run.cells.find(cc =>
              (cc.r === this.lastSwap.a.r && cc.c === this.lastSwap.a.c) ||
              (cc.r === this.lastSwap.b.r && cc.c === this.lastSwap.b.c));
            if (inRun) pick = inRun;
          }
          if (!pick) pick = run.cells[Math.floor(run.cells.length / 2)];
          const k = key(pick.r, pick.c);
          if (createMap.has(k)) continue;
          createMap.set(k, type);
        }
      }
      for (const k of createMap.keys()) clearSet.delete(k);
      const queue = [];
      for (const k of clearSet) { const [r, c] = parseKey(k); if (this.grid[r][c] && this.grid[r][c].s !== SPECIAL.NONE) queue.push(k); }
      if (this._pendingSpecials) { for (const k of this._pendingSpecials) { const [r, c] = parseKey(k); if (this.grid[r][c] && this.grid[r][c].s !== SPECIAL.NONE) queue.push(k); } }
      const activated = new Set();
      const activatedList = [];
      while (queue.length) {
        const k = queue.shift();
        if (activated.has(k)) continue;
        activated.add(k);
        const [r, c] = parseKey(k);
        const cell = this.grid[r][c];
        if (!cell || cell.s === SPECIAL.NONE) continue;
        const affected = [];
        if (cell.s === SPECIAL.ROW) { for (let cc = 0; cc < this.size; cc++) affected.push([r, cc]); }
        else if (cell.s === SPECIAL.COL) { for (let rr = 0; rr < this.size; rr++) affected.push([rr, c]); }
        else if (cell.s === SPECIAL.BOMB) {
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr, nc = c + dc; if (this.inBounds(nr, nc)) affected.push([nr, nc]);
          }
        }
        for (const [ar, ac] of affected) {
          const ak = key(ar, ac);
          clearSet.add(ak);
          const acell = this.grid[ar][ac];
          if (acell && acell.s !== SPECIAL.NONE && !activated.has(ak)) queue.push(ak);
        }
        activatedList.push({ r, c, type: cell.s });
      }
      return { clearSet, createMap, clearCount: clearSet.size, activatedList };
    }

    _beginClear() {
      const res = this._computeClear();
      if (!res) { this._pendingSpecials = null; this._endCascade(); return; }
      this.combo++;
      const gained = res.clearCount * 10 * this.combo;
      this.score += gained;

      // 冰块：被消除命中的格子消掉一层；锁链：命中或相邻消除时断裂一层
      let iceHit = false;
      let chainBroken = false;
      for (const k of res.clearSet) {
        const [r, c] = parseKey(k);
        if (this.ice[r][c] > 0) { this.ice[r][c]--; iceHit = true; }
        const cell = this.grid[r][c];
        if (cell && cell.chain > 0) { cell.chain--; chainBroken = true; } // 直接命中（如炸弹）
        for (const [dr, dc] of DIRS) {
          const nr = r + dr, nc = c + dc;
          if (!this.inBounds(nr, nc)) continue;
          const nb = this.grid[nr][nc];
          if (nb && nb.chain > 0 && !res.clearSet.has(key(nr, nc))) { nb.chain--; chainBroken = true; }
        }
      }
      if (iceHit) this.emit('ice', {});
      if (chainBroken) this.emit('chain', {});

      for (const [k, type] of res.createMap) {
        const [r, c] = parseKey(k);
        this.grid[r][c] = { c: this.grid[r][c].c, s: type, chain: 0 };
        this.emit('special', { type, created: true, combo: this.combo });
      }

      let sr = 0, sc = 0, n = 0;
      for (const k of res.clearSet) { const [r, c] = parseKey(k); sr += r; sc += c; n++; }
      this.pops.push({
        r: n ? sr / n : this.size / 2,
        c: n ? sc / n : this.size / 2,
        text: (this.combo > 1 ? '连击+' : '+') + gained,
        life: 0.8, max: 0.8,
      });

      this.emit('match', { count: res.clearCount, combo: this.combo });
      for (const a of res.activatedList) this.emit('special', { type: a.type, created: false, combo: this.combo });

      this.phase = PHASE.CLEAR;
      this.anim = {
        cells: [...res.clearSet].map(k => { const [r, c] = parseKey(k); return { r, c }; }),
        t: 0, dur: 0.22,
      };
      this.skip = null;
    }

    _endCascade() {
      const iceOk = this._iceRemaining() === 0;
      const reached = this.score >= this.targetScore;
      if (reached && iceOk) { this.won = true; this.emit('win', { level: this.levelIndex }); }
      else if (this.movesLeft <= 0) { this.lost = true; this.emit('lose', {}); }
      if (!this.hasPossibleMove() && !this.won && !this.lost) this._reshuffle();
      this.phase = PHASE.IDLE;
      this.anim = null;
      this.skip = null;
    }

    _beginFall() {
      const sprites = [];
      const newGrid = [];
      for (let r = 0; r < this.size; r++) newGrid.push(new Array(this.size).fill(null));
      for (let c = 0; c < this.size; c++) {
        const src = [];
        for (let r = this.size - 1; r >= 0; r--)
          if (this.grid[r][c]) src.push({ r, cell: this.grid[r][c] });
        let targetR = this.size - 1;
        for (let i = 0; i < src.length; i++) {
          const cell = src[i].cell;
          newGrid[targetR][c] = cell;
          if (src[i].r !== targetR) sprites.push({ cell, fromR: src[i].r, toR: targetR, c, isNew: false });
          targetR--;
        }
        let spawn = -1;
        for (let r = targetR; r >= 0; r--) {
          const cell = { c: randInt(this.colorCount), s: SPECIAL.NONE, chain: 0 };
          newGrid[r][c] = cell;
          sprites.push({ cell, fromR: spawn, toR: r, c, isNew: true });
          spawn--;
        }
      }
      this.grid = newGrid;
      const skip = new Set();
      for (const s of sprites) skip.add(key(s.toR, s.c));
      this.phase = PHASE.FALL;
      this.anim = { sprites, t: 0, dur: 0.26, skip };
      this.skip = skip;
    }

    update(dt) {
      dt = Math.min(dt || 0, 0.05);
      for (const p of this.pops) p.life -= dt;
      this.pops = this.pops.filter(p => p.life > 0);

      if (this.phase === PHASE.IDLE) return;
      this.anim.t += dt;
      if (this.anim.t < this.anim.dur) return;

      switch (this.phase) {
        case PHASE.SWAP:
          if (this.anim.valid) {
            this.swap(this.anim.a, this.anim.b);
            this.movesLeft = Math.max(0, this.movesLeft - 1);
            this.skip = null;
            this._beginClear();
            this._pendingSpecials = null;
          } else {
            this.phase = PHASE.SWAPBACK;
            this.anim = { a: this.anim.a, b: this.anim.b, t: 0, dur: 0.16 };
          }
          break;
        case PHASE.SWAPBACK:
          this.phase = PHASE.IDLE;
          this.anim = null;
          this.skip = null;
          break;
        case PHASE.CLEAR:
          for (const m of this.anim.cells) this.grid[m.r][m.c] = null;
          this.skip = null;
          this._beginFall();
          break;
        case PHASE.FALL:
          this.skip = null;
          this._beginClear();
          break;
      }
    }

    // ---- 渲染 ----
    _drawTile(ctx, px, py, cell, scale, alpha) {
      const s = (this._cell - 8) * (scale == null ? 1 : scale);
      ctx.globalAlpha = alpha == null ? 1 : alpha;
      const x = px - s / 2, y = py - s / 2;
      ctx.fillStyle = COLORS[cell.c];
      this._roundRect(ctx, x, y, s, s, 6);
      ctx.fill();
      if (cell.s !== SPECIAL.NONE) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        this._roundRect(ctx, x + 2, y + 2, s - 4, s - 4, 5);
        ctx.stroke();
        this._drawSpecialIcon(ctx, px, py, s, cell.s);
      }
      // 锁链：灰笼 + 交叉铁栏，随方块一起移动/缩放
      if (cell.chain > 0) {
        ctx.save();
        ctx.fillStyle = 'rgba(15,15,22,0.42)';
        this._roundRect(ctx, x + 1, y + 1, s - 2, s - 2, 6);
        ctx.fill();
        ctx.strokeStyle = '#cfcfd8';
        ctx.lineWidth = 2;
        this._roundRect(ctx, x + 4, y + 4, s - 8, s - 8, 5);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 6, y + 6); ctx.lineTo(x + s - 6, y + s - 6);
        ctx.moveTo(x + s - 6, y + 6); ctx.lineTo(x + 6, y + s - 6);
        ctx.stroke();
        if (cell.chain > 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          for (let i = 0; i < Math.min(cell.chain, 3); i++) {
            ctx.beginPath();
            ctx.arc(px - s * 0.18 + i * s * 0.18, py + s * 0.3, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    _drawSpecialIcon(ctx, cx, cy, size, type) {
      const half = size / 2;
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = Math.max(2, size * 0.08);
      ctx.lineCap = 'round';
      if (type === SPECIAL.ROW) {
        ctx.beginPath(); ctx.moveTo(cx - half * 0.6, cy); ctx.lineTo(cx + half * 0.6, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx - half * 0.72, cy); ctx.lineTo(cx - half * 0.5, cy - size * 0.14); ctx.moveTo(cx - half * 0.72, cy); ctx.lineTo(cx - half * 0.5, cy + size * 0.14); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx + half * 0.72, cy); ctx.lineTo(cx + half * 0.5, cy - size * 0.14); ctx.moveTo(cx + half * 0.72, cy); ctx.lineTo(cx + half * 0.5, cy + size * 0.14); ctx.stroke();
      } else if (type === SPECIAL.COL) {
        ctx.beginPath(); ctx.moveTo(cx, cy - half * 0.6); ctx.lineTo(cx, cy + half * 0.6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy - half * 0.72); ctx.lineTo(cx - size * 0.14, cy - half * 0.5); ctx.moveTo(cx, cy - half * 0.72); ctx.lineTo(cx + size * 0.14, cy - half * 0.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy + half * 0.72); ctx.lineTo(cx - size * 0.14, cy + half * 0.5); ctx.moveTo(cx, cy + half * 0.72); ctx.lineTo(cx + size * 0.14, cy + half * 0.5); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(cx, cy, size * 0.26, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, size * 0.12, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }

    _drawIce(ctx, x0, y0, cell, r, c) {
      const layers = this.ice[r][c];
      if (layers <= 0) return;
      const x = x0 + c * cell + 2, y = y0 + r * cell + 2, s = cell - 4;
      ctx.fillStyle = 'rgba(130,205,255,0.30)';
      this._roundRect(ctx, x, y, s, s, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      this._roundRect(ctx, x + 5, y + 5, s - 10, s - 10, 4);
      ctx.stroke();
      // 多层冰：按剩余层数画小圆点，让玩家看清还要敲几次
      if (layers > 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        const dots = Math.min(layers, 3);
        for (let i = 0; i < dots; i++) {
          ctx.beginPath();
          ctx.arc(x0 + c * cell + cell * (0.36 + i * 0.14), y0 + r * cell + cell * 0.5, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    render(ctx, opts) {
      opts = opts || {};
      const W = opts.width || 360, H = opts.height || 360;
      const boardPx = opts.boardPx || Math.min(W, H);
      const pad = opts.pad || 8, topOffset = opts.topOffset || 0;
      const cell = (boardPx - pad * 2) / this.size;
      this._cell = cell;
      const x0 = (W - boardPx) / 2 + pad;
      const y0 = (H - boardPx) / 2 + pad + topOffset;
      const geo = { cell, x0, y0 };

      ctx.fillStyle = opts.bg || '#15151c';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = opts.boardBg || '#2a2a33';
      ctx.fillRect(x0 - pad, y0 - pad, boardPx, boardPx);

      const cx = (c) => x0 + c * cell + cell / 2;
      const cy = (r) => y0 + r * cell + cell / 2;

      const clearSet = (this.phase === PHASE.CLEAR)
        ? new Set(this.anim.cells.map(m => key(m.r, m.c))) : null;
      const clearT = this.phase === PHASE.CLEAR ? easeOut(this.anim.t / this.anim.dur) : 0;

      for (let r = 0; r < this.size; r++) {
        for (let c = 0; c < this.size; c++) {
          if (this.skip && this.skip.has(key(r, c))) continue;
          const cellObj = this.grid[r][c];
          if (!cellObj) {
            this._drawIce(ctx, x0, y0, cell, r, c);
            ctx.fillStyle = '#33333d';
            this._roundRect(ctx, x0 + c * cell + 2, y0 + r * cell + 2, cell - 4, cell - 4, 6);
            ctx.fill();
            continue;
          }
          let scale = 1, alpha = 1;
          if (clearSet && clearSet.has(key(r, c))) { scale = 1 - 0.7 * clearT; alpha = 1 - 0.85 * clearT; }
          this._drawTile(ctx, cx(c), cy(r), cellObj, scale, alpha);
          this._drawIce(ctx, x0, y0, cell, r, c);
          if (this.selected && this.selected.r === r && this.selected.c === c) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 3;
            this._roundRect(ctx, x0 + c * cell + 2, y0 + r * cell + 2, cell - 4, cell - 4, 6);
            ctx.stroke();
          }
        }
      }

      if (this.phase === PHASE.SWAP || this.phase === PHASE.SWAPBACK) {
        const t = easeInOut(Math.min(this.anim.t / this.anim.dur, 1));
        const A = this.anim.a, B = this.anim.b;
        const cellA = this.grid[A.r][A.c], cellB = this.grid[B.r][B.c];
        let pa, pb;
        if (this.phase === PHASE.SWAP) {
          pa = [cx(A.c) + (cx(B.c) - cx(A.c)) * t, cy(A.r) + (cy(B.r) - cy(A.r)) * t];
          pb = [cx(B.c) + (cx(A.c) - cx(B.c)) * t, cy(B.r) + (cy(A.r) - cy(B.r)) * t];
        } else {
          pa = [cx(B.c) + (cx(A.c) - cx(B.c)) * t, cy(B.r) + (cy(A.r) - cy(B.r)) * t];
          pb = [cx(A.c) + (cx(B.c) - cx(A.c)) * t, cy(A.r) + (cy(B.r) - cy(A.r)) * t];
        }
        if (cellA) this._drawTile(ctx, pa[0], pa[1], cellA);
        if (cellB) this._drawTile(ctx, pb[0], pb[1], cellB);
      }

      if (this.phase === PHASE.FALL) {
        const t = easeOut(Math.min(this.anim.t / this.anim.dur, 1));
        for (const s of this.anim.sprites) {
          const y = cy(s.fromR) + (cy(s.toR) - cy(s.fromR)) * t;
          this._drawTile(ctx, cx(s.c), y, s.cell);
        }
      }

      for (const p of this.pops) {
        const a = p.life / p.max;
        ctx.globalAlpha = a;
        ctx.fillStyle = '#FFD54A';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(p.text, cx(p.c), cy(p.r) - (1 - a) * 24);
        ctx.globalAlpha = 1;
      }

      return geo;
    }

    _roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    cellAt(layout, px, py) {
      const { cell, x0, y0 } = layout;
      const c = Math.floor((px - x0) / cell);
      const r = Math.floor((py - y0) / cell);
      if (this.inBounds(r, c)) return { r, c };
      return null;
    }
  }

  const api = { Match3Game, COLORS, PHASE, SPECIAL, LEVELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.GameCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
