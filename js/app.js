(function () {
  'use strict';

  const CFG = Object.assign({ owner: 'ju3236', repo: 'OC_backup', branch: 'main' }, window.OC_CONFIG || {});
  const API = 'https://api.github.com';
  const REPO = `/repos/${CFG.owner}/${CFG.repo}`;
  const RAW = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/`;
  const DB_PATH = 'data/db.json';
  const ACC_PATH = 'data/accounts.json';
  const SESSION_KEY = 'oc-backup-session';
  const PBKDF2_ITER = 310000;
  const MAX_IMAGE_SIDE = 1600;

  const $app = document.getElementById('app');
  const $banner = document.getElementById('banner');
  const $lightbox = document.getElementById('lightbox');

  const state = {
    db: null,
    loadedAt: 0,
    token: '',
    user: null,         // { login, admin }
    key: null,          // 계정 공용 키 (토큰을 여는 열쇠)
    accounts: null,     // data/accounts.json
    filter: { q: '', world: '', tag: '', owner: '' },
    docFilter: { q: '', world: '', tag: '', owner: '' },
    postFilter: { owner: '' },
    draft: null,
    localImgs: {},      // 이번 세션에 업로드한 그림 미리보기 (path -> dataURL)
    legacy: null,       // 예전 버전에서 이 브라우저에 저장된 캐릭터
    busy: false,
  };

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function safeSrc(src) {
    src = String(src || '').trim();
    if (!src) return '';
    if (/^(https?:|data:image\/|blob:)/i.test(src)) return src;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return ''; // javascript: 등 차단
    return src;
  }
  function imgUrl(src) {
    if (state.localImgs[src]) return state.localImgs[src];
    src = safeSrc(src);
    if (/^images\//.test(src)) return RAW + src.split('/').map(encodeURIComponent).join('/');
    return src;
  }
  const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#5b7fd6');
  const uid = (p) => (p || 'oc') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const db = () => state.db;
  const findChar = (id) => db().characters.find((c) => c.id === id);
  const findPost = (id) => db().posts.find((p) => p.id === id);
  const coverOf = (c) => (c.avatar && c.images.some((i) => i.src === c.avatar) ? c.avatar : (c.images[0] && c.images[0].src) || '');
  const initialOf = (c) => esc((c.name || '?').trim().charAt(0) || '?');
  const memberName = (login) => (login && db().members[login] && db().members[login].name) || login || '알 수 없음';
  const isMine = (owner) => !!state.user && (state.user.admin || !owner || owner === state.user.login);
  const encId = encodeURIComponent;

  function thumbHtml(c) {
    const src = coverOf(c);
    return src
      ? `<img src="${esc(imgUrl(src))}" alt="${esc(c.name)}" loading="lazy">`
      : `<span class="initial">${initialOf(c)}</span>`;
  }
  function avatarHtml(login, cls) {
    if (!login) return '';
    let h = 0;
    for (const ch of login) h = (h * 31 + ch.codePointAt(0)) % 360;
    return `<span class="avatar ${cls || ''}" style="background:hsl(${h} 50% 55%)" aria-hidden="true">${esc([...memberName(login)][0] || '?')}</span>`;
  }
  function byline(login, iso) {
    return `<span class="byline">${avatarHtml(login)}<span>${esc(memberName(login))}</span>${iso ? `<span class="dot">·</span><time>${esc(fmtDate(iso))}</time>` : ''}</span>`;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const diff = (Date.now() - d) / 1000;
    if (diff < 60) return '방금';
    if (diff < 3600) return Math.floor(diff / 60) + '분 전';
    if (diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + '일 전';
    return d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function toast(msg, ms) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    if (ms !== 0) setTimeout(() => t.remove(), ms || 2400);
    return t;
  }
  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

  function b64ToUtf8(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ---------- data model ----------
  const str = (v) => String(v == null ? '' : v);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const normImages = (v) => arr(v).filter((i) => i && i.src).map((i) => ({ src: str(i.src), caption: str(i.caption) }));

  function normalizeChar(c) {
    const now = new Date().toISOString();
    return {
      id: str(c.id) || uid('oc'),
      owner: str(c.owner),
      name: str(c.name) || '이름 없음',
      subname: str(c.subname),
      world: str(c.world),
      summary: str(c.summary),
      color: safeColor(c.color),
      avatar: str(c.avatar),
      tags: arr(c.tags).map(str).filter(Boolean),
      kind: c.kind === 'doc' ? 'doc' : 'oc',
      doc: 3,
      notices: arr(c.notices).map((n) => ({ icon: str(n.icon) || '⚠️', text: str(n.text) })),
      // doc 3 이전(글자만 쓰던 시절) 데이터는 HTML로 바꿔서 읽어요
      profile: arr(c.profile).map((p) => ({
        type: p.type === 'head' ? 'head' : 'row',
        label: str(p.label),
        value: p.type === 'head' ? '' : (c.doc === 3 ? str(p.value) : textToHtml(str(p.value))),
      })),
      chapters: Array.isArray(c.chapters) ? normChapters(c.chapters, 0)
        : arr(c.sections).map((x) => ({ id: uid('ch'), title: str(x.title), body: x.body ? `<p>${textToHtml(str(x.body))}</p>` : '', children: [] })),
      images: normImages(c.images),
      relations: arr(c.relations).map((r) => ({ id: str(r.id), name: str(r.name), type: str(r.type), note: str(r.note) })),
      createdAt: c.createdAt || now,
      updatedAt: c.updatedAt || now,
    };
  }
  function normChapters(list, depth) {
    return arr(list).map((ch) => ({
      id: str(ch.id) || uid('ch'),
      title: str(ch.title),
      body: str(ch.body),
      children: depth < 6 ? normChapters(ch.children, depth + 1) : [],
    }));
  }
  function normalizePost(p) {
    const now = new Date().toISOString();
    return {
      id: str(p.id) || uid('post'),
      author: str(p.author),
      title: str(p.title),
      body: str(p.body),
      images: normImages(p.images),
      chars: arr(p.chars).map(str).filter(Boolean),
      createdAt: p.createdAt || now,
      updatedAt: p.updatedAt || now,
    };
  }
  function normalizeComment(c) {
    return { id: str(c.id) || uid('cm'), target: str(c.target), author: str(c.author), body: str(c.body), createdAt: c.createdAt || new Date().toISOString() };
  }
  function normalizeDb(d) {
    d = d || {};
    const members = {};
    Object.entries(d.members && typeof d.members === 'object' ? d.members : {}).forEach(([k, v]) => {
      members[k] = { name: str(v && v.name) };
    });
    return {
      version: 2,
      siteTitle: str(d.siteTitle) || '자캐 백업',
      members,
      characters: arr(d.characters).map(normalizeChar),
      posts: arr(d.posts).map(normalizePost),
      comments: arr(d.comments).map(normalizeComment),
      templates: arr(d.templates).map(normalizeTemplate),
    };
  }

  // ---------- GitHub ----------
  async function gh(method, path, body) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch (e) { /* ignore */ }
      const err = new Error(`GitHub ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  // 저장소의 JSON 파일을 읽어요. 없으면 null.
  async function readJsonAt(path, ref) {
    let meta;
    try {
      meta = await gh('GET', `${REPO}/contents/${path}?ref=${encId(ref)}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
    if (meta.content && meta.encoding === 'base64') return JSON.parse(b64ToUtf8(meta.content));
    const blob = await gh('GET', `${REPO}/git/blobs/${meta.sha}`); // 1MB가 넘으면 contents API가 내용을 비워서 줌
    return JSON.parse(b64ToUtf8(blob.content));
  }
  const readDbAt = async (ref) => normalizeDb(await readJsonAt(DB_PATH, ref));

  async function loadDb() {
    if (state.token) {
      state.db = await readDbAt(CFG.branch);
    } else {
      const res = await fetch(`${DB_PATH}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('data/db.json을 불러오지 못했어요 (' + res.status + ')');
      state.db = normalizeDb(await res.json());
    }
    state.loadedAt = Date.now();
  }

  // 변경 하나 = 커밋 하나. 그 사이 친구가 먼저 저장했으면 최신 데이터에 다시 적용해서 재시도해요.
  async function commitJson(path, normalize, message, mutate, files) {
    if (state.busy) throw new Error('저장 중이에요. 잠시 후 다시 시도해 주세요.');
    state.busy = true;
    const t = toast('저장 중…', 0);
    try {
      const blobs = [];
      for (const f of files || []) {
        const b = await gh('POST', `${REPO}/git/blobs`, { content: f.base64, encoding: 'base64' });
        blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const ref = await gh('GET', `${REPO}/git/ref/heads/${encId(CFG.branch)}`);
        const head = ref.object.sha;
        const commit = await gh('GET', `${REPO}/git/commits/${head}`);
        const next = normalize(await readJsonAt(path, head));
        mutate(next);
        const dbBlob = await gh('POST', `${REPO}/git/blobs`, { content: JSON.stringify(next, null, 1) + '\n', encoding: 'utf-8' });
        const tree = await gh('POST', `${REPO}/git/trees`, {
          base_tree: commit.tree.sha,
          tree: [{ path, mode: '100644', type: 'blob', sha: dbBlob.sha }, ...blobs],
        });
        const created = await gh('POST', `${REPO}/git/commits`, {
          message: state.user ? `${message} (by ${state.user.login})` : message,
          tree: tree.sha,
          parents: [head],
        });
        try {
          await gh('PATCH', `${REPO}/git/refs/heads/${encId(CFG.branch)}`, { sha: created.sha, force: false });
        } catch (err) {
          if (err.status === 422 || err.status === 409) continue;
          throw err;
        }
        return next;
      }
      throw new Error('친구와 동시에 저장하느라 실패했어요. 다시 시도해 주세요.');
    } finally {
      state.busy = false;
      t.remove();
    }
  }

  async function save(message, mutate, files) {
    if (!state.user) throw new Error('로그인이 필요해요');
    state.db = await commitJson(DB_PATH, normalizeDb, message, mutate, files);
    state.loadedAt = Date.now();
  }

  async function trySave(message, mutate, files) {
    try {
      await save(message, mutate, files);
      return true;
    } catch (err) {
      alert('저장하지 못했어요.\n' + err.message + (err.status === 401 || err.status === 403 ? '\n\nGitHub 토큰이 만료됐거나 권한이 부족할 수 있어요. 저장소 주인이 [내 정보 → 토큰 교체]에서 새 토큰을 넣어 주세요.' : ''));
      return false;
    }
  }

  // ---------- accounts (아이디/비밀번호) ----------
  // GitHub 토큰은 공용 키로 암호화해서 data/accounts.json에 두고, 공용 키는 계정마다
  // 그 사람 비밀번호로 한 번 더 암호화해 둬요. 비밀번호를 알아야만 토큰을 꺼낼 수 있어요.
  const utf8 = new TextEncoder();
  const toB64 = (buf) => { let s = ''; new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const randBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

  async function passwordKey(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const aesKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function seal(key, bytes) {
    const iv = randBytes(12);
    return { iv: toB64(iv), ct: toB64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
  }
  async function unseal(key, box) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct)));
  }
  async function wrapKey(rawKey, password) {
    const salt = randBytes(16);
    const box = await seal(await passwordKey(password, salt, PBKDF2_ITER), rawKey);
    return { salt: toB64(salt), iter: PBKDF2_ITER, iv: box.iv, ct: box.ct };
  }

  function normalizeAccounts(a) {
    a = a && typeof a === 'object' ? a : {};
    return { version: 1, token: a.token || null, users: a.users && typeof a.users === 'object' ? a.users : {} };
  }
  // 사이트 파일을 먼저 보고, 방금 만든 계정이 아직 반영 전이면 GitHub에서 직접 읽어요.
  async function fetchAccounts(needId) {
    let acc = null;
    try {
      const res = await fetch(`${ACC_PATH}?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) acc = normalizeAccounts(await res.json());
    } catch (e) { /* ignore */ }
    if (!acc || !acc.token || (needId && !acc.users[needId])) {
      try {
        acc = normalizeAccounts(await readJsonAt(ACC_PATH, CFG.branch));
      } catch (e) {
        if (!acc) throw e;
      }
    }
    return acc;
  }

  async function startSession(id, rawKey, acc) {
    state.token = new TextDecoder().decode(await unseal(await aesKey(rawKey), acc.token));
    state.key = rawKey;
    state.accounts = acc;
    state.user = { login: id, admin: !!acc.users[id].admin };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ id, key: toB64(rawKey) })); } catch (e) { /* ignore */ }
  }

  async function login(id, password) {
    const acc = await fetchAccounts(id);
    const u = acc.users[id];
    if (!u || !acc.token) throw new Error('아이디나 비밀번호가 맞지 않아요.');
    let rawKey;
    try {
      rawKey = await unseal(await passwordKey(password, fromB64(u.salt), u.iter || PBKDF2_ITER), u);
    } catch (e) {
      throw new Error('아이디나 비밀번호가 맞지 않아요.');
    }
    await startSession(id, rawKey, acc);
  }

  function logout() {
    state.token = '';
    state.key = null;
    state.user = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  async function restoreSession() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { /* ignore */ }
    if (!s || !s.id || !s.key) return;
    try {
      const acc = await fetchAccounts(s.id);
      if (!acc.users[s.id] || !acc.token) return logout(); // 삭제된 계정
      await startSession(s.id, fromB64(s.key), acc);
    } catch (e) {
      // 키가 안 맞으면 로그아웃, 인터넷 문제면 이번만 보기 전용으로
      if (e.name === 'OperationError') logout();
      else { state.token = ''; state.user = null; }
    }
  }

  async function checkToken(token) {
    const saved = state.token;
    state.token = token;
    try {
      const r = await gh('GET', REPO);
      if (!r.permissions || !r.permissions.push) throw new Error('이 토큰으로는 저장소에 쓸 수 없어요.');
    } catch (err) {
      state.token = saved;
      throw err.status === 401 ? new Error('토큰이 올바르지 않아요. 다시 복사해 주세요.') : err;
    }
  }

  async function updateAccounts(message, mutate) {
    state.accounts = await commitJson(ACC_PATH, normalizeAccounts, message, mutate);
  }

  // 처음 한 번: 토큰을 암호화해서 넣고 관리자 계정을 만들어요.
  async function setupFirstAccount(token, id, password) {
    await checkToken(token);
    const rawKey = randBytes(32);
    const tokenBox = await seal(await aesKey(rawKey), utf8.encode(token));
    const entry = { ...(await wrapKey(rawKey, password)), admin: true, createdAt: new Date().toISOString() };
    try {
      await updateAccounts(`계정 설정: ${id}`, (a) => {
        if (a.token) throw new Error('이미 설정돼 있어요. 만들어 둔 계정으로 로그인해 주세요.');
        a.token = tokenBox;
        a.users[id] = entry;
      });
    } catch (err) {
      state.token = '';
      throw err;
    }
    await startSession(id, rawKey, state.accounts);
  }

  function checkNewCredentials(id, pw, pw2) {
    if (id !== undefined && (!id || id.length > 20 || /[\s/\\]/.test(id))) return '아이디는 띄어쓰기 없이 1~20자로 정해 주세요.';
    if (pw.length < 8) return '비밀번호는 8자 이상으로 정해 주세요.';
    if (pw2 !== undefined && pw !== pw2) return '비밀번호 확인이 맞지 않아요.';
    return '';
  }

  // ---------- images ----------
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  async function fileToDataUrl(file) {
    const url = await readFile(file);
    if (file.type === 'image/gif' || file.type === 'image/svg+xml') return url;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.width, img.height));
        if (scale === 1 && file.size < 600 * 1024) return resolve(url);
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        const out = cv.toDataURL('image/webp', 0.9);
        resolve(out.startsWith('data:image/webp') ? out : cv.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = url;
    });
  }
  // data URL을 저장소에 올릴 파일로 바꿔요. 반환값의 path가 이미지 src가 됩니다.
  function dataUrlToFile(dataUrl) {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl);
    if (!m) return null;
    const ext = { jpeg: 'jpg', 'svg+xml': 'svg' }[m[1].toLowerCase()] || m[1].toLowerCase();
    const path = `images/${state.user.login}/${uid('img')}.${ext}`;
    state.localImgs[path] = dataUrl;
    return { path, base64: m[2] };
  }

  // ---------- chrome ----------
  function renderChrome(tab) {
    document.getElementById('site-title').textContent = db().siteTitle;
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    const $me = document.getElementById('me-btn');
    $me.innerHTML = state.user ? `${avatarHtml(state.user.login)}<span class="me-name">${esc(memberName(state.user.login))}</span>` : '로그인';
    $me.classList.toggle('logged', !!state.user);

    if (state.user && state.legacy && state.legacy.length) {
      $banner.hidden = false;
      $banner.innerHTML = `<span>💾 이 브라우저에 예전 방식으로 저장된 캐릭터 ${state.legacy.length}명이 있어요. 공유 저장소로 옮겨 두세요.</span>
        <a class="btn btn-sm" href="#/me">옮기기</a>`;
    } else if (!state.user) {
      $banner.hidden = false;
      $banner.innerHTML = '<span>👀 지금은 보기 전용이에요. 캐릭터나 글을 올리려면 로그인해 주세요.</span><a class="btn btn-sm" href="#/me">로그인</a>';
    } else {
      $banner.hidden = true;
    }
  }

  function ownerChips(owners, current) {
    if (owners.length < 2) return '';
    return `<div class="chips">
      <button type="button" class="chip ${current ? '' : 'active'}" data-owner="">모두</button>
      ${owners.map((o) => `<button type="button" class="chip chip-person ${o === current ? 'active' : ''}" data-owner="${esc(o)}">${avatarHtml(o)}${esc(memberName(o))}</button>`).join('')}
    </div>`;
  }

  // ---------- character list ----------
  function renderCharacters(kind) {
    const isDoc = kind === 'doc';
    renderChrome(isDoc ? 'docs' : 'oc');
    const all = db().characters.filter((c) => c.kind === kind);
    const f = isDoc ? state.docFilter : state.filter;
    const noun = isDoc ? '문서' : '캐릭터';
    const newHash = isDoc ? '#/new?kind=doc' : '#/new';
    const owners = [...new Set(all.map((c) => c.owner).filter(Boolean))].sort();
    const worlds = [...new Set(all.map((c) => c.world).filter(Boolean))].sort();
    const tags = [...new Set(all.flatMap((c) => c.tags))].sort();
    if (f.world && !worlds.includes(f.world)) f.world = '';
    if (f.tag && !tags.includes(f.tag)) f.tag = '';
    if (f.owner && !owners.includes(f.owner)) f.owner = '';

    $app.innerHTML = `
      <div class="page-head">
        <h1>${noun}</h1>
        ${state.user ? `<a href="${newHash}" class="btn btn-primary">+ 새 ${noun}</a>` : ''}
      </div>
      ${ownerChips(owners, f.owner)}
      <div class="toolbar">
        <input type="search" id="q" placeholder="이름, 태그, 설명으로 검색" value="${esc(f.q)}">
        ${worlds.length ? `<select id="world">
          <option value="">모든 세계관</option>
          ${worlds.map((w) => `<option value="${esc(w)}" ${w === f.world ? 'selected' : ''}>${esc(w)}</option>`).join('')}
        </select>` : ''}
      </div>
      ${tags.length ? `<div class="chips chips-tags">
        <button type="button" class="chip ${f.tag ? '' : 'active'}" data-tag="">전체</button>
        ${tags.map((t) => `<button type="button" class="chip ${t === f.tag ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}
      </div>` : ''}
      <div id="results"></div>`;

    const $results = document.getElementById('results');
    const draw = () => {
      const q = f.q.trim().toLowerCase();
      const list = all.filter((c) => {
        if (f.owner && c.owner !== f.owner) return false;
        if (f.world && c.world !== f.world) return false;
        if (f.tag && !c.tags.includes(f.tag)) return false;
        if (!q) return true;
        return [c.name, c.subname, c.summary, c.world, ...c.tags, ...c.profile.map((r) => r.label + ' ' + r.value)].join(' ').toLowerCase().includes(q);
      }).sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
      if (!all.length) {
        $results.innerHTML = `<div class="empty">${isDoc ? '세계관 설정, 용어 정리처럼 캐릭터가 아닌 문서를 모아 두는 곳이에요.<br>아직 문서가 없어요.' : '아직 등록된 캐릭터가 없어요.'}${state.user ? `<br><a class="btn btn-primary" href="${newHash}">+ 첫 ${noun} 만들기</a>` : ''}</div>`;
        return;
      }
      if (!list.length) {
        $results.innerHTML = `<div class="empty">조건에 맞는 ${noun}가 없어요.</div>`;
        return;
      }
      $results.innerHTML = `<div class="count">${list.length}${isDoc ? '개' : '명'}</div><div class="grid">${list.map((c) => `
        <a class="card" href="#/oc/${encId(c.id)}" style="--oc:${safeColor(c.color)}">
          <div class="card-thumb">${thumbHtml(c)}</div>
          <div class="card-body">
            <div class="card-name">${esc(c.name)}</div>
            ${c.subname || c.world ? `<div class="card-sub">${esc([c.subname, c.world].filter(Boolean).join(' · '))}</div>` : ''}
            ${c.summary ? `<div class="card-summary">${esc(c.summary)}</div>` : ''}
            ${c.owner ? `<div class="card-owner">${avatarHtml(c.owner)}${esc(memberName(c.owner))}</div>` : ''}
          </div>
        </a>`).join('')}</div>`;
    };
    draw();

    document.getElementById('q').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
    const $world = document.getElementById('world');
    if ($world) $world.addEventListener('change', (e) => { f.world = e.target.value; draw(); });
    $app.querySelectorAll('[data-tag]').forEach((b) => b.addEventListener('click', () => {
      f.tag = b.dataset.tag;
      $app.querySelectorAll('[data-tag]').forEach((x) => x.classList.toggle('active', x === b));
      draw();
    }));
    $app.querySelectorAll('[data-owner]').forEach((b) => b.addEventListener('click', () => {
      f.owner = b.dataset.owner;
      $app.querySelectorAll('[data-owner]').forEach((x) => x.classList.toggle('active', x === b));
      draw();
    }));
  }

  // ---------- comments ----------
  function commentsHtml(target) {
    const list = db().comments.filter((c) => c.target === target).sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1));
    return `<section class="section comments" id="comments">
      <h2>댓글 ${list.length ? `<span class="muted">${list.length}</span>` : ''}</h2>
      ${list.map((c) => `
        <div class="comment">
          ${avatarHtml(c.author, 'avatar-lg')}
          <div class="comment-main">
            <div class="comment-head"><strong>${esc(memberName(c.author))}</strong> <time>${esc(fmtDate(c.createdAt))}</time>
              ${isMine(c.author) ? `<button type="button" class="link-btn" data-del-comment="${esc(c.id)}">삭제</button>` : ''}</div>
            <div class="comment-body">${esc(c.body)}</div>
          </div>
        </div>`).join('') || '<p class="muted">아직 댓글이 없어요.</p>'}
      ${state.user ? `<form class="comment-form" id="comment-form">
          <textarea id="comment-body" rows="2" placeholder="댓글 달기" required></textarea>
          <button type="submit" class="btn btn-primary">등록</button>
        </form>` : '<p class="muted"><a href="#/me">로그인</a>하면 댓글을 달 수 있어요.</p>'}
    </section>`;
  }
  function bindComments(target, rerender) {
    const $form = document.getElementById('comment-form');
    if ($form) $form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = document.getElementById('comment-body').value.trim();
      if (!body) return;
      const c = normalizeComment({ target, author: state.user.login, body });
      $form.querySelector('button').disabled = true;
      if (await trySave('댓글 작성', (d) => { d.comments.push(c); })) {
        rerender();
        const el = document.getElementById('comments');
        if (el) el.scrollIntoView({ block: 'end' });
      } else {
        $form.querySelector('button').disabled = false;
      }
    });
    $app.querySelectorAll('[data-del-comment]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('댓글을 삭제할까요?')) return;
      const id = b.dataset.delComment;
      if (await trySave('댓글 삭제', (d) => { d.comments = d.comments.filter((c) => c.id !== id); })) rerender();
    }));
  }

  // ---------- wiki document: 안전한 HTML ----------
  // 문서 본문은 서식이 있는 HTML이라, 보여 주거나 저장할 때마다 허용한 태그·속성만 남겨요.
  const ALLOWED_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'SUP', 'SUB', 'SPAN', 'A',
    'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DIV', 'H3', 'H4', 'FONT']);
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'LINK',
    'META', 'TITLE', 'HEAD', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'VIDEO', 'AUDIO', 'CANVAS']);
  const STYLE_PROPS = new Set(['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-decoration',
    'text-decoration-line', 'text-align', 'width']);
  const FONT_SIZES = { 1: '0.75em', 2: '0.875em', 3: '1em', 4: '1.15em', 5: '1.35em', 6: '1.6em', 7: '2em' };
  const NOTICE_ICONS = ['⚠️', 'ℹ️', '❗', '🚫', '💻', '📱', '📢', '🔒', '🔞', '⭐', '❤️', '📖'];

  function cleanStyle(v) {
    return String(v || '').split(';').map((d) => {
      const i = d.indexOf(':');
      if (i < 0) return '';
      const prop = d.slice(0, i).trim().toLowerCase();
      const val = d.slice(i + 1).trim();
      if (!STYLE_PROPS.has(prop) || !val || val.length > 60 || /url\(|expression|[<>\\]/i.test(val)) return '';
      return `${prop}: ${val}`;
    }).filter(Boolean).join('; ');
  }
  function cleanHref(v) {
    v = String(v || '').trim();
    return /^(https?:\/\/|mailto:|#\/)/i.test(v) ? v : '';
  }

  // mode 'view': 그림을 보여 줄 주소로 / 'store': 저장용. 붙여넣은 data: 그림은 파일로 바꿔 files에 담아요.
  function cleanHtml(html, mode, files) {
    const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html');
    const walk = (node) => {
      [...node.childNodes].forEach((n) => {
        if (n.nodeType === 3) return;
        if (n.nodeType !== 1) { n.remove(); return; }
        const tag = n.tagName.toUpperCase();
        if (DROP_TAGS.has(tag)) { n.remove(); return; }
        walk(n);
        if (!ALLOWED_TAGS.has(tag)) { n.replaceWith(...n.childNodes); return; }
        if (tag === 'FONT') {
          const span = doc.createElement('span');
          const st = [];
          if (n.getAttribute('color')) st.push(`color: ${n.getAttribute('color')}`);
          if (FONT_SIZES[n.getAttribute('size')]) st.push(`font-size: ${FONT_SIZES[n.getAttribute('size')]}`);
          if (n.getAttribute('style')) st.push(n.getAttribute('style'));
          span.setAttribute('style', st.join(';'));
          span.append(...n.childNodes);
          n.replaceWith(span);
          cleanAttrs(span, 'SPAN', mode, files);
          return;
        }
        cleanAttrs(n, tag, mode, files);
      });
    };
    walk(doc.body);
    return doc.body.innerHTML;
  }

  function cleanAttrs(el, tag, mode, files) {
    const keep = {};
    [...el.attributes].forEach((a) => {
      const name = a.name.toLowerCase();
      const v = a.value;
      if (name === 'style') { const st = cleanStyle(v); if (st) keep.style = st; }
      else if (name === 'class') { const cl = v.split(/\s+/).filter((x) => x === 'fn' || x === 'spoiler').join(' '); if (cl) keep.class = cl; }
      else if (name === 'href' && tag === 'A') { const h = cleanHref(v); if (h) keep.href = h; }
      else if (name === 'data-note' && tag === 'SUP') keep['data-note'] = v.slice(0, 2000);
      else if ((name === 'colspan' || name === 'rowspan') && /^\d{1,2}$/.test(v)) keep[name] = v;
      else if (name === 'alt' && tag === 'IMG') keep.alt = v.slice(0, 200);
    });
    if (tag === 'IMG') {
      let path = el.getAttribute('data-src') || el.getAttribute('src') || '';
      if (/^data:image\//i.test(path) && mode === 'store') {
        const f = state.user ? dataUrlToFile(path) : null;
        if (!f) { el.remove(); return; }
        files.push(f);
        path = f.path;
      }
      path = safeSrc(path);
      if (!/^(images\/|https?:)/i.test(path) && !(mode === 'view' && /^data:image\//i.test(path))) { el.remove(); return; }
      keep['data-src'] = path;
      if (mode === 'view') { keep.src = imgUrl(path); keep.loading = 'lazy'; }
    }
    if (tag === 'A' && /^(https?:|mailto:)/i.test(keep.href || '')) { keep.target = '_blank'; keep.rel = 'noopener noreferrer'; }
    [...el.attributes].forEach((a) => el.removeAttribute(a.name));
    Object.entries(keep).forEach(([k, v]) => el.setAttribute(k, v));
  }

  const textToHtml = (t) => esc(t).replace(/\n/g, '<br>');
  function isBlankHtml(html) {
    const t = document.createElement('div');
    t.innerHTML = cleanHtml(html, 'view');
    return !t.textContent.replace(/[\s​]/g, '') && !t.querySelector('img, hr, table, sup');
  }

  // ---------- wiki document: 보기 ----------
  const anchorOf = (num) => 's-' + num.replace(/\./g, '-');

  function tocHtml(list, prefix) {
    if (!list.length) return '';
    return `<ol>${list.map((ch, i) => {
      const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      return `<li><a data-goto="${anchorOf(num)}"><span class="num">${num}.</span> ${esc(ch.title || '(제목 없음)')}</a>${tocHtml(ch.children, num)}</li>`;
    }).join('')}</ol>`;
  }

  function chaptersHtml(list, prefix, path, edit) {
    return list.map((ch, i) => {
      const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      const p = path ? `${path}.children.${i}` : `chapters.${i}`;
      const depth = Math.min(num.split('.').length - 1, 3);
      const kids = chaptersHtml(ch.children, num, p, edit);
      if (!edit) {
        return `<section class="wiki-sec" id="${anchorOf(num)}">
          <h2 class="wiki-h d${depth}" data-fold><span class="num">${num}.</span> <span class="t">${esc(ch.title)}</span><span class="fold-mark" aria-hidden="true"></span></h2>
          <div class="wiki-sec-in">${isBlankHtml(ch.body) ? '' : `<div class="wiki-body">${cleanHtml(ch.body, 'view')}</div>`}${kids}</div>
        </section>`;
      }
      const idx = (p.match(/\d+/g) || []).join('.');
      const ctl = (act, label, title, show) => (show ? `<button type="button" data-ch-act="${act}" data-ch="${idx}" title="${title}">${label}</button>` : '');
      return `<section class="wiki-sec">
        <div class="wiki-h d${depth}"><span class="num">${num}.</span>
          <span class="ch-title" contenteditable="true" data-text="${p}.title" data-placeholder="챕터 제목">${esc(ch.title)}</span>
          <span class="ch-ctl">
            ${ctl('up', '↑', '위로', i > 0)}${ctl('down', '↓', '아래로', i < list.length - 1)}
            ${ctl('out', '⇤', '한 단계 위로', depth > 0)}${ctl('in', '⇥', '한 단계 아래로', i > 0)}
            ${ctl('child', '＋', '하위 챕터 추가', true)}${ctl('del', '×', '챕터 삭제', true)}
          </span></div>
        <div class="wiki-body" contenteditable="true" data-html="${p}.body" data-placeholder="내용을 입력하세요">${cleanHtml(ch.body, 'view')}</div>
        ${kids}
      </section>`;
    }).join('');
  }

  function infoboxHtml(c) {
    const cover = coverOf(c);
    if (!cover && !c.profile.length) return '';
    return `<aside class="infobox">
      <div class="ib-title">${esc(c.name)}${c.subname ? `<small>${esc(c.subname)}</small>` : ''}</div>
      ${cover ? `<div class="ib-img" data-zoom="${esc(imgUrl(cover))}" data-caption="${esc(c.name)}"><img src="${esc(imgUrl(cover))}" alt="${esc(c.name)}"></div>` : ''}
      ${c.profile.length ? `<table><tbody>${c.profile.map((r) => (r.type === 'head'
        ? `<tr><th colspan="2" class="ib-group">${esc(r.label)}</th></tr>`
        : `<tr><th>${esc(r.label)}</th><td>${cleanHtml(r.value, 'view')}</td></tr>`)).join('')}</tbody></table>` : ''}
    </aside>`;
  }

  const noticeHtml = (n) => `<div class="wiki-notice"><span class="ni" aria-hidden="true">${esc(n.icon)}</span><div>${cleanHtml(n.text, 'view')}</div></div>`;

  // 각주 번호를 매기고 문서 아래 각주 목록을 채워요
  function finishDoc(root) {
    const notes = [];
    root.querySelectorAll('.wiki sup.fn').forEach((s, i) => {
      const n = i + 1;
      notes.push(s.getAttribute('data-note') || '');
      s.id = 'fnref-' + n;
      s.tabIndex = 0;
      s.textContent = `[${n}]`;
    });
    const $list = root.querySelector('.wiki-fns');
    if ($list && notes.length) {
      $list.hidden = false;
      $list.querySelector('ol').innerHTML = notes.map((t, i) => `<li id="fn-${i + 1}"><a data-goto="fnref-${i + 1}">[${i + 1}]</a> ${esc(t)}</li>`).join('');
    }
  }

  // 목차·각주 이동, 챕터 접기, 각주 팝업, 스포일러 (편집 중인 칸 안에서는 동작하지 않음)
  document.addEventListener('click', (e) => {
    if (e.target.closest('[contenteditable="true"]')) return;
    const g = e.target.closest('[data-goto]');
    if (g) {
      const t = document.getElementById(g.dataset.goto);
      if (!t) return;
      for (let s = t.closest('.wiki-sec.closed'); s; s = s.parentElement.closest('.wiki-sec.closed')) s.classList.remove('closed');
      t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      t.classList.add('flash');
      setTimeout(() => t.classList.remove('flash'), 1400);
      return;
    }
    const f = e.target.closest('[data-fold]');
    if (f) { f.closest('.wiki-sec').classList.toggle('closed'); return; }
    const fn = e.target.closest('.wiki sup.fn');
    document.querySelectorAll('.wiki sup.fn.open').forEach((x) => { if (x !== fn) x.classList.remove('open'); });
    if (fn) { fn.classList.toggle('open'); return; }
    const sp = e.target.closest('.wiki .spoiler');
    if (sp) sp.classList.toggle('show');
  });

  // ---------- character / document detail ----------
  function galleryHtml(images, fallbackAlt) {
    if (!images.length) return '';
    return `<div class="gallery">
      ${images.map((img) => `<figure data-zoom="${esc(imgUrl(img.src))}" data-caption="${esc(img.caption)}">
        <img src="${esc(imgUrl(img.src))}" alt="${esc(img.caption || fallbackAlt)}" loading="lazy">
        ${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ''}
      </figure>`).join('')}
    </div>`;
  }

  function renderDetail(id) {
    const c = findChar(id);
    renderChrome(c && c.kind === 'doc' ? 'docs' : 'oc');
    if (!c) return renderNotFound();
    const color = safeColor(c.color);
    const listHash = c.kind === 'doc' ? '#/docs' : '#/';
    document.title = `${c.name} · ${db().siteTitle}`;
    const related = db().posts.filter((p) => p.chars.includes(c.id)).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
    const cover = coverOf(c);
    const gallery = c.images.length > 1 ? c.images : [];

    const relHtml = c.relations.map((r) => {
      const t = (r.id && findChar(r.id)) || db().characters.find((x) => x.name === r.name);
      const name = t ? t.name : r.name;
      const inner = `
        <span class="mini" style="--oc:${t ? safeColor(t.color) : 'var(--muted)'}">${t ? thumbHtml(t) : `<span class="initial">${esc((name || '?').charAt(0))}</span>`}</span>
        <span><strong>${esc(name)}</strong>${r.type ? ` <span class="rtype">· ${esc(r.type)}</span>` : ''}
        ${r.note ? `<br><span class="rtype">${esc(r.note)}</span>` : ''}</span>`;
      return t
        ? `<a class="relation" href="#/oc/${encId(t.id)}">${inner}</a>`
        : `<div class="relation">${inner}</div>`;
    }).join('');

    const cats = [
      ...(c.world ? [`<a data-cat-world="${esc(c.world)}">${esc(c.world)}</a>`] : []),
      ...c.tags.map((t) => `<a data-cat-tag="${esc(t)}">${esc(t)}</a>`),
    ];

    $app.innerHTML = `
      <article class="wiki" style="--oc:${color}">
        <a class="back" href="${listHash}">← ${c.kind === 'doc' ? '문서 목록' : '캐릭터 목록'}</a>
        ${cats.length ? `<div class="wiki-cats"><b>분류</b> ${cats.join('<span class="sep">|</span>')}</div>` : ''}
        <div class="wiki-head">
          <h1>${esc(c.name)}</h1>
          <div class="wiki-actions">
            ${isMine(c.owner) ? `<a class="btn btn-sm btn-primary" href="#/edit/${encId(c.id)}">✎ 편집</a>` : ''}
            ${state.user ? `<a class="btn btn-sm" href="#/write?oc=${encId(c.id)}">글쓰기</a>` : ''}
            ${isMine(c.owner) ? '<button type="button" class="btn btn-sm btn-danger" id="delete">삭제</button>' : ''}
          </div>
        </div>
        <div class="wiki-meta">${c.owner ? `${byline(c.owner)}<span class="dot">·</span>` : ''}최근 수정 ${esc(fmtDate(c.updatedAt))}</div>
        ${c.notices.map(noticeHtml).join('')}
        <div class="wiki-top">
          ${c.chapters.length ? `<nav class="wiki-toc"><div class="toc-h">목차</div>${tocHtml(c.chapters, '')}</nav>` : ''}
          ${infoboxHtml(c)}
        </div>
        ${chaptersHtml(c.chapters, '', '', false)}
        ${!c.chapters.length && !c.profile.length ? `<p class="muted">아직 내용이 없어요.${isMine(c.owner) ? ' [편집]을 눌러 써 보세요.' : ''}</p>` : ''}
        <div class="wiki-fns" hidden><div class="fns-h">각주</div><ol></ol></div>

        ${c.relations.length ? `<section class="section"><h2>관계</h2><div class="relations">${relHtml}</div></section>` : ''}
        ${gallery.length ? `<section class="section"><h2>갤러리 <span class="muted">${gallery.length}</span></h2>${galleryHtml(gallery, c.name)}</section>` : ''}
        ${related.length ? `<section class="section"><h2>관련 게시물 <span class="muted">${related.length}</span></h2>
          <div class="post-list compact">${related.map(postCardHtml).join('')}</div></section>` : ''}
        ${commentsHtml('oc:' + c.id)}
      </article>`;
    finishDoc($app);

    $app.querySelectorAll('[data-cat-world], [data-cat-tag]').forEach((a) => a.addEventListener('click', () => {
      const f = c.kind === 'doc' ? state.docFilter : state.filter;
      Object.assign(f, { q: '', world: a.dataset.catWorld || '', tag: a.dataset.catTag || '', owner: '' });
      location.hash = listHash;
    }));
    const $del = document.getElementById('delete');
    if ($del) $del.addEventListener('click', async () => {
      if (!confirm(`'${c.name}'을(를) 삭제할까요?\n(GitHub 기록에는 남아 있어서 저장소 주인이 되살릴 수 있어요.)`)) return;
      const ok = await trySave(`${c.kind === 'doc' ? '문서' : '캐릭터'} 삭제: ${c.name}`, (d) => {
        d.characters = d.characters.filter((x) => x.id !== c.id);
        d.comments = d.comments.filter((x) => x.target !== 'oc:' + c.id);
      });
      if (ok) { toast('삭제했어요'); location.hash = listHash; }
    });
    bindComments('oc:' + c.id, () => renderDetail(id));
  }

  function renderNotFound() {
    $app.innerHTML = '<div class="empty">찾을 수 없어요. 삭제됐거나 아직 반영되지 않았을 수 있어요.<br><a class="btn" href="#/">목록으로</a></div>';
  }
  function requireLogin() {
    $app.innerHTML = '<div class="empty">로그인해야 쓸 수 있어요.<br><a class="btn btn-primary" href="#/me">로그인하기</a></div>';
  }

  // ---------- posts ----------
  function postCardHtml(p) {
    const cs = p.chars.map(findChar).filter(Boolean);
    const count = db().comments.filter((c) => c.target === 'post:' + p.id).length;
    return `<a class="post-card" href="#/post/${encId(p.id)}">
      <div class="post-card-main">
        ${byline(p.author, p.createdAt)}
        <div class="post-title">${esc(p.title || '(제목 없음)')}</div>
        ${p.body ? `<div class="post-excerpt">${esc(p.body.slice(0, 200))}</div>` : ''}
        <div class="post-foot">
          ${cs.map((c) => `<span class="char-pill" style="--oc:${safeColor(c.color)}">${esc(c.name)}</span>`).join('')}
          ${p.images.length ? `<span class="muted">🖼 ${p.images.length}</span>` : ''}
          ${count ? `<span class="muted">💬 ${count}</span>` : ''}
        </div>
      </div>
      ${p.images.length ? `<div class="post-thumb"><img src="${esc(imgUrl(p.images[0].src))}" alt="" loading="lazy"></div>` : ''}
    </a>`;
  }

  function renderPosts() {
    renderChrome('posts');
    const all = db().posts;
    const f = state.postFilter;
    const owners = [...new Set(all.map((p) => p.author).filter(Boolean))].sort();
    if (f.owner && !owners.includes(f.owner)) f.owner = '';
    const list = all.filter((p) => !f.owner || p.author === f.owner).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

    $app.innerHTML = `
      <div class="page-head">
        <h1>게시판</h1>
        ${state.user ? '<a href="#/write" class="btn btn-primary">+ 글쓰기</a>' : ''}
      </div>
      ${ownerChips(owners, f.owner)}
      ${list.length ? `<div class="post-list">${list.map(postCardHtml).join('')}</div>`
        : `<div class="empty">아직 게시물이 없어요.${state.user ? '<br><a class="btn btn-primary" href="#/write">+ 첫 글 쓰기</a>' : ''}</div>`}`;

    $app.querySelectorAll('[data-owner]').forEach((b) => b.addEventListener('click', () => {
      f.owner = b.dataset.owner;
      renderPosts();
    }));
  }

  function renderPost(id) {
    renderChrome('posts');
    const p = findPost(id);
    if (!p) return renderNotFound();
    document.title = `${p.title || '게시물'} · ${db().siteTitle}`;
    const cs = p.chars.map(findChar).filter(Boolean);
    $app.innerHTML = `
      <article class="post">
        <a class="back" href="#/posts">← 게시판</a>
        <h1 class="post-h1">${esc(p.title || '(제목 없음)')}</h1>
        <div class="post-meta">${byline(p.author, p.createdAt)}${p.updatedAt !== p.createdAt ? ' <span class="muted">(수정됨)</span>' : ''}</div>
        ${cs.length ? `<div class="post-chars">${cs.map((c) => `
          <a class="char-chip" href="#/oc/${encId(c.id)}" style="--oc:${safeColor(c.color)}"><span class="mini">${thumbHtml(c)}</span>${esc(c.name)}</a>`).join('')}</div>` : ''}
        ${p.body ? `<div class="section"><div class="body">${esc(p.body)}</div></div>` : ''}
        ${p.images.length ? `<div class="section">${galleryHtml(p.images, p.title)}</div>` : ''}
        ${isMine(p.author) ? `<div class="actions">
          <a class="btn" href="#/write/${encId(p.id)}">수정</a>
          <button type="button" class="btn btn-danger" id="delete">삭제</button></div>` : ''}
        ${commentsHtml('post:' + p.id)}
      </article>`;

    const $del = document.getElementById('delete');
    if ($del) $del.addEventListener('click', async () => {
      if (!confirm('이 게시물을 삭제할까요?')) return;
      const ok = await trySave(`게시물 삭제: ${p.title}`, (d) => {
        d.posts = d.posts.filter((x) => x.id !== p.id);
        d.comments = d.comments.filter((x) => x.target !== 'post:' + p.id);
      });
      if (ok) { toast('삭제했어요'); location.hash = '#/posts'; }
    });
    bindComments('post:' + p.id, () => renderPost(id));
  }

  // ---------- editors (shared) ----------
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
  }

  function imagesFieldHtml(d, withAvatar) {
    return `<div class="img-edit-list">
        ${d.images.map((img, i) => `
          <div class="img-edit ${withAvatar && d.avatar === img.src ? 'is-avatar' : ''}">
            <img src="${esc(imgUrl(img.src))}" alt="">
            <input type="text" data-path="images.${i}.caption" value="${esc(img.caption)}" placeholder="설명">
            <div class="btns">
              ${withAvatar ? `<button type="button" class="btn" data-act="avatar" data-i="${i}">${d.avatar === img.src ? '★ 대표' : '대표로'}</button>` : ''}
              <button type="button" class="btn" data-act="up" data-list="images" data-i="${i}" title="앞으로">←</button>
              <button type="button" class="btn btn-danger" data-act="del" data-list="images" data-i="${i}">삭제</button>
            </div>
          </div>`).join('')}
      </div>
      <div class="img-add">
        <label class="btn">📷 그림 올리기<input type="file" id="img-file" accept="image/*" multiple hidden></label>
        <input type="url" id="img-url" placeholder="또는 이미지 주소">
        <button type="button" class="btn" data-act="add-url">추가</button>
      </div>
      <div class="hint">여러 장을 한꺼번에 고를 수 있어요. 큰 그림은 ${MAX_IMAGE_SIDE}px로 줄여서 저장돼요(GIF는 원본 유지).</div>`;
  }

  // 편집 폼 공통 동작: 입력값 반영, 목록 추가/삭제/순서, 그림 업로드
  function bindEditor($form, d, redraw, makeItem) {
    $form.addEventListener('input', (e) => {
      const p = e.target.dataset && e.target.dataset.path;
      if (!p) return;
      setPath(d, p, e.target.value);
      if (/^relations\.\d+\.name$/.test(p)) setPath(d, p.replace(/name$/, 'id'), '');
      if (p === 'color') $form.style.setProperty('--accent', safeColor(e.target.value));
    });
    $form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const { act, list } = b.dataset;
      const i = Number(b.dataset.i);
      if (act === 'add') {
        d[list].push(makeItem(list));
      } else if (act === 'del') {
        const [removed] = d[list].splice(i, 1);
        if (list === 'images' && removed && d.avatar === removed.src) d.avatar = '';
      } else if (act === 'up' && i > 0) {
        [d[list][i - 1], d[list][i]] = [d[list][i], d[list][i - 1]];
      } else if (act === 'down' && i < d[list].length - 1) {
        [d[list][i + 1], d[list][i]] = [d[list][i], d[list][i + 1]];
      } else if (act === 'avatar') {
        d.avatar = d.avatar === d.images[i].src ? '' : d.images[i].src;
      } else if (act === 'add-url') {
        const src = safeSrc(document.getElementById('img-url').value);
        if (!/^https?:/i.test(src)) return toast('http(s)로 시작하는 이미지 주소를 넣어 주세요');
        d.images.push({ src, caption: '' });
      } else if (act === 'toggle-char') {
        const id = b.dataset.id;
        d.chars = d.chars.includes(id) ? d.chars.filter((x) => x !== id) : [...d.chars, id];
      } else {
        return;
      }
      redraw();
    });
    const $file = document.getElementById('img-file');
    if ($file) $file.addEventListener('change', async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      const t = toast('그림 준비 중…', 0);
      for (const file of files) {
        try {
          const f = dataUrlToFile(await fileToDataUrl(file));
          if (!f) throw new Error('지원하지 않는 형식');
          d._files[f.path] = f.base64;
          d.images.push({ src: f.path, caption: '' });
        } catch (err) {
          alert(`'${file.name}'을(를) 불러오지 못했어요.`);
        }
      }
      t.remove();
      redraw();
    });
  }
  const pendingFiles = (d) => d.images.filter((i) => d._files[i.src]).map((i) => ({ path: i.src, base64: d._files[i.src] }));

  // ---------- templates (문서 틀) ----------
  // 프로필 항목·묶음 제목·목차·경고문 같은 '구조'만 저장해 두고, 새 문서를 만들 때 골라 써요.
  const BUILTIN_TEMPLATES = [
    {
      id: 'builtin-oc', builtin: true, kind: 'oc', name: '기본 프로필', owner: '', notices: [],
      profile: ['나이', '성별', '키', '생일', '소속'].map((label) => ({ type: 'row', label, value: '' })),
      chapters: ['개요', '외모', '성격', '배경', '기타'].map((title) => ({ title, body: '', children: [] })),
    },
    { id: 'builtin-doc', builtin: true, kind: 'doc', name: '일반 문서', owner: '', notices: [], profile: [], chapters: [{ title: '개요', body: '', children: [] }] },
    { id: 'builtin-blank', builtin: true, kind: '', name: '빈 문서', owner: '', notices: [], profile: [], chapters: [] },
  ];

  function normalizeTemplate(t) {
    return {
      id: str(t.id) || uid('tpl'),
      owner: str(t.owner),
      name: str(t.name) || '이름 없는 틀',
      kind: t.kind === 'doc' ? 'doc' : 'oc',
      notices: arr(t.notices).map((n) => ({ icon: str(n.icon) || '⚠️', text: str(n.text) })),
      profile: arr(t.profile).map((r) => ({ type: r.type === 'head' ? 'head' : 'row', label: str(r.label), value: '' })),
      chapters: normChapters(t.chapters, 0),
      createdAt: t.createdAt || new Date().toISOString(),
    };
  }
  const templatesFor = (kind) => [
    ...BUILTIN_TEMPLATES.filter((t) => t.kind === kind || !t.kind),
    ...db().templates.filter((t) => t.kind === kind),
  ];
  const findTemplate = (id) => BUILTIN_TEMPLATES.find((t) => t.id === id) || db().templates.find((t) => t.id === id);

  // 틀의 챕터는 제목만, 새 id로 복사
  const copyChapters = (list) => list.map((ch) => ({ id: uid('ch'), title: ch.title, body: '', children: copyChapters(ch.children) }));
  // 문서에서 구조만 뽑아 틀로
  function templateFromDraft(d, name) {
    const strip = (list) => list.map((ch) => ({ title: ch.title.trim(), body: '', children: strip(ch.children) })).filter((ch) => ch.title || ch.children.length);
    const files = [];
    return normalizeTemplate({
      id: uid('tpl'),
      owner: state.user.login,
      name,
      kind: d.kind,
      notices: d.notices.map((n) => ({ icon: n.icon, text: isBlankHtml(n.text) ? '' : cleanHtml(n.text, 'store', files) })).filter((n) => n.text),
      profile: d.profile.map((r) => ({ type: r.type, label: r.label.trim() })).filter((r) => r.label),
      chapters: strip(d.chapters),
    });
  }

  function flatTitles(list, prefix, out) {
    list.forEach((ch, i) => {
      const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      out.push(`${num}. ${ch.title || '(제목 없음)'}`);
      flatTitles(ch.children, num, out);
    });
    return out;
  }

  function renderTemplatePicker(kind) {
    renderChrome(kind === 'doc' ? 'docs' : 'oc');
    if (!state.user) return requireLogin();
    const noun = kind === 'doc' ? '문서' : '캐릭터';
    const list = templatesFor(kind);
    $app.innerHTML = `
      <a class="back" href="${kind === 'doc' ? '#/docs' : '#/'}">← ${noun} 목록</a>
      <div class="page-head"><h1>새 ${noun} · 틀 고르기</h1></div>
      <p class="muted" style="margin-top:-6px">틀을 고르면 프로필 항목과 목차가 미리 채워져요. 편집 화면의 <b>틀로 저장</b>으로 나만의 틀(예: AU 프로필)을 만들 수 있어요.</p>
      <div class="tpl-grid">
        ${list.map((t) => {
          const rows = t.profile.map((r) => (r.type === 'head' ? `[${r.label}]` : r.label));
          const toc = flatTitles(t.chapters, '', []);
          return `<div class="tpl-card">
            <a class="tpl-main" href="#/new?kind=${kind}&tpl=${encId(t.id)}">
              <div class="tpl-name">${esc(t.name)}</div>
              <div class="tpl-by">${t.builtin ? '기본 제공' : byline(t.owner)}</div>
              ${rows.length ? `<div class="tpl-line"><b>프로필</b> ${esc(rows.join(' · '))}</div>` : ''}
              ${toc.length ? `<div class="tpl-line"><b>목차</b> ${esc(toc.slice(0, 10).join('  '))}${toc.length > 10 ? ' …' : ''}</div>` : ''}
              ${t.notices.length ? `<div class="tpl-line"><b>경고문</b> ${t.notices.length}개</div>` : ''}
              ${!rows.length && !toc.length ? '<div class="tpl-line muted">아무것도 없이 시작해요</div>' : ''}
            </a>
            ${!t.builtin && isMine(t.owner) ? `<div class="tpl-ctl">
              <button type="button" class="link-btn" data-tpl-rename="${esc(t.id)}">이름 바꾸기</button>
              <button type="button" class="link-btn" data-tpl-del="${esc(t.id)}">삭제</button></div>` : ''}
          </div>`;
        }).join('')}
      </div>`;

    $app.querySelectorAll('[data-tpl-del]').forEach((b) => b.addEventListener('click', async () => {
      const t = findTemplate(b.dataset.tplDel);
      if (!t || !confirm(`'${t.name}' 틀을 지울까요? 이 틀로 만든 문서는 그대로 남아요.`)) return;
      if (await trySave(`틀 삭제: ${t.name}`, (d) => { d.templates = d.templates.filter((x) => x.id !== t.id); })) renderTemplatePicker(kind);
    }));
    $app.querySelectorAll('[data-tpl-rename]').forEach((b) => b.addEventListener('click', async () => {
      const t = findTemplate(b.dataset.tplRename);
      const name = t && (prompt('새 이름', t.name) || '').trim();
      if (!name || name === t.name) return;
      if (await trySave(`틀 이름 변경: ${name}`, (d) => { const x = d.templates.find((y) => y.id === t.id); if (x) x.name = name; })) renderTemplatePicker(kind);
    }));
  }

  async function saveDraftAsTemplate(d) {
    const name = (prompt('틀 이름 (예: AU 프로필)\n지금 문서의 프로필 항목·목차·경고문만 저장되고, 내용은 저장되지 않아요.', '') || '').trim();
    if (!name) return;
    const same = db().templates.find((t) => t.kind === d.kind && t.name === name);
    if (same && !isMine(same.owner)) return alert('같은 이름의 틀이 이미 있어요. 다른 이름으로 지어 주세요.');
    if (same && !confirm(`'${name}' 틀이 이미 있어요. 지금 구조로 덮어쓸까요?`)) return;
    const t = templateFromDraft(d, name);
    if (same) t.id = same.id;
    const ok = await trySave(`틀 ${same ? '수정' : '추가'}: ${name}`, (next) => {
      const i = next.templates.findIndex((x) => x.id === t.id);
      if (i >= 0) next.templates[i] = t; else next.templates.push(t);
    });
    if (ok) toast(`'${name}' 틀을 저장했어요. 문서 자체는 아직 저장 전이에요.`, 3500);
  }

  // ---------- character / document editor (위키처럼 문서 위에서 바로 편집) ----------
  function renderCharEditor(id, query) {
    if (!state.user) { renderChrome('oc'); return requireLogin(); }
    const key = 'oc:' + (id || `new:${query.kind}:${query.tpl}`);
    if (!state.draft || state.draft._for !== key) {
      const base = id ? findChar(id) : null;
      if (id && (!base || !isMine(base.owner))) { renderChrome('oc'); return renderNotFound(); }
      const kind = base ? base.kind : (query.kind === 'doc' ? 'doc' : 'oc');
      const tpl = findTemplate(query.tpl) || templatesFor(kind)[0];
      const d = JSON.parse(JSON.stringify(base || normalizeChar({
        id: uid(kind),
        kind,
        doc: 3,
        name: '',
        notices: tpl.notices.map((n) => ({ ...n })),
        profile: tpl.profile.map((r) => ({ type: r.type, label: r.label, value: '' })),
        chapters: copyChapters(tpl.chapters),
      })));
      if (!base) d.name = '';
      d.tagsText = d.tags.join(', ');
      d._for = key;
      d._files = {};
      state.draft = d;
      window.scrollTo(0, 0);
    }
    renderChrome(state.draft.kind === 'doc' ? 'docs' : 'oc');
    drawCharEditor(id);
  }

  function toolbarHtml() {
    const b = (cmd, label, title) => `<button type="button" class="tb" data-cmd="${cmd}" title="${title}" aria-label="${title}">${label}</button>`;
    return `<div class="wiki-toolbar" id="wtb" role="toolbar" aria-label="서식">
      <div class="tb-group">${b('bold', '<b>B</b>', '굵게')}${b('italic', '<i>I</i>', '기울임')}${b('underline', '<u>U</u>', '밑줄')}${b('strikeThrough', '<s>S</s>', '취소선')}${b('superscript', 'x²', '위 첨자')}${b('subscript', 'x₂', '아래 첨자')}</div>
      <div class="tb-group">
        <label class="tb tb-color" title="글자 색"><span>A</span><input type="color" data-color="foreColor" value="#d6336c" aria-label="글자 색"></label>
        <label class="tb tb-color tb-bg" title="글자 배경"><span>A</span><input type="color" data-color="hiliteColor" value="#ffe066" aria-label="글자 배경"></label>
        <select class="tb" data-size aria-label="글자 크기"><option value="">크기</option><option value="2">작게</option><option value="3">보통</option><option value="5">크게</option><option value="6">아주 크게</option></select>
      </div>
      <div class="tb-group">${b('insertUnorderedList', '• 목록', '글머리 목록')}${b('insertOrderedList', '1. 목록', '번호 목록')}${b('justifyLeft', '⇤', '왼쪽 정렬')}${b('justifyCenter', '≡', '가운데 정렬')}${b('justifyRight', '⇥', '오른쪽 정렬')}</div>
      <div class="tb-group">${b('link', '링크', '링크 (주소 또는 문서 이름)')}<label class="tb" title="그림 넣기">그림<input type="file" accept="image/*" data-body-img hidden></label>${b('table', '표', '표 넣기')}${b('quote', '인용', '인용구')}${b('fn', '각주', '각주')}${b('spoiler', '스포', '스포일러 가리기')}${b('hr', '―', '구분선')}${b('clear', '지우기', '서식 지우기')}</div>
      <div class="tb-group tb-table" hidden><span class="tb-lbl">표</span>${b('row+', '행+', '행 추가')}${b('row-', '행−', '행 삭제')}${b('col+', '열+', '열 추가')}${b('col-', '열−', '열 삭제')}</div>
    </div>`;
  }

  function drawCharEditor(id) {
    const d = state.draft;
    const isDoc = d.kind === 'doc';
    const others = db().characters.filter((c) => c.id !== d.id);
    const scrollY = window.scrollY;
    const cancel = id ? '#/oc/' + encId(id) : (isDoc ? '#/docs' : '#/');
    const cover = coverOf(d);

    $app.innerHTML = `
      <form class="wiki wiki-edit" id="editor" autocomplete="off" style="--oc:${safeColor(d.color)};--accent:${safeColor(d.color)}">
        ${toolbarHtml()}
        <div class="wiki-edit-head">
          <a class="back" href="${cancel}">← 취소</a>
          <span class="muted">문서를 눌러서 바로 쓰고, 글자를 고른 뒤 위 도구로 꾸며요.</span>
          <button type="button" class="btn btn-sm tpl-save" id="save-tpl" title="지금 문서의 프로필 항목·목차·경고문을 틀로 저장">📋 틀로 저장</button>
        </div>

        <details class="fieldset doc-info" ${d.name ? '' : 'open'}>
          <summary>문서 정보 <span class="muted">이름 · 분류 · 색</span></summary>
          <div class="row2">
            <div class="field"><label for="f-name">${isDoc ? '문서 제목' : '이름'} *</label>
              <input type="text" id="f-name" data-path="name" value="${esc(d.name)}" required></div>
            <div class="field"><label for="f-sub">${isDoc ? '부제' : '부제 / 영문명'}</label>
              <input type="text" id="f-sub" data-path="subname" value="${esc(d.subname)}"></div>
          </div>
          <div class="row2">
            <div class="field"><label for="f-world">세계관 / 작품 <span class="muted">(분류)</span></label>
              <input type="text" id="f-world" data-path="world" value="${esc(d.world)}" list="world-list">
              <datalist id="world-list">${[...new Set(db().characters.map((c) => c.world).filter(Boolean))].map((w) => `<option value="${esc(w)}">`).join('')}</datalist></div>
            <div class="field"><label for="f-color">테마 색</label>
              <input type="color" id="f-color" data-path="color" value="${esc(safeColor(d.color))}"></div>
          </div>
          <div class="field"><label for="f-tags">태그 <span class="muted">(분류)</span></label>
            <input type="text" id="f-tags" data-path="tagsText" value="${esc(d.tagsText)}" placeholder="쉼표로 구분 (예: 인간, 마법사, 주인공)"></div>
          <div class="field"><label for="f-summary">한 줄 소개 <span class="muted">(목록 카드에 보여요)</span></label>
            <input type="text" id="f-summary" data-path="summary" value="${esc(d.summary)}"></div>
        </details>

        <div class="wiki-head"><h1 id="ed-title">${esc(d.name || (isDoc ? '문서 제목' : '이름'))}</h1></div>

        <div class="notices-edit">
          ${d.notices.map((n, i) => `
            <div class="wiki-notice">
              <select data-path="notices.${i}.icon" aria-label="아이콘">${NOTICE_ICONS.map((ic) => `<option ${ic === n.icon ? 'selected' : ''}>${ic}</option>`).join('')}</select>
              <div class="grow" contenteditable="true" data-html="notices.${i}.text" data-placeholder="안내 문구 (예: 이 문서에는 스포일러가 있어요)">${cleanHtml(n.text, 'view')}</div>
              <button type="button" class="x" data-act="del" data-list="notices" data-i="${i}" aria-label="경고문 삭제">×</button>
            </div>`).join('')}
          <button type="button" class="btn btn-sm" data-act="add" data-list="notices">+ 경고문</button>
        </div>

        <div class="wiki-top">
          <nav class="wiki-toc"><div class="toc-h">목차</div>${tocHtml(d.chapters, '') || '<p class="muted">챕터를 추가하면 자동으로 만들어져요</p>'}</nav>
          <aside class="infobox">
            <div class="ib-title"><span id="ib-name">${esc(d.name || '이름')}</span><small id="ib-sub">${esc(d.subname)}</small></div>
            <div class="ib-img ${cover ? '' : 'empty'}">${cover ? `<img src="${esc(imgUrl(cover))}" alt="">` : '<span>아래 [그림]에서 그림을 올리면 여기 보여요</span>'}</div>
            <table><tbody>${d.profile.map((r, i) => (r.type === 'head'
              ? `<tr><th colspan="2" class="ib-group" contenteditable="true" data-text="profile.${i}.label" data-placeholder="묶음 제목">${esc(r.label)}</th>
                 <td class="row-x"><button type="button" class="x" data-act="del" data-list="profile" data-i="${i}" aria-label="삭제">×</button></td></tr>`
              : `<tr><th contenteditable="true" data-text="profile.${i}.label" data-placeholder="항목">${esc(r.label)}</th>
                 <td contenteditable="true" data-html="profile.${i}.value" data-placeholder="내용">${cleanHtml(r.value, 'view')}</td>
                 <td class="row-x"><button type="button" class="x" data-act="del" data-list="profile" data-i="${i}" aria-label="삭제">×</button></td></tr>`)).join('')}
            </tbody></table>
            <div class="ib-add">
              <button type="button" class="btn btn-sm" data-act="add" data-list="profile">+ 항목</button>
              <button type="button" class="btn btn-sm" data-act="add-head">+ 묶음 제목</button>
            </div>
          </aside>
        </div>

        ${chaptersHtml(d.chapters, '', '', true)}
        <button type="button" class="btn btn-sm add-ch" data-ch-act="add-top">+ 챕터 추가</button>
        <p class="hint">빈 항목과 빈 챕터는 저장할 때 빠져요. 내용이 비어도 제목이 있는 챕터는 남아요.</p>

        <div class="fieldset">
          <div class="fieldset-title">그림</div>
          ${imagesFieldHtml(d, true)}
        </div>

        <div class="fieldset">
          <div class="fieldset-title">관계</div>
          <div class="rows">
            ${d.relations.map((r, i) => `
              <div class="rel-row">
                <input type="text" data-path="relations.${i}.name" value="${esc(r.id && findChar(r.id) ? findChar(r.id).name : r.name)}" list="char-list" placeholder="상대 이름">
                <input type="text" data-path="relations.${i}.type" value="${esc(r.type)}" placeholder="관계 (예: 소꿉친구)">
                <input type="text" data-path="relations.${i}.note" value="${esc(r.note)}" placeholder="메모">
                <button type="button" class="btn btn-icon btn-danger" data-act="del" data-list="relations" data-i="${i}" aria-label="삭제">×</button>
              </div>`).join('')}
          </div>
          <datalist id="char-list">${others.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
          <button type="button" class="btn btn-sm" data-act="add" data-list="relations">+ 관계 추가</button>
          <div class="hint">친구 자캐도 이름을 넣으면 그 페이지로 연결돼요.</div>
        </div>

        <div class="form-actions">
          <a class="btn" href="${cancel}">취소</a>
          <button type="submit" class="btn btn-primary">저장</button>
        </div>
      </form>`;

    window.scrollTo(0, scrollY);
    const $form = document.getElementById('editor');
    $form.querySelectorAll('sup.fn').forEach((s) => { s.contentEditable = 'false'; });

    // 구조가 바뀌기 전에 화면에서 고친 내용을 먼저 데이터에 옮겨요 (순서가 바뀌면 엉뚱한 칸에 들어가니까)
    const sync = () => {
      $form.querySelectorAll('[data-html]').forEach((el) => setPath(d, el.dataset.html, el.innerHTML));
      $form.querySelectorAll('[data-text]').forEach((el) => setPath(d, el.dataset.text, el.textContent.replace(/\s+/g, ' ').trim()));
    };
    $form.addEventListener('click', (e) => { if (e.target.closest('[data-act], [data-ch-act]')) sync(); }, true);
    $form.addEventListener('change', (e) => { if (e.target.id === 'img-file') sync(); }, true);

    const redraw = () => drawCharEditor(id);
    bindEditor($form, d, redraw, (list) => (list === 'profile' ? { type: 'row', label: '', value: '' }
      : list === 'notices' ? { icon: '⚠️', text: '' }
      : { id: '', name: '', type: '', note: '' }));

    $form.addEventListener('input', (e) => {
      if (e.target.id === 'f-name') {
        document.getElementById('ib-name').textContent = e.target.value || '이름';
        document.getElementById('ed-title').textContent = e.target.value || (isDoc ? '문서 제목' : '이름');
      }
      if (e.target.id === 'f-sub') document.getElementById('ib-sub').textContent = e.target.value;
      if (e.target.id === 'f-color') $form.style.setProperty('--oc', safeColor(e.target.value));
    });

    $form.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="add-head"]')) {
        d.profile.push({ type: 'head', label: '', value: '' });
        return redraw();
      }
      const b = e.target.closest('[data-ch-act]');
      if (b) { chapterAction(d, b.dataset.chAct, b.dataset.ch); redraw(); return; }
      const fn = e.target.closest('[data-html] sup.fn');
      if (fn) {
        const v = prompt('각주 내용 (비우면 각주를 지워요)', fn.getAttribute('data-note') || '');
        if (v === null) return;
        if (v.trim()) fn.setAttribute('data-note', v.trim()); else fn.remove();
      }
    });

    // 제목·항목 이름 칸: 줄바꿈 없이 글자만
    $form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-text]')) e.preventDefault();
    });
    $form.addEventListener('paste', (e) => {
      if (!e.target.closest || !e.target.closest('[data-text]')) return;
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s+/g, ' '));
    });

    bindToolbar($form, d);
    document.getElementById('save-tpl').addEventListener('click', () => { sync(); saveDraftAsTemplate(d); });

    $form.addEventListener('submit', async (e) => {
      e.preventDefault();
      sync();
      const name = d.name.trim();
      if (!name) {
        $form.querySelector('.doc-info').open = true;
        document.getElementById('f-name').focus();
        return toast('이름을 입력해 주세요');
      }
      const files = [];
      const clean = (h) => (isBlankHtml(h) ? '' : cleanHtml(h, 'store', files));
      const cleanChapters = (list) => list.map((ch) => ({
        id: ch.id, title: ch.title.trim(), body: clean(ch.body), children: cleanChapters(ch.children),
      })).filter((ch) => ch.title || ch.body || ch.children.length);
      const c = normalizeChar({
        ...d,
        doc: 3,
        name,
        owner: d.owner || state.user.login,
        tags: [...new Set(d.tagsText.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))],
        notices: d.notices.map((n) => ({ icon: n.icon, text: clean(n.text) })).filter((n) => n.text),
        profile: d.profile.map((r) => (r.type === 'head'
          ? { type: 'head', label: r.label.trim(), value: '' }
          : { type: 'row', label: r.label.trim(), value: clean(r.value) }))
          .filter((r) => (r.type === 'head' ? r.label : r.value)),
        chapters: cleanChapters(d.chapters),
        relations: d.relations.filter((r) => r.name.trim()).map((r) => {
          const t = db().characters.find((x) => x.name === r.name.trim() && x.id !== d.id);
          return { ...r, name: r.name.trim(), id: t ? t.id : '' };
        }),
        updatedAt: new Date().toISOString(),
      });
      if (!c.images.some((img) => img.src === c.avatar)) c.avatar = '';
      const json = JSON.stringify(c);
      Object.entries(d._files).forEach(([path, base64]) => {
        if (json.includes(path) && !files.some((f) => f.path === path)) files.push({ path, base64 });
      });
      $form.querySelector('[type=submit]').disabled = true;
      const what = c.kind === 'doc' ? '문서' : '캐릭터';
      const ok = await trySave(`${what} ${id ? '수정' : '추가'}: ${c.name}`, (next) => {
        const idx = next.characters.findIndex((x) => x.id === c.id);
        if (idx >= 0) next.characters[idx] = { ...c, createdAt: next.characters[idx].createdAt };
        else next.characters.push(c);
      }, files);
      if (ok) {
        state.draft = null;
        toast('저장했어요');
        location.hash = '#/oc/' + encId(c.id);
      } else {
        $form.querySelector('[type=submit]').disabled = false;
      }
    });
  }

  function chapterAction(d, act, idxStr) {
    const blank = () => ({ id: uid('ch'), title: '', body: '', children: [] });
    if (act === 'add-top') { d.chapters.push(blank()); return; }
    const idx = idxStr.split('.').map(Number);
    let list = d.chapters;
    let parent = null;
    for (let k = 0; k < idx.length - 1; k++) { parent = { list, i: idx[k] }; list = list[idx[k]].children; }
    const i = idx[idx.length - 1];
    if (act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else if (act === 'in' && i > 0) list[i - 1].children.push(...list.splice(i, 1));
    else if (act === 'out' && parent) parent.list.splice(parent.i + 1, 0, ...list.splice(i, 1));
    else if (act === 'child') list[i].children.push(blank());
    else if (act === 'del') {
      const ch = list[i];
      const has = ch.title || !isBlankHtml(ch.body) || ch.children.length;
      if (!has || confirm(`'${ch.title || '제목 없는 챕터'}'${ch.children.length ? '와 하위 챕터' : ''}를 지울까요?`)) list.splice(i, 1);
    }
  }

  function bindToolbar($form, d) {
    const $tb = $form.querySelector('#wtb');
    const $tableBar = $tb.querySelector('.tb-table');
    let range = null;
    const elOf = (n) => (n && n.nodeType === 1 ? n : n && n.parentElement);
    const editableOf = (n) => { const el = elOf(n); return el && el.closest('[data-html]'); };
    const cellOf = () => {
      const ed = range && editableOf(range.startContainer);
      const cell = ed && elOf(range.startContainer).closest('td, th');
      return cell && cell !== ed && ed.contains(cell) ? cell : null;
    };

    const onSel = () => {
      if (!document.body.contains($form)) { document.removeEventListener('selectionchange', onSel); return; }
      const sel = getSelection();
      if (!sel.rangeCount || !$form.contains(sel.anchorNode) || !editableOf(sel.anchorNode)) return;
      range = sel.getRangeAt(0).cloneRange();
      $tableBar.hidden = !cellOf();
    };
    document.addEventListener('selectionchange', onSel);

    const restore = () => {
      if (!range || !document.body.contains(range.startContainer)) { toast('먼저 문서에서 글자를 쓸 곳을 눌러 주세요'); return false; }
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    };
    const exec = (cmd, val) => {
      if (!restore()) return;
      document.execCommand('styleWithCSS', false, true);
      document.execCommand(cmd, false, val);
    };
    const insert = (html) => { if (restore()) document.execCommand('insertHTML', false, html); };

    $tb.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    $tb.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (!b) return;
      const cmd = b.dataset.cmd;
      if (cmd === 'link') {
        const v = (prompt('링크할 주소(https://…) 또는 이 사이트의 문서·캐릭터 이름') || '').trim();
        if (!v) return;
        let href = v;
        if (!/^https?:\/\//i.test(v)) {
          const t = db().characters.find((x) => x.name === v);
          if (!t) return alert(`'${v}' 문서를 찾지 못했어요.\n바깥 주소는 https:// 로 시작해야 해요.`);
          href = '#/oc/' + encId(t.id);
        }
        if (range && !range.collapsed) exec('createLink', href);
        else insert(`<a href="${esc(href)}">${esc(v)}</a>`);
      } else if (cmd === 'table') {
        insert('<table><tbody><tr><th>제목</th><th>제목</th></tr><tr><td>내용</td><td>내용</td></tr></tbody></table><p><br></p>');
      } else if (cmd === 'quote') {
        exec('formatBlock', '<blockquote>');
      } else if (cmd === 'fn') {
        if (!range) return restore();
        const note = (prompt('각주 내용') || '').trim();
        if (note) insert(`<sup class="fn" data-note="${esc(note)}" contenteditable="false">*</sup>&#8203;`);
      } else if (cmd === 'spoiler') {
        if (!restore()) return;
        const sel = getSelection();
        if (sel.isCollapsed) return toast('가릴 글자를 먼저 골라 주세요');
        const r = sel.getRangeAt(0);
        const span = document.createElement('span');
        span.className = 'spoiler';
        span.appendChild(r.extractContents());
        r.insertNode(span);
      } else if (cmd === 'hr') {
        exec('insertHorizontalRule');
      } else if (cmd === 'clear') {
        exec('removeFormat');
        document.execCommand('unlink');
      } else if (/^(row|col)[+-]$/.test(cmd)) {
        const cell = cellOf();
        if (!cell) return;
        const tr = cell.parentElement;
        const table = cell.closest('table');
        const ci = cell.cellIndex;
        const blankCell = (tag) => { const x = document.createElement(tag); x.innerHTML = '<br>'; return x; };
        if (cmd === 'row+') {
          const nr = document.createElement('tr');
          [...tr.cells].forEach(() => nr.appendChild(blankCell('td')));
          tr.after(nr);
        } else if (cmd === 'row-') {
          if (table.rows.length > 1) tr.remove(); else table.remove();
        } else if (cmd === 'col+') {
          [...table.rows].forEach((row) => {
            const ref = row.cells[ci];
            const n = blankCell(ref && ref.tagName === 'TH' ? 'th' : 'td');
            if (ref) ref.after(n); else row.appendChild(n);
          });
        } else if (cmd === 'col-') {
          if (tr.cells.length <= 1) table.remove();
          else [...table.rows].forEach((row) => { if (row.cells[ci]) row.cells[ci].remove(); });
        }
        range = null;
        $tableBar.hidden = true;
      } else {
        exec(cmd);
      }
    });

    $tb.querySelectorAll('[data-color]').forEach((inp) => inp.addEventListener('change', () => exec(inp.dataset.color, inp.value)));
    $tb.querySelector('[data-size]').addEventListener('change', (e) => {
      if (e.target.value) exec('fontSize', e.target.value);
      e.target.value = '';
    });
    $tb.querySelector('[data-body-img]').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length || !range) { if (!range) toast('먼저 그림을 넣을 곳을 눌러 주세요'); return; }
      const t = toast('그림 준비 중…', 0);
      let html = '';
      for (const file of files) {
        try {
          const url = await fileToDataUrl(file);
          const f = dataUrlToFile(url);
          if (!f) throw new Error('형식');
          d._files[f.path] = f.base64;
          html += `<img data-src="${esc(f.path)}" src="${url}" alt="">`;
        } catch (err) {
          alert(`'${file.name}'을(를) 불러오지 못했어요.`);
        }
      }
      t.remove();
      if (html) insert(html);
    });
  }

  // ---------- post editor ----------
  function renderPostEditor(id, query) {
    renderChrome('posts');
    if (!state.user) return requireLogin();
    const key = 'post:' + (id || 'new');
    if (!state.draft || state.draft._for !== key) {
      const base = id ? findPost(id) : null;
      if (id && (!base || !isMine(base.author))) return renderNotFound();
      const d = JSON.parse(JSON.stringify(base || normalizePost({ id: uid('post'), chars: query.oc ? [query.oc] : [] })));
      d._for = key;
      d._files = {};
      state.draft = d;
      window.scrollTo(0, 0);
    }
    drawPostEditor(id);
  }

  function drawPostEditor(id) {
    const d = state.draft;
    const scrollY = window.scrollY;
    const cancel = id ? '#/post/' + encId(id) : '#/posts';
    const all = db().characters;
    const mine = all.filter((c) => c.owner === state.user.login);
    const others = all.filter((c) => c.owner !== state.user.login);
    const pick = (c) => `<button type="button" class="char-toggle ${d.chars.includes(c.id) ? 'on' : ''}" data-act="toggle-char" data-id="${esc(c.id)}" style="--oc:${safeColor(c.color)}">
      <span class="mini">${thumbHtml(c)}</span>${esc(c.name)}</button>`;

    $app.innerHTML = `
      <form class="editor" id="editor" autocomplete="off">
        <a class="back" href="${cancel}">← 취소</a>
        <h1>${id ? '글 수정' : '글쓰기'}</h1>
        <div class="fieldset">
          <div class="field"><label for="p-title">제목</label>
            <input type="text" id="p-title" data-path="title" value="${esc(d.title)}" placeholder="제목"></div>
          <div class="field"><label for="p-body">내용</label>
            <textarea id="p-body" data-path="body" rows="12" placeholder="썰, 설정 메모, 짧은 글… 자유롭게">${esc(d.body)}</textarea></div>
        </div>
        <div class="fieldset">
          <div class="fieldset-title">그림</div>
          ${imagesFieldHtml(d, false)}
        </div>
        ${all.length ? `<div class="fieldset">
          <div class="fieldset-title">등장 캐릭터</div>
          ${mine.length ? `<div class="char-picks">${mine.map(pick).join('')}</div>` : ''}
          ${others.length ? `<div class="hint" style="margin:10px 0 6px">친구 캐릭터</div><div class="char-picks">${others.map(pick).join('')}</div>` : ''}
          <div class="hint">고른 캐릭터 페이지의 '관련 게시물'에도 이 글이 보여요.</div>
        </div>` : ''}
        <div class="form-actions">
          <a class="btn" href="${cancel}">취소</a>
          <button type="submit" class="btn btn-primary">${id ? '저장' : '올리기'}</button>
        </div>
      </form>`;

    window.scrollTo(0, scrollY);
    const $form = document.getElementById('editor');
    bindEditor($form, d, () => drawPostEditor(id), () => ({}));

    $form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!d.title.trim() && !d.body.trim() && !d.images.length) return toast('제목, 내용, 그림 중 하나는 있어야 해요');
      const p = normalizePost({ ...d, title: d.title.trim(), author: d.author || state.user.login, updatedAt: new Date().toISOString() });
      if (!id) p.createdAt = p.updatedAt;
      $form.querySelector('[type=submit]').disabled = true;
      const ok = await trySave(`${id ? '게시물 수정' : '게시물 작성'}: ${p.title || '(제목 없음)'}`, (next) => {
        const idx = next.posts.findIndex((x) => x.id === p.id);
        if (idx >= 0) next.posts[idx] = { ...p, createdAt: next.posts[idx].createdAt };
        else next.posts.push(p);
      }, pendingFiles(d));
      if (ok) {
        state.draft = null;
        toast('올렸어요');
        location.hash = '#/post/' + encId(p.id);
      } else {
        $form.querySelector('[type=submit]').disabled = false;
      }
    });
  }

  // ---------- me / settings / backup ----------
  function renderMe() {
    renderChrome('');
    if (!state.user) return renderLogin();
    const me = state.user.login;
    const myChars = db().characters.filter((c) => c.owner === me).length;
    const myPosts = db().posts.filter((p) => p.author === me).length;
    const users = Object.keys((state.accounts && state.accounts.users) || {}).sort();

    $app.innerHTML = `
      <div class="page-head"><h1>내 정보</h1></div>
      <div class="backup-grid">
        <div class="fieldset">
          <div class="fieldset-title">계정</div>
          <div class="me-row">${avatarHtml(me, 'avatar-xl')}
            <div><strong>${esc(me)}</strong>${state.user.admin ? ' <span class="tag">관리자</span>' : ''}<br>
            <span class="muted">캐릭터 ${myChars} · 게시물 ${myPosts}</span></div></div>
          <form id="pw-form" style="margin-top:14px">
            <div class="field"><label for="new-pw">비밀번호 바꾸기</label>
              <input type="password" id="new-pw" autocomplete="new-password" placeholder="새 비밀번호 (8자 이상)" required></div>
            <div class="field"><input type="password" id="new-pw2" autocomplete="new-password" placeholder="새 비밀번호 확인" required></div>
            <div class="btns">
              <button type="submit" class="btn">비밀번호 바꾸기</button>
              <button type="button" class="btn btn-danger" id="logout">로그아웃</button>
            </div>
          </form>
        </div>

        ${state.user.admin ? `
        <div class="fieldset">
          <div class="fieldset-title">계정 관리</div>
          <div class="user-list">${users.map((u) => `
            <div class="user-row">${avatarHtml(u)}<span>${esc(u)}${state.accounts.users[u].admin ? ' <span class="muted">관리자</span>' : ''}</span>
              ${u !== me ? `<button type="button" class="link-btn" data-del-user="${esc(u)}">삭제</button>` : ''}</div>`).join('')}</div>
          <form id="add-user-form">
            <div class="row2">
              <input type="text" id="nu-id" placeholder="친구 아이디" autocomplete="off" required>
              <input type="text" id="nu-pw" placeholder="비밀번호 (8자 이상)" autocomplete="off" required>
            </div>
            <div class="btns" style="margin-top:8px"><button type="submit" class="btn btn-primary">계정 만들기</button></div>
          </form>
          <p class="hint">만든 아이디와 비밀번호를 친구에게 알려 주세요. 친구는 로그인한 뒤 [내 정보]에서 비밀번호를 바꿀 수 있어요.</p>
        </div>
        <div class="fieldset">
          <div class="fieldset-title">GitHub 토큰 교체</div>
          <p>토큰이 만료돼서 저장이 안 될 때만 쓰면 돼요. 새 토큰을 넣으면 모든 계정이 그대로 새 토큰을 써요.</p>
          <form id="token-form">
            <input type="password" id="new-token" placeholder="github_pat_..." autocomplete="off" required>
            <div class="btns" style="margin-top:8px"><button type="submit" class="btn">토큰 교체</button></div>
          </form>
        </div>` : ''}

        ${state.legacy && state.legacy.length ? `
        <div class="fieldset highlight">
          <div class="fieldset-title">예전 데이터 옮기기</div>
          <p>이 브라우저에 예전 방식으로 저장된 캐릭터 ${state.legacy.length}명(${esc(state.legacy.map((c) => c.name).join(', '))})이 있어요. 공유 저장소에 내 캐릭터로 올릴까요?</p>
          <div class="btns"><button type="button" class="btn btn-primary" id="migrate">공유 저장소로 옮기기</button>
            <button type="button" class="btn" id="drop-legacy">옮기지 않고 지우기</button></div>
        </div>` : ''}

        ${backupCardHtml()}

        <div class="fieldset">
          <div class="fieldset-title">파일에서 캐릭터 불러오기</div>
          <p>예전에 이 사이트에서 내보낸 .json 백업 파일의 캐릭터를 내 캐릭터로 추가해요.</p>
          <div class="btns"><label class="btn">파일 고르기<input type="file" id="import" accept=".json,application/json" hidden></label></div>
        </div>
        ${state.user.admin ? `
        <div class="fieldset">
          <div class="fieldset-title">사이트 제목</div>
          <div class="field"><input type="text" id="site-title-input" value="${esc(db().siteTitle)}"></div>
          <div class="btns"><button type="button" class="btn" id="save-title">제목 저장</button></div>
        </div>` : ''}
      </div>`;

    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    const busy = async (btn, fn) => {
      btn.disabled = true;
      try { await fn(); } catch (err) { alert(err.message); } finally { btn.disabled = false; }
    };

    on('logout', 'click', async () => {
      if (!confirm('로그아웃할까요?')) return;
      logout();
      renderMe();
    });
    on('pw-form', 'submit', (e) => {
      e.preventDefault();
      const pw = document.getElementById('new-pw').value;
      const problem = checkNewCredentials(undefined, pw, document.getElementById('new-pw2').value);
      if (problem) return alert(problem);
      busy(e.target.querySelector('[type=submit]'), async () => {
        const wrapped = await wrapKey(state.key, pw);
        await updateAccounts(`비밀번호 변경: ${me}`, (a) => {
          if (!a.users[me]) throw new Error('계정을 찾을 수 없어요.');
          a.users[me] = { ...a.users[me], ...wrapped };
        });
        toast('비밀번호를 바꿨어요');
        renderMe();
      });
    });
    on('add-user-form', 'submit', (e) => {
      e.preventDefault();
      const id = document.getElementById('nu-id').value.trim();
      const pw = document.getElementById('nu-pw').value;
      const problem = checkNewCredentials(id, pw);
      if (problem) return alert(problem);
      busy(e.target.querySelector('[type=submit]'), async () => {
        const entry = { ...(await wrapKey(state.key, pw)), admin: false, createdAt: new Date().toISOString() };
        await updateAccounts(`계정 추가: ${id}`, (a) => {
          if (a.users[id]) throw new Error('이미 있는 아이디예요.');
          a.users[id] = entry;
        });
        alert(`계정을 만들었어요.\n\n아이디: ${id}\n비밀번호: ${pw}\n\n친구에게 알려 주세요.`);
        renderMe();
      });
    });
    $app.querySelectorAll('[data-del-user]').forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.delUser;
      if (!confirm(`'${id}' 계정을 삭제할까요? 그 사람이 올린 글과 캐릭터는 남아 있어요.`)) return;
      busy(b, async () => {
        await updateAccounts(`계정 삭제: ${id}`, (a) => { delete a.users[id]; });
        renderMe();
      });
    }));
    on('token-form', 'submit', (e) => {
      e.preventDefault();
      const token = document.getElementById('new-token').value.trim();
      busy(e.target.querySelector('[type=submit]'), async () => {
        await checkToken(token);
        const box = await seal(await aesKey(state.key), utf8.encode(token));
        await updateAccounts('GitHub 토큰 교체', (a) => { a.token = box; });
        toast('토큰을 바꿨어요');
        renderMe();
      });
    });
    on('save-title', 'click', async () => {
      const t = document.getElementById('site-title-input').value.trim() || '자캐 백업';
      if (await trySave('사이트 제목 변경', (d) => { d.siteTitle = t; })) { toast('저장했어요'); renderMe(); }
    });
    on('export-json', 'click', exportJson);
    on('import', 'change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      let parsed;
      try {
        parsed = JSON.parse((await file.text()).trim().replace(/^(\/\/[^\n]*\n)*\s*window\.OC_DATA\s*=\s*/, '').replace(/;\s*$/, ''));
      } catch (err) {
        return alert('파일을 읽지 못했어요. 이 사이트에서 내보낸 백업 파일인지 확인해 주세요.');
      }
      const list = arr(Array.isArray(parsed) ? parsed : parsed.characters);
      if (!list.length) return alert('파일에 캐릭터가 없어요.');
      if (await importCharacters(list, `파일에서 캐릭터 ${list.length}명 불러오기`)) renderMe();
    });
    on('migrate', 'click', async () => {
      if (await importCharacters(state.legacy, `예전 데이터에서 캐릭터 ${state.legacy.length}명 옮기기`)) {
        await clearLegacy();
        renderMe();
      }
    });
    on('drop-legacy', 'click', async () => {
      if (!confirm('이 브라우저에 남은 예전 데이터를 지울까요? 되돌릴 수 없어요.')) return;
      await clearLegacy();
      renderMe();
    });
  }

  function backupCardHtml() {
    return `<div class="fieldset">
      <div class="fieldset-title">백업 받기</div>
      <p>모든 데이터는 GitHub 저장소에 저장되고 고친 기록도 다 남아요. 따로 보관하고 싶으면:</p>
      <div class="btns">
        <button type="button" class="btn" id="export-json">글·설정만 (.json)</button>
        <a class="btn" href="https://github.com/${encId(CFG.owner)}/${encId(CFG.repo)}/archive/refs/heads/${encId(CFG.branch)}.zip">그림까지 전부 (.zip)</a>
      </div>
    </div>`;
  }
  function exportJson() {
    download(`oc-backup-${today()}.json`, JSON.stringify({ ...db(), exportedAt: new Date().toISOString() }, null, 2));
  }

  function renderLogin() {
    const ready = !!(state.accounts && state.accounts.token);
    const patUrl = 'https://github.com/settings/personal-access-tokens/new?name=' + encId('자캐 백업') + '&contents=write';
    $app.innerHTML = `
      <div class="page-head"><h1>${ready ? '로그인' : '처음 설정'}</h1></div>
      <div class="backup-grid">
        ${ready ? `
        <div class="fieldset login-card">
          <form id="login-form">
            <div class="field"><label for="login-id">아이디</label>
              <input type="text" id="login-id" autocomplete="username" autocapitalize="off" required></div>
            <div class="field"><label for="login-pw">비밀번호</label>
              <input type="password" id="login-pw" autocomplete="current-password" required></div>
            <div class="btns"><button type="submit" class="btn btn-primary">로그인</button></div>
          </form>
          <p class="hint">계정은 저장소 주인이 만들어 줘요. 한 번 로그인하면 이 기기에서는 계속 로그인돼 있어요.</p>
        </div>` : `
        <div class="fieldset login-card">
          <div class="fieldset-title">저장소 주인(${esc(CFG.owner)})이 한 번만 하면 돼요</div>
          <ol class="steps">
            <li><a href="${patUrl}" target="_blank" rel="noopener">GitHub 토큰 만들기 페이지 열기</a></li>
            <li><b>Expiration</b>: 가능한 길게 (만료되면 나중에 교체할 수 있어요)</li>
            <li><b>Repository access</b>: <b>Only select repositories</b> → <b>${esc(CFG.repo)}</b></li>
            <li><b>Permissions</b> → <b>Contents</b>를 <b>Read and write</b>로</li>
            <li><b>Generate token</b> → <code>github_pat_</code>로 시작하는 토큰 복사</li>
          </ol>
          <form id="setup-form">
            <div class="field"><label for="su-token">GitHub 토큰</label>
              <input type="password" id="su-token" placeholder="github_pat_..." autocomplete="off" required></div>
            <div class="field"><label for="su-id">내 아이디</label>
              <input type="text" id="su-id" value="${esc(CFG.owner)}" autocapitalize="off" required></div>
            <div class="row2">
              <div class="field"><label for="su-pw">비밀번호 (8자 이상)</label>
                <input type="password" id="su-pw" autocomplete="new-password" required></div>
              <div class="field"><label for="su-pw2">비밀번호 확인</label>
                <input type="password" id="su-pw2" autocomplete="new-password" required></div>
            </div>
            <div class="btns"><button type="submit" class="btn btn-primary">설정 완료</button></div>
          </form>
          <p class="hint">토큰은 비밀번호로 암호화해서 저장소에 저장돼요. 이후에는 아이디와 비밀번호로만 로그인하고, 친구 계정도 사이트에서 만들 수 있어요.</p>
        </div>`}
        ${backupCardHtml()}
      </div>`;

    const $login = document.getElementById('login-form');
    if ($login) $login.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $login.querySelector('button');
      btn.disabled = true;
      btn.textContent = '확인 중…';
      try {
        await login(document.getElementById('login-id').value.trim(), document.getElementById('login-pw').value);
        await loadDb();
        toast(`${state.user.login}님 환영해요`);
        location.hash = '#/';
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = '로그인';
      }
    });
    const $setup = document.getElementById('setup-form');
    if ($setup) $setup.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('su-id').value.trim();
      const pw = document.getElementById('su-pw').value;
      const problem = checkNewCredentials(id, pw, document.getElementById('su-pw2').value);
      if (problem) return alert(problem);
      const btn = $setup.querySelector('button');
      btn.disabled = true;
      try {
        await setupFirstAccount(document.getElementById('su-token').value.trim(), id, pw);
        await loadDb();
        toast('설정을 마쳤어요');
        renderMe();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
    document.getElementById('export-json').addEventListener('click', exportJson);
  }

  // 다른 곳에서 온 캐릭터를 내 캐릭터로 추가. data: 그림은 저장소 파일로 바꿔서 올려요.
  async function importCharacters(list, message) {
    const files = [];
    const existing = new Set(db().characters.map((c) => c.id));
    const incoming = list.map((raw) => {
      const c = normalizeChar(raw);
      if (existing.has(c.id)) c.id = uid('oc');
      c.owner = state.user.login;
      c.images = c.images.map((img) => {
        if (!/^data:image\//.test(img.src)) return img;
        const f = dataUrlToFile(img.src);
        if (!f) return null;
        files.push(f);
        if (c.avatar === img.src) c.avatar = f.path;
        return { ...img, src: f.path };
      }).filter(Boolean);
      if (/^data:/.test(c.avatar)) c.avatar = '';
      return c;
    });
    if (!confirm(`${incoming.map((c) => c.name).join(', ')}\n\n이 ${incoming.length}명을 내 캐릭터로 올릴까요?`)) return false;
    const ok = await trySave(message, (d) => { d.characters.push(...incoming); }, files);
    if (ok) toast(`${incoming.length}명을 올렸어요`);
    return ok;
  }

  // ---------- legacy (예전 버전: 브라우저 IndexedDB 저장) ----------
  function legacyDb(mode, fn) {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return resolve(null);
      const req = indexedDB.open('oc-backup', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', mode);
        const r = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(r && r.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  async function loadLegacy() {
    try {
      const d = await legacyDb('readonly', (s) => s.get('data'));
      const list = d && Array.isArray(d.characters) ? d.characters : [];
      // 손대지 않은 예시 캐릭터는 옮길 필요 없음
      state.legacy = list.filter((c) => !(c.id === 'sample-haneul' && c.updatedAt === '2026-10-29T00:00:00.000Z'));
    } catch (e) {
      state.legacy = null;
    }
  }
  async function clearLegacy() {
    try { await legacyDb('readwrite', (s) => s.delete('data')); } catch (e) { /* ignore */ }
    state.legacy = null;
  }

  // ---------- lightbox ----------
  document.addEventListener('click', (e) => {
    const z = e.target.closest('[data-zoom]');
    if (!z || !z.dataset.zoom) return;
    $lightbox.querySelector('img').src = z.dataset.zoom;
    $lightbox.querySelector('.lightbox-caption').textContent = z.dataset.caption || '';
    $lightbox.hidden = false;
  });
  $lightbox.addEventListener('click', (e) => { if (e.target.tagName !== 'IMG') $lightbox.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $lightbox.hidden = true; });

  // ---------- theme ----------
  const themeKey = 'oc-backup-theme';
  try {
    const saved = localStorage.getItem(themeKey);
    if (saved) document.documentElement.dataset.theme = saved;
  } catch (e) { /* storage 사용 불가 */ }
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(themeKey, next); } catch (e) { /* ignore */ }
  });

  // ---------- router ----------
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [pathPart, qs] = raw.split('?');
    const [page, rawId] = pathPart.split('/');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));
    return { page: page || '', id: rawId ? decodeURIComponent(rawId) : '', query };
  }
  const isEditing = (page) => page === 'edit' || page === 'new' || page === 'write';

  function route() {
    $lightbox.hidden = true;
    const { page, id, query } = parseHash();
    if (!isEditing(page)) state.draft = null;
    document.title = db().siteTitle;

    if (page === 'oc' && id) renderDetail(id);
    else if (page === 'edit' && id) renderCharEditor(id, query);
    else if (page === 'new' && !query.tpl) { state.draft = null; renderTemplatePicker(query.kind === 'doc' ? 'doc' : 'oc'); }
    else if (page === 'new') renderCharEditor('', query);
    else if (page === 'posts') renderPosts();
    else if (page === 'post' && id) renderPost(id);
    else if (page === 'write') renderPostEditor(id, query);
    else if (page === 'me' || page === 'backup') renderMe();
    else if (page === 'docs') renderCharacters('doc');
    else renderCharacters('oc');
    if (!isEditing(page)) window.scrollTo(0, 0);
  }

  // 다른 탭에 있다가 돌아오면 친구가 올린 새 내용을 불러와요
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || Date.now() - state.loadedAt < 60000 || state.busy) return;
    if (isEditing(parseHash().page)) return;
    const y = window.scrollY;
    try { await loadDb(); route(); window.scrollTo(0, y); } catch (e) { /* 다음에 다시 */ }
  });

  // 편집 도구모음이 상단 바 바로 아래에 붙도록 상단 바 높이를 알려 줘요
  const setTopbarHeight = () => document.documentElement.style.setProperty('--topbar-h', document.querySelector('.topbar').offsetHeight + 'px');
  window.addEventListener('resize', setTopbarHeight);
  setTopbarHeight();

  (async function init() {
    await restoreSession();
    if (!state.accounts) {
      try { state.accounts = await fetchAccounts(); } catch (e) { /* 로그인 화면에서 다시 시도 */ }
    }
    try {
      await loadDb();
    } catch (err) {
      $app.innerHTML = `<div class="empty">데이터를 불러오지 못했어요.<br><span class="muted">${esc(err.message)}</span><br><button class="btn" onclick="location.reload()">다시 시도</button></div>`;
      return;
    }
    await loadLegacy();
    window.addEventListener('hashchange', route);
    route();
  })();
})();
