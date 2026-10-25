/**
 * broadcast-cloud.js —— 网页端的云同步模块 + 门店绑定
 *
 * 作用：定时从微信云开发拉一份配置，发现版本变了就应用到本地浏览器，
 *       实现「手机小程序改 → 电脑网页自动生效」。
 *
 * 门店隔离：第一次打开要求输入门店邀请码，绑定后云端记住这台电脑（deviceToken），
 *           之后只同步本店配置。换店 = 重新输一次新店的邀请码，旧店立即失效。
 *           填了同步口令则是管理员，可指定任意门店。
 *
 * 这个文件完全自包含：自己注入按钮、自己画面板，不改动原有 12 个脚本和任何 HTML。
 *
 * 依赖的全局（由前面的脚本提供）：
 *   appState / VOLUME_KEY / PLAYLIST_LOOP_KEY / SCHEDULER_ENABLED_KEY
 *   dbAll / dbGet / dbAdd / dbPut / dbDel / renderAll / toast / Logs / Scheduler
 *
 * 配置存在 localStorage：broadcast.cloud.v1
 *   = { enabled, url, token, deviceToken, storeId, storeName, adminStoreId, lastVersion }
 */
(function () {
  'use strict';

  var CONF_KEY = 'broadcast.cloud.v1';
  var POLL_MS = 20000;
  // 云函数 HTTP 访问服务地址：写死在这里。
  // 店里电脑打开后不需要手填（面板里那个输入框只显示「无需手动填写」，且不可编辑）。
  var DEFAULT_URL = 'https://cloud1-d3gaf5eqqbde1768e-1510684745.ap-shanghai.app.tcloudbase.com/broadcastSync';
  var DEFAULT_STORE_ID = '0101';

  var conf = loadConf();
  var timer = null;
  var busy = false;
  /** 首次打开只自动弹一次绑定框，避免每 20 秒骚扰 */
  var bindPrompted = false;

  function blankConf() {
    return {
      enabled: false,
      url: DEFAULT_URL,
      token: '',
      deviceToken: '',
      storeId: '',
      storeName: '',
      adminStoreId: DEFAULT_STORE_ID,
      lastVersion: 0
    };
  }

  function loadConf() {
    try {
      var raw = localStorage.getItem(CONF_KEY);
      if (!raw) return blankConf();
      var o = JSON.parse(raw);
      return {
        enabled: !!o.enabled,
        url: DEFAULT_URL || o.url || '',
        token: o.token || '',
        deviceToken: o.deviceToken || '',
        storeId: o.storeId || '',
        storeName: o.storeName || '',
        adminStoreId: o.adminStoreId || DEFAULT_STORE_ID,
        lastVersion: Number(o.lastVersion) || 0
      };
    } catch (e) {
      return blankConf();
    }
  }

  function saveConf() {
    try { localStorage.setItem(CONF_KEY, JSON.stringify(conf)); } catch (e) { /* ignore */ }
  }

  /** 这台电脑是否已经有身份（设备绑定 或 管理员口令） */
  function hasIdentity() {
    return !!(conf.deviceToken || conf.token);
  }

  function storeLabel() {
    if (conf.storeName) return conf.storeName;
    if (conf.token) return '管理员模式（未指定门店）';
    return '未绑定门店';
  }

  /* ------------------------------------------------------------------ */
  /* 面板 UI                                                             */
  /* ------------------------------------------------------------------ */

  var styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    var s = document.createElement('style');
    s.textContent = [
      // 顶部胶囊按钮（放在「导入配置」后面，沿用 .btn 的配色，只改成胶囊形）
      '#cloudSyncBtn{border-radius:999px;padding:6px 14px;gap:7px;}',
      '#cloudSyncBtn .cs-dot{width:7px;height:7px;border-radius:50%;background:#c2c8d4;flex:none;',
      'transition:background .2s,box-shadow .2s;}',
      '#cloudSyncBtn.on .cs-dot{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18);}',
      '#cloudSyncBtn.err .cs-dot{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.18);}',
      '.cloud-row{display:flex;align-items:center;gap:10px;margin:10px 0;}',
      '.cloud-label{width:88px;flex:none;font-size:13px;color:var(--text-2,#5a6270);}',
      '.cloud-row input[type=text],.cloud-row input[type=password],.cloud-row select{flex:1;min-width:0;padding:7px 10px;',
      'border:1px solid var(--border,#e8ecf4);border-radius:8px;font-size:13px;font-family:inherit;}',
      // 写死的同步地址：只读占位，灰字提示，防止员工误删
      '.cloud-row input.cloud-locked{color:#c2c8d4;background:rgba(120,140,180,.06);cursor:not-allowed;}',
      '.cloud-row input.cloud-locked::placeholder{color:#c2c8d4;}',
      // 胶囊开关：沿用站内 .switch 的尺寸与配色，这里只保证不被 .cloud-row 拉伸
      '.cloud-row .switch{flex:none;width:38px;height:22px;margin:0;}',
      '.cloud-hint{font-size:12px;color:var(--text-3,#8a93a5);line-height:1.7;}',
      '.cloud-status{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12px;',
      'background:rgba(120,140,180,.08);color:var(--text-2,#5a6270);word-break:break-all;}',
      '.cloud-store{margin-top:10px;padding:8px 12px;border-radius:8px;font-size:13px;',
      'background:rgba(42,155,116,.1);border:1px solid rgba(42,155,116,.25);color:#1a7f5a;}',
      '.cloud-store b{font-weight:600;}'
    ].join('');
    document.head.appendChild(s);
  }

  function setDot(state, text) {
    var btn = document.getElementById('cloudSyncBtn');
    if (!btn) return;
    btn.classList.remove('on', 'err');
    if (state === 'ok') btn.classList.add('on');
    if (state === 'err') btn.classList.add('err');
    var label = btn.querySelector('.txt');
    if (label && text) label.textContent = text;
  }

  /** 把胶囊按钮插到顶部「导入配置」按钮的后面 */
  function injectHeaderButton() {
    if (document.getElementById('cloudSyncBtn')) return;
    injectStyle();

    var btn = document.createElement('button');
    btn.id = 'cloudSyncBtn';
    btn.type = 'button';
    btn.className = 'btn';
    btn.setAttribute('data-tip', '云同步：在手机小程序上改设置，电脑网页自动生效');
    btn.innerHTML =
      '<span class="cs-dot"></span>' +
      '<span class="txt">云同步</span>';
    btn.onclick = openPanel;

    var anchor = document.getElementById('btnImportConfig');
    if (anchor && anchor.parentNode) {
      // 紧跟「导入配置」之后
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    } else {
      var actions = document.querySelector('.header .actions');
      if (actions) actions.appendChild(btn);
      else document.body.appendChild(btn);
    }

    if (conf.enabled && hasIdentity()) setDot('ok', '云同步');
  }

  function openPanel() {
    var html = [
      '<div class="cloud-hint">',
      '手机小程序改的配置会存到微信云开发，电脑这边定时拉取并自动应用。<br>',
      '第一次使用需要先「绑定/换绑门店」：输入门店邀请码，绑定后只同步本店配置。',
      '</div>',
      '<div class="cloud-store">当前门店：<b>', escapeAttr(storeLabel()), '</b></div>',
      '<div class="cloud-row"><span class="cloud-label">同步地址</span>',
      '<input type="text" class="cloud-locked" value="" placeholder="无需手动填写" disabled></div>',
      '<div class="cloud-row"><span class="cloud-label">同步口令</span>',
      '<input type="password" id="cloudToken" placeholder="选填：填了就是管理员，可看任意门店" value="',
      escapeAttr(conf.token), '"></div>',
      '<div class="cloud-row"><span class="cloud-label">管理门店</span>',
      '<select id="cloudStore"><option value="">（仅管理员可用）</option></select></div>',
      '<div class="cloud-row"><span class="cloud-label">自动同步</span>',
      '<label class="switch"><input type="checkbox" id="cloudEnabled"', conf.enabled ? ' checked' : '',
      '><span class="slider"></span></label>',
      '<span class="cloud-hint" style="margin-left:8px;">每 20 秒检查一次</span></div>',
      '<div class="cloud-status" id="cloudStatus">',
      conf.enabled && hasIdentity() ? '等待第一次同步…' : (hasIdentity() ? '尚未开启' : '还没有绑定门店'),
      '</div>'
    ].join('');

    showModal('云同步设置', html, [
      { text: '保存', primary: true, tip: '保存设置；开启了自动同步就开始拉取', onClick: onSaveOnly },
      { text: '绑定/换绑门店', tip: '输入门店邀请码，绑定后只同步该门店', onClick: openBindPanel },
      { text: '上传当前配置', tip: '把电脑上现在的配置推到云端，手机小程序就能看到', onClick: onPush },
      { text: '立即拉取', tip: '马上从云端拉一次', onClick: onPullNow },
      { text: '初始化门店', tip: '仅管理员：创建 6 家门店，并把旧配置迁给 1 号店', onClick: onSetup },
      { text: '关闭', onClick: hideModal }
    ]);

    fillStoreOptions();
  }

  /** 管理员：把 6 家门店填进下拉框 */
  async function fillStoreOptions() {
    var sel = document.getElementById('cloudStore');
    if (!sel) return;
    if (!conf.token) {
      sel.disabled = true;
      sel.innerHTML = '<option value="">（仅管理员可用）</option>';
      return;
    }
    try {
      var r = await getJson({ action: 'stores', token: conf.token });
      var stores = (r.stores || []);
      if (!stores.length) {
        sel.innerHTML = '<option value="">（还没有门店，先点「初始化门店」）</option>';
        return;
      }
      var cur = conf.adminStoreId || DEFAULT_STORE_ID;
      sel.innerHTML = stores
        .map(function (s) {
          return (
            '<option value="' + escapeAttr(s.storeId) + '"' +
            (s.storeId === cur ? ' selected' : '') + '>' +
            escapeAttr(s.storeName) + '（' + escapeAttr(s.storeId) + '）</option>'
          );
        })
        .join('');
      sel.onchange = function () {
        conf.adminStoreId = sel.value || DEFAULT_STORE_ID;
        conf.lastVersion = 0;
        saveConf();
        restart();
        panelStatus('已切换到 ' + ((sel.options[sel.selectedIndex] || {}).text || ''));
      };
    } catch (e) {
      sel.innerHTML = '<option value="">读取门店失败：' + escapeAttr(e.message) + '</option>';
    }
  }

  function readPanel() {
    var t = document.getElementById('cloudToken');
    var e = document.getElementById('cloudEnabled');
    var s = document.getElementById('cloudStore');
    return {
      // 地址写死在 DEFAULT_URL 里，界面上不可编辑，这里只是兜底
      url: conf.url || DEFAULT_URL,
      token: (t && t.value || '').trim(),
      enabled: !!(e && e.checked),
      storeId: (s && !s.disabled && s.value) || ''
    };
  }

  function panelStatus(text) {
    var el = document.getElementById('cloudStatus');
    if (el) el.textContent = text;
  }

  function onSaveOnly() {
    var v = readPanel();
    conf.url = v.url;
    conf.token = v.token;
    if (v.storeId) conf.adminStoreId = v.storeId;
    conf.enabled = v.enabled;
    saveConf();
    hideModal();
    restart();
    toast(conf.enabled ? '云同步已开启' : '云同步已关闭', conf.enabled ? 'success' : 'info');
  }

  async function onPullNow() {
    var v = readPanel();
    conf.url = v.url;
    conf.token = v.token;
    if (v.storeId) conf.adminStoreId = v.storeId;
    saveConf();
    if (!conf.url) { panelStatus('请先填同步地址'); return; }
    if (!hasIdentity()) { panelStatus('还没有绑定门店，先点「绑定/换绑门店」'); return; }
    panelStatus('正在拉取…');
    try {
      var data = await fetchState();
      if (!data.config) { panelStatus('本店云端还没有配置，先点「上传当前配置」'); return; }
      var first = !conf.lastVersion;
      conf.lastVersion = data.version;
      saveConf();
      await applyConfig(data.config, data.version, first);
      panelStatus('已拉取并应用（' + (data.storeName || '') + '），云端版本 ' + data.version);
      hideModal();
      toast('已应用云端配置 v' + data.version, 'success');
    } catch (e) {
      panelStatus('拉取失败：' + e.message);
    }
  }

  async function onPush() {
    var v = readPanel();
    conf.url = v.url;
    conf.token = v.token;
    if (v.storeId) conf.adminStoreId = v.storeId;
    saveConf();
    if (!conf.url) { panelStatus('请先填同步地址'); return; }
    if (!hasIdentity()) { panelStatus('还没有绑定门店，先点「绑定/换绑门店」'); return; }
    panelStatus('正在上传…');
    try {
      var payload = await buildLocalConfig();
      var r = await pushState(payload);
      conf.lastVersion = r.version;
      conf.enabled = true;
      saveConf();
      restart();
      panelStatus('上传成功，云端版本 ' + r.version);
      toast('已上传到云端 v' + r.version, 'success');
      Logs.info('云同步：上传配置 v' + r.version);
    } catch (e) {
      panelStatus('上传失败：' + e.message);
      toast('上传失败：' + e.message, 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 门店绑定                                                            */
  /* ------------------------------------------------------------------ */

  /** 首次打开 / 换店时的绑定面板 */
  function openBindPanel() {
    if (typeof hideModal === 'function') hideModal();

    setTimeout(function () {
      var html = [
        '<div class="cloud-hint">',
        '每台电脑绑定一家门店，绑定后只同步这家店的配置，别的店改不动这台电脑。<br>',
        '员工调店时，在这里输入新门店的邀请码即可，旧门店立即失效。<br>',
        '填了同步口令可以不填邀请码，直接以管理员身份指定任意门店。</div>',
        '<div class="cloud-row"><span class="cloud-label">同步地址</span>',
        '<input type="text" class="cloud-locked" value="" placeholder="无需手动填写" disabled></div>',
        '<div class="cloud-row"><span class="cloud-label">门店邀请码</span>',
        '<input type="text" id="bindCode" maxlength="12" placeholder="4-12 位字母或数字"></div>',
        '<div class="cloud-row"><span class="cloud-label">同步口令</span>',
        '<input type="password" id="bindToken" placeholder="选填：管理员用" value="',
        escapeAttr(conf.token), '"></div>',
        '<div class="cloud-status" id="bindStatus">当前门店：', escapeAttr(storeLabel()), '</div>'
      ].join('');

      showModal('绑定门店', html, [
        { text: '绑定', primary: true, tip: '绑定后本机只同步该门店', onClick: onBindSubmit },
        { text: '取消', onClick: hideModal }
      ]);
    }, 220);
  }

  function bindStatus(text) {
    var el = document.getElementById('bindStatus');
    if (el) el.textContent = text;
  }

  async function onBindSubmit() {
    var codeEl = document.getElementById('bindCode');
    var tokenEl = document.getElementById('bindToken');

    var code = (codeEl && codeEl.value || '').trim();
    var token = (tokenEl && tokenEl.value || '').trim();

    // 地址是写死的，这里不再让用户填，也不可能被删掉
    conf.url = conf.url || DEFAULT_URL;
    conf.token = token;
    saveConf();

    // 管理员：只填口令不填邀请码 → 按口令访问任意门店
    if (token && !code) {
      conf.deviceToken = '';
      conf.lastVersion = 0;
      saveConf();
      bindStatus('已切换到管理员模式');
      restart();
      setTimeout(function () { hideModal(); tick(); }, 400);
      return;
    }

    if (!/^[0-9A-Za-z]{4,12}$/.test(code)) {
      return bindStatus('邀请码是 4-12 位字母或数字');
    }

    bindStatus('正在绑定…');
    try {
      var r = await postJson({
        action: 'bind',
        token: conf.token,
        inviteCode: code,
        deviceToken: conf.deviceToken,
        label: 'web'
      });
      if (!r.ok) throw new Error(r.error || '绑定失败');

      if (r.deviceToken) conf.deviceToken = r.deviceToken;
      conf.storeId = r.storeId || '';
      conf.storeName = r.storeName || '';
      conf.enabled = true;
      // 换了门店就当作第一次同步：只合并不删除，避免误清本机播报
      conf.lastVersion = 0;
      saveConf();

      bindStatus('已绑定 ' + (r.storeName || r.storeId));
      restart();
      toast('已绑定' + (r.storeName || '门店'), 'success');

      setTimeout(function () {
        hideModal();
        tick();
      }, 500);
    } catch (e) {
      bindStatus('绑定失败：' + e.message);
    }
  }

  /** 管理员：一键建 6 家门店 + 把旧配置迁给 1 号店 */
  async function onSetup() {
    if (!conf.token) { panelStatus('需要先填同步口令（管理员）'); return; }
    panelStatus('正在初始化门店…');
    try {
      var r = await postJson({ action: 'setup', token: conf.token });
      if (!r.ok) throw new Error(r.error || '初始化失败');
      var msg = '初始化完成';
      if (r.created && r.created.length) msg += '，新建 ' + r.created.length + ' 家门店';
      if (r.migrated) msg += '，旧配置已迁给 1 号店';
      panelStatus(msg);
      toast(msg, 'success');
      await fillStoreOptions();
    } catch (e) {
      panelStatus('初始化失败：' + e.message);
    }
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ------------------------------------------------------------------ */
  /* 与云函数通信                                                        */
  /* ------------------------------------------------------------------ */

  function withQuery(base, params) {
    var q = Object.keys(params)
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + q;
  }

  function toError(data) {
    var e = new Error(data.error || '云函数返回异常');
    if (data.errCode) e.code = String(data.errCode);
    return e;
  }

  /** GET：读配置。管理员带 storeId，员工带 deviceToken，门店由云函数算出来 */
  async function fetchState() {
    var params = { action: 'get', _: Date.now() };
    if (conf.token) {
      params.token = conf.token;
      params.storeId = conf.adminStoreId || DEFAULT_STORE_ID;
    } else if (conf.deviceToken) {
      params.deviceToken = conf.deviceToken;
    }

    var res = await fetch(withQuery(conf.url, params), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data.ok) throw toError(data);

    // 云端才是准的，本地只做展示缓存
    if (data.storeName || data.storeId) {
      conf.storeName = data.storeName || '';
      conf.storeId = data.storeId || '';
      saveConf();
    }
    return data;
  }

  /** GET：门店列表（管理员）等只读接口 */
  async function getJson(params) {
    var res = await fetch(withQuery(conf.url, Object.assign({ _: Date.now() }, params)), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!data.ok) throw toError(data);
    return data;
  }

  /** POST：写配置 / 绑定 / 初始化 */
  async function postJson(payload) {
    // 故意用 text/plain：这样不会触发 CORS 预检，云开发的 HTTP 访问服务更省事
    var res = await fetch(conf.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }

  async function pushState(config) {
    var data = await postJson({
      action: 'set',
      token: conf.token,
      deviceToken: conf.deviceToken,
      storeId: conf.token ? (conf.adminStoreId || DEFAULT_STORE_ID) : undefined,
      config: config,
      by: 'web'
    });
    if (!data.ok) throw toError(data);
    return data;
  }

  /* ------------------------------------------------------------------ */
  /* 本地配置的读 / 写                                                   */
  /* ------------------------------------------------------------------ */

  async function buildLocalConfig() {
    var list = await dbAll('playlist');
    list.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    // 只带云同步需要改的字段，音频二进制不传
    var slim = list.map(function (it) {
      return {
        id: it.id,
        type: it.type,
        refId: it.refId || null,
        name: it.name || '',
        customName: it.customName || '',
        text: it.text || '',
        voice: it.voice || '',
        rate: typeof it.rate === 'number' ? it.rate : 1,
        pitch: typeof it.pitch === 'number' ? it.pitch : 1,
        volume: typeof it.volume === 'number' ? it.volume : 1,
        enabled: !!it.enabled,
        loop: !!it.loop,
        interval: Number(it.interval) || 0,
        playCount: Number(it.playCount) || 0,
        activeRanges: Array.isArray(it.activeRanges) ? it.activeRanges : [],
        order: Number(it.order) || 0,
        createdAt: it.createdAt || Date.now()
      };
    });
    return {
      globalVolume: appState.volume,
      playlistLoop: !!appState.playlistLoop,
      schedulerEnabled: !!appState.schedulerEnabled,
      playlist: slim,
      updatedBy: 'web'
    };
  }

  async function applyConfig(cfg, version, isFirst) {
    var changed = 0;

    // 1) 全局设置
    if (typeof cfg.globalVolume === 'number' && Math.abs(cfg.globalVolume - appState.volume) > 0.001) {
      appState.volume = Math.max(0, Math.min(1, cfg.globalVolume));
      localStorage.setItem(VOLUME_KEY, String(appState.volume));
      changed++;
    }
    if (typeof cfg.playlistLoop === 'boolean' && cfg.playlistLoop !== appState.playlistLoop) {
      appState.playlistLoop = cfg.playlistLoop;
      localStorage.setItem(PLAYLIST_LOOP_KEY, appState.playlistLoop ? '1' : '0');
      changed++;
    }
    if (typeof cfg.schedulerEnabled === 'boolean' && cfg.schedulerEnabled !== appState.schedulerEnabled) {
      appState.schedulerEnabled = cfg.schedulerEnabled;
      localStorage.setItem(SCHEDULER_ENABLED_KEY, appState.schedulerEnabled ? '1' : '0');
      changed++;
    }

    // 2) 播放列表：按 id 合并
    var incoming = Array.isArray(cfg.playlist) ? cfg.playlist : [];
    var local = await dbAll('playlist');

    // 云端新建的 TTS 没有音色（手机端拿不到电脑的语音列表），
    // 这里用电脑上「首选中文语音」（晓晓优先）补上，否则会退化成系统默认音色。
    var needVoice = incoming.some(function (x) {
      return x && x.type === 'tts' && !x.voice;
    });
    var voices = [];
    if (needVoice) {
      try {
        voices = (TTS.voices && TTS.voices.length) ? TTS.voices : await TTS.refreshVoices();
      } catch (e) {
        voices = [];
      }
    }
    if (needVoice) {
      for (var v = 0; v < incoming.length; v++) {
        var iv = incoming[v];
        if (iv && iv.type === 'tts' && !iv.voice && voices && voices.length) {
          var picked = pickPreferredVoice(voices, '');
          if (picked) iv.voice = picked;
        }
      }
    }

    var localById = {};
    local.forEach(function (x) { localById[x.id] = x; });
    var incomingIds = {};
    incoming.forEach(function (x) { incomingIds[x.id] = true; });

    for (var i = 0; i < incoming.length; i++) {
      var it = incoming[i];
      if (!it || !it.id) continue;
      var prev = localById[it.id];
      if (prev) {
        // 合并：云端字段覆盖，本地独有的（比如音频 refId 的 blob 关联）保留
        var merged = Object.assign({}, prev, it);
        // audio 类型的 refId 不能丢
        if (prev.type === 'audio' && prev.refId) merged.refId = prev.refId;
        await dbPut('playlist', merged);
        changed++;
      } else {
        // 云端新增项：音频项目依赖本地音频文件，没有 refId 就跳过
        if (it.type === 'audio' && !it.refId) continue;
        await dbAdd('playlist', it);
        changed++;
      }
    }

    // 3) 删除：云端已经没有的 TTS 项。音频项不删（可能是电脑上新加的）
    //
    // 安全阀：第一次同步（本地还没有版本基线）时**绝不删除**。
    // 否则一旦云端是「空白配置」（比如手机上误点了“用空白配置开始”），
    // 电脑上辛苦建的播报会被一次拉取全部清空。
    if (isFirst) {
      Logs.info('云同步：首次同步，只合并不删除（避免误清本地数据）');
    } else {
      for (var j = 0; j < local.length; j++) {
        var l = local[j];
        if (!incomingIds[l.id] && l.type === 'tts' && !l.localOnly) {
          await dbDel('playlist', l.id);
          changed++;
        }
      }
    }

    // 4) 刷新界面 + 让调度器真正跟随云端的「启用调度」开关
    renderAll();
    try {
      var running = Scheduler.isRunning();
      if (appState.schedulerEnabled && !running) {
        Scheduler.start();               // 手机端点“启动” → 电脑这边真的开始调度
        Logs.info('云同步：按云端设置启动调度');
      } else if (!appState.schedulerEnabled && running) {
        Scheduler.stop();                // 手机端点“停止” → 电脑这边真的暂停
        Logs.info('云同步：按云端设置暂停调度');
      }
      // 已经开着的话不用重启：Scheduler.tick() 每秒都会重新 loadPlaylist()
      updateStateUI();
    } catch (e) {
      console.warn('[cloud] 调度器跟随失败', e);
    }

    Logs.info('云同步：应用云端配置 v' + version + '（变更 ' + changed + ' 处）');
    return changed;
  }

  /* ------------------------------------------------------------------ */
  /* 轮询                                                                */
  /* ------------------------------------------------------------------ */

  async function tick() {
    if (busy || !conf.enabled || !conf.url || !hasIdentity()) return;
    busy = true;
    try {
      var data = await fetchState();
      if (data.version > conf.lastVersion && data.config) {
        var wasFirst = !conf.lastVersion;
        conf.lastVersion = data.version;
        saveConf();
        await applyConfig(data.config, data.version, wasFirst);
        setDot('ok', '云同步');
        toast('已应用手机端的配置 v' + data.version, 'success');
      } else if (data.version) {
        setDot('ok', '云同步');
      }
    } catch (e) {
      if (e.code === 'NEED_BIND' || e.code === 'DEVICE_REPLACED') {
        // 还没绑定 / 被别的电脑顶掉了：只提示一次，别每 20 秒弹一次
        setDot('err', '未绑定门店');
        if (!bindPrompted) {
          bindPrompted = true;
          openBindPanel();
        }
        return;
      }
      setDot('err', '同步失败');
      console.warn('[cloud] 同步失败：', e.message);
    } finally {
      busy = false;
    }
  }

  function restart() {
    if (timer) { clearInterval(timer); timer = null; }
    if (conf.enabled && conf.url && hasIdentity()) {
      setDot('ok', '云同步');
      timer = setInterval(tick, POLL_MS);
      setTimeout(tick, 1500);
    } else {
      setDot('', '云同步');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */
  function boot() {
    injectHeaderButton();
  }

  // 按钮必须和左边的其他按钮「同一帧」出现。
  // 这个脚本是 </body> 前最后一个 <script>，执行时 #btnImportConfig 已经在 DOM 里，
  // 直接同步插入即可。以前走 DOMContentLoaded + setTimeout(1200)，
  // 于是云同步按钮比左边一排按钮晚一秒多才冒出来，头部还会跟着抖一下。
  boot();

  // 轮询单独延后启动：不影响按钮出现，也避免和主脚本的初始化抢时间
  function startPolling() {
    setTimeout(function () {
      restart();
      // 首次打开（还没有设备绑定也没有口令）→ 主动弹一次绑定框
      if (!hasIdentity() && !bindPrompted) {
        bindPrompted = true;
        openBindPanel();
      }
    }, 600);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startPolling);
  } else {
    startPolling();
  }

  // 暴露给控制台调试
  window.CloudSync = {
    getConf: function () { return conf; },
    pull: tick,
    apply: applyConfig,
    build: buildLocalConfig,
    bind: openBindPanel,
    setup: onSetup
  };
})();
