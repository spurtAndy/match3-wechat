// profile-store.js —— 平台无关的「多玩家档案」存储
//
// 设计：每个玩家档案 = 一个独立数据文件，存放在 profiles/<id>.json；
//       另有 profiles/index.json 记录档案列表与当前选中档案。
// 底层读写通过注入的 adapter 完成，两端各自实现：
//   微信小游戏 -> 真实文件系统（wx.getFileSystemManager + wx.env.USER_DATA_PATH，
//                 该目录本身按微信用户隔离，天然「每个用户数据分开」）
//   网页       -> localStorage（以 "m3fs:profiles/<id>.json" 键模拟文件）
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.ProfileStore = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const DIR = 'profiles';            // 档案目录
  const INDEX = DIR + '/index.json'; // 档案索引文件

  class ProfileStore {
    constructor(adapter) {
      // adapter: { readFile(name), writeFile(name, str), removeFile(name) }
      this.adapter = adapter;
      this._index = null;
    }

    _file(id) { return DIR + '/' + id + '.json'; }

    // ---- 索引（档案列表 + 当前档案）----
    loadIndex() {
      if (this._index) return this._index;
      let idx = null;
      try {
        const raw = this.adapter.readFile(INDEX);
        if (raw) idx = JSON.parse(raw);
      } catch (e) { idx = null; }
      if (!idx || !Array.isArray(idx.profiles)) idx = { profiles: [], currentId: null };
      this._index = idx;
      return idx;
    }

    _saveIndex() {
      try { this.adapter.writeFile(INDEX, JSON.stringify(this._index)); } catch (e) {}
    }

    list() { return this.loadIndex().profiles.slice(); }
    count() { return this.loadIndex().profiles.length; }
    getCurrentId() { return this.loadIndex().currentId; }

    setCurrent(id) {
      const idx = this.loadIndex();
      idx.currentId = id;
      this._saveIndex();
    }

    get(id) { return this.loadIndex().profiles.find(p => p.id === id) || null; }
    getCurrent() { return this.get(this.loadIndex().currentId); }

    // ---- 新建档案（同时落一个独立数据文件）----
    create(name) {
      const idx = this.loadIndex();
      const id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100);
      const profile = {
        id,
        name: (name && String(name).trim()) || ('玩家' + (idx.profiles.length + 1)),
        level: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      idx.profiles.push(profile);
      idx.currentId = id;
      this._saveIndex();
      this._write(profile);
      return profile;
    }

    _write(profile) {
      try { this.adapter.writeFile(this._file(profile.id), JSON.stringify(profile)); } catch (e) {}
    }

    // 读取某档案的独立数据文件（不存在时回退到索引记录）
    loadData(id) {
      try {
        const raw = this.adapter.readFile(this._file(id));
        if (raw) return JSON.parse(raw);
      } catch (e) {}
      return this.get(id);
    }

    // 更新档案（关卡进度等），同步写索引与数据文件
    update(id, patch) {
      const idx = this.loadIndex();
      const p = idx.profiles.find(x => x.id === id);
      if (!p) return null;
      Object.assign(p, patch, { updatedAt: Date.now() });
      this._saveIndex();
      this._write(p);
      return p;
    }

    remove(id) {
      const idx = this.loadIndex();
      idx.profiles = idx.profiles.filter(x => x.id !== id);
      if (idx.currentId === id) idx.currentId = idx.profiles.length ? idx.profiles[0].id : null;
      this._saveIndex();
      try { this.adapter.removeFile(this._file(id)); } catch (e) {}
    }

    // 把旧版单存档（match3_level）迁移成第一个档案，避免老玩家进度丢失
    migrateLegacy(legacyLevel) {
      const idx = this.loadIndex();
      if (idx.profiles.length > 0) return null;
      const lv = Math.max(0, parseInt(legacyLevel, 10) || 0);
      const p = this.create('我的档案');
      if (lv > 0) this.update(p.id, { level: lv });
      return p;
    }
  }

  return { ProfileStore, DIR, INDEX };
});
