(function () {
  'use strict';

  const CFG = Object.assign({ owner: 'ju3236', repo: 'OC_backup', branch: 'main' }, window.OC_CONFIG || {});
  const API = 'https://api.github.com';
  const REPO = `/repos/${CFG.owner}/${CFG.repo}`;
  const RAW = `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/`;
  const DB_PATH = 'data/db.json';
  const TOKEN_KEY = 'oc-backup-token';
  const MAX_IMAGE_SIDE = 1600;

  const $app = document.getElementById('app');
  const $banner = document.getElementById('banner');
  const $lightbox = document.getElementById('lightbox');

  const state = {
    db: null,
    loadedAt: 0,
    token: '',
    user: null,         // { login, avatar }
    filter: { q: '', world: '', tag: '', owner: '' },
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
  const isMine = (owner) => !!state.user && (!owner || owner === state.user.login);
  const encId = encodeURIComponent;

  function thumbHtml(c) {
    const src = coverOf(c);
    return src
      ? `<img src="${esc(imgUrl(src))}" alt="${esc(c.name)}" loading="lazy">`
      : `<span class="initial">${initialOf(c)}</span>`;
  }
  function avatarHtml(login, cls) {
    if (!login) return '';
    return `<img class="avatar ${cls || ''}" src="https://github.com/${encId(login)}.png?size=64" alt="" loading="lazy">`;
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
      profile: arr(c.profile).map((p) => ({ label: str(p.label), value: str(p.value) })),
      sections: arr(c.sections).map((s) => ({ title: str(s.title), body: str(s.body) })),
      images: normImages(c.images),
      relations: arr(c.relations).map((r) => ({ id: str(r.id), name: str(r.name), type: str(r.type), note: str(r.note) })),
      createdAt: c.createdAt || now,
      updatedAt: c.updatedAt || now,
    };
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

  async function readDbAt(ref) {
    let meta;
    try {
      meta = await gh('GET', `${REPO}/contents/${DB_PATH}?ref=${encId(ref)}`);
    } catch (err) {
      if (err.status === 404) return normalizeDb({});
      throw err;
    }
    if (meta.content && meta.encoding === 'base64') return normalizeDb(JSON.parse(b64ToUtf8(meta.content)));
    const blob = await gh('GET', `${REPO}/git/blobs/${meta.sha}`); // 1MB가 넘으면 contents API가 내용을 비워서 줌
    return normalizeDb(JSON.parse(b64ToUtf8(blob.content)));
  }

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
  async function save(message, mutate, files) {
    if (!state.user) throw new Error('로그인이 필요해요');
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
        const next = await readDbAt(head);
        mutate(next);
        const dbBlob = await gh('POST', `${REPO}/git/blobs`, { content: JSON.stringify(next, null, 1) + '\n', encoding: 'utf-8' });
        const tree = await gh('POST', `${REPO}/git/trees`, {
          base_tree: commit.tree.sha,
          tree: [{ path: DB_PATH, mode: '100644', type: 'blob', sha: dbBlob.sha }, ...blobs],
        });
        const created = await gh('POST', `${REPO}/git/commits`, {
          message: `${message} (by ${state.user.login})`,
          tree: tree.sha,
          parents: [head],
        });
        try {
          await gh('PATCH', `${REPO}/git/refs/heads/${encId(CFG.branch)}`, { sha: created.sha, force: false });
        } catch (err) {
          if (err.status === 422 || err.status === 409) continue;
          throw err;
        }
        state.db = next;
        state.loadedAt = Date.now();
        return next;
      }
      throw new Error('친구와 동시에 저장하느라 실패했어요. 다시 시도해 주세요.');
    } finally {
      state.busy = false;
      t.remove();
    }
  }

  async function trySave(message, mutate, files) {
    try {
      await save(message, mutate, files);
      return true;
    } catch (err) {
      alert('저장하지 못했어요.\n' + err.message + (err.status === 401 ? '\n\n토큰이 만료됐을 수 있어요. [내 정보]에서 다시 로그인해 주세요.' : ''));
      return false;
    }
  }

  async function login(token) {
    state.token = token;
    try {
      const u = await gh('GET', '/user');
      const r = await gh('GET', REPO);
      if (!r.permissions || !r.permissions.push) {
        const err = new Error(`'${u.login}' 계정은 이 저장소에 쓰기 권한이 없어요. 저장소 주인(${CFG.owner})에게 Collaborator 초대를 받고 수락해 주세요.`);
        err.status = 403;
        throw err;
      }
      state.user = { login: u.login, avatar: u.avatar_url };
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* ignore */ }
    } catch (err) {
      state.token = '';
      state.user = null;
      throw err;
    }
  }
  function logout() {
    state.token = '';
    state.user = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
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
  function renderCharacters() {
    renderChrome('oc');
    const all = db().characters;
    const f = state.filter;
    const owners = [...new Set(all.map((c) => c.owner).filter(Boolean))].sort();
    const worlds = [...new Set(all.map((c) => c.world).filter(Boolean))].sort();
    const tags = [...new Set(all.flatMap((c) => c.tags))].sort();
    if (f.world && !worlds.includes(f.world)) f.world = '';
    if (f.tag && !tags.includes(f.tag)) f.tag = '';
    if (f.owner && !owners.includes(f.owner)) f.owner = '';

    $app.innerHTML = `
      <div class="page-head">
        <h1>캐릭터</h1>
        ${state.user ? '<a href="#/new" class="btn btn-primary">+ 새 캐릭터</a>' : ''}
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
        return [c.name, c.subname, c.summary, c.world, ...c.tags].join(' ').toLowerCase().includes(q);
      }).sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
      if (!all.length) {
        $results.innerHTML = `<div class="empty">아직 등록된 캐릭터가 없어요.${state.user ? '<br><a class="btn btn-primary" href="#/new">+ 첫 캐릭터 만들기</a>' : ''}</div>`;
        return;
      }
      if (!list.length) {
        $results.innerHTML = '<div class="empty">조건에 맞는 캐릭터가 없어요.</div>';
        return;
      }
      $results.innerHTML = `<div class="count">${list.length}명</div><div class="grid">${list.map((c) => `
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

  // ---------- character detail ----------
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
    renderChrome('oc');
    const c = findChar(id);
    if (!c) return renderNotFound();
    const color = safeColor(c.color);
    const cover = coverOf(c);
    document.title = `${c.name} · ${db().siteTitle}`;
    const related = db().posts.filter((p) => p.chars.includes(c.id)).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

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

    $app.innerHTML = `
      <article style="--oc:${color}">
        <a class="back" href="#/">← 캐릭터 목록</a>
        <div class="hero">
          <div class="hero-img ${cover ? '' : 'no-img'}" ${cover ? `data-zoom="${esc(imgUrl(cover))}" data-caption="${esc(c.name)}"` : ''}>${thumbHtml(c)}</div>
          <div>
            ${c.world ? `<span class="world">${esc(c.world)}</span>` : ''}
            <h1>${esc(c.name)}</h1>
            ${c.subname ? `<div class="sub">${esc(c.subname)}</div>` : ''}
            ${c.owner ? `<div class="owner-line">${byline(c.owner)}의 자캐</div>` : ''}
            ${c.summary ? `<p class="summary">${esc(c.summary)}</p>` : ''}
            ${c.tags.length ? `<div class="tags">${c.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
            <div class="actions">
              ${isMine(c.owner) ? `<a class="btn btn-primary" href="#/edit/${encId(c.id)}">편집</a>` : ''}
              ${state.user ? `<a class="btn" href="#/write?oc=${encId(c.id)}">이 캐릭터로 글쓰기</a>` : ''}
              ${isMine(c.owner) ? '<button type="button" class="btn btn-danger" id="delete">삭제</button>' : ''}
            </div>
            ${c.profile.length ? `<table class="profile-table"><tbody>
              ${c.profile.map((p) => `<tr><th>${esc(p.label)}</th><td>${esc(p.value)}</td></tr>`).join('')}
            </tbody></table>` : ''}
          </div>
        </div>

        ${c.sections.map((s) => `
          <section class="section">
            ${s.title ? `<h2>${esc(s.title)}</h2>` : ''}
            <div class="body">${esc(s.body)}</div>
          </section>`).join('')}

        ${c.relations.length ? `<section class="section"><h2>관계</h2><div class="relations">${relHtml}</div></section>` : ''}

        ${c.images.length ? `<section class="section"><h2>갤러리 <span class="muted">${c.images.length}</span></h2>${galleryHtml(c.images, c.name)}</section>` : ''}

        ${related.length ? `<section class="section"><h2>관련 게시물 <span class="muted">${related.length}</span></h2>
          <div class="post-list compact">${related.map(postCardHtml).join('')}</div></section>` : ''}

        ${commentsHtml('oc:' + c.id)}

        <div class="meta">등록 ${esc(fmtDate(c.createdAt))} · 수정 ${esc(fmtDate(c.updatedAt))}</div>
      </article>`;

    const $del = document.getElementById('delete');
    if ($del) $del.addEventListener('click', async () => {
      if (!confirm(`'${c.name}'을(를) 삭제할까요?\n(GitHub 기록에는 남아 있어서 저장소 주인이 되살릴 수 있어요.)`)) return;
      const ok = await trySave(`캐릭터 삭제: ${c.name}`, (d) => {
        d.characters = d.characters.filter((x) => x.id !== c.id);
        d.comments = d.comments.filter((x) => x.target !== 'oc:' + c.id);
      });
      if (ok) { toast('삭제했어요'); location.hash = '#/'; }
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

  // ---------- character editor ----------
  function renderCharEditor(id) {
    renderChrome('oc');
    if (!state.user) return requireLogin();
    const key = 'oc:' + (id || 'new');
    if (!state.draft || state.draft._for !== key) {
      const base = id ? findChar(id) : null;
      if (id && (!base || !isMine(base.owner))) return renderNotFound();
      const d = JSON.parse(JSON.stringify(base || normalizeChar({
        id: uid('oc'),
        name: '',
        profile: [{ label: '나이', value: '' }, { label: '성별', value: '' }, { label: '키', value: '' }, { label: '생일', value: '' }],
        sections: [{ title: '성격', body: '' }, { title: '배경', body: '' }],
      })));
      if (!base) d.name = '';
      d.tagsText = d.tags.join(', ');
      d._for = key;
      d._files = {};
      state.draft = d;
      window.scrollTo(0, 0);
    }
    drawCharEditor(id);
  }

  function drawCharEditor(id) {
    const d = state.draft;
    const others = db().characters.filter((c) => c.id !== d.id);
    const scrollY = window.scrollY;
    const cancel = id ? '#/oc/' + encId(id) : '#/';

    $app.innerHTML = `
      <form class="editor" id="editor" autocomplete="off" style="--accent:${safeColor(d.color)}">
        <a class="back" href="${cancel}">← 취소</a>
        <h1>${id ? '캐릭터 편집' : '새 캐릭터'}</h1>

        <div class="fieldset">
          <div class="fieldset-title">기본 정보</div>
          <div class="row2">
            <div class="field"><label for="f-name">이름 *</label>
              <input type="text" id="f-name" data-path="name" value="${esc(d.name)}" required></div>
            <div class="field"><label for="f-sub">부제 / 영문명</label>
              <input type="text" id="f-sub" data-path="subname" value="${esc(d.subname)}"></div>
          </div>
          <div class="row2">
            <div class="field"><label for="f-world">세계관 / 작품</label>
              <input type="text" id="f-world" data-path="world" value="${esc(d.world)}" list="world-list">
              <datalist id="world-list">${[...new Set(db().characters.map((c) => c.world).filter(Boolean))].map((w) => `<option value="${esc(w)}">`).join('')}</datalist></div>
            <div class="field"><label for="f-color">테마 색</label>
              <input type="color" id="f-color" data-path="color" value="${esc(safeColor(d.color))}"></div>
          </div>
          <div class="field"><label for="f-summary">한 줄 소개</label>
            <input type="text" id="f-summary" data-path="summary" value="${esc(d.summary)}"></div>
          <div class="field"><label for="f-tags">태그</label>
            <input type="text" id="f-tags" data-path="tagsText" value="${esc(d.tagsText)}" placeholder="쉼표로 구분 (예: 인간, 마법사, 주인공)"></div>
        </div>

        <div class="fieldset">
          <div class="fieldset-title">그림</div>
          ${imagesFieldHtml(d, true)}
        </div>

        <div class="fieldset">
          <div class="fieldset-title">프로필</div>
          <div class="rows">
            ${d.profile.map((p, i) => `
              <div class="kv-row">
                <input type="text" data-path="profile.${i}.label" value="${esc(p.label)}" placeholder="항목 (예: 나이)">
                <input type="text" data-path="profile.${i}.value" value="${esc(p.value)}" placeholder="내용">
                <button type="button" class="btn btn-icon btn-danger" data-act="del" data-list="profile" data-i="${i}" aria-label="삭제">×</button>
              </div>`).join('')}
          </div>
          <button type="button" class="btn btn-sm" data-act="add" data-list="profile">+ 항목 추가</button>
          <div class="hint">내용을 비워 둔 항목은 저장할 때 빠져요.</div>
        </div>

        <div class="fieldset">
          <div class="fieldset-title">설정 / 서술</div>
          <div class="rows">
            ${d.sections.map((s, i) => `
              <div class="sec-row">
                <div class="head">
                  <input type="text" data-path="sections.${i}.title" value="${esc(s.title)}" placeholder="제목 (예: 성격, 배경, 능력)">
                  <button type="button" class="btn btn-icon" data-act="up" data-list="sections" data-i="${i}" aria-label="위로">↑</button>
                  <button type="button" class="btn btn-icon" data-act="down" data-list="sections" data-i="${i}" aria-label="아래로">↓</button>
                  <button type="button" class="btn btn-icon btn-danger" data-act="del" data-list="sections" data-i="${i}" aria-label="삭제">×</button>
                </div>
                <textarea data-path="sections.${i}.body" rows="5" placeholder="내용">${esc(s.body)}</textarea>
              </div>`).join('')}
          </div>
          <button type="button" class="btn btn-sm" data-act="add" data-list="sections">+ 항목 추가</button>
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
          <div class="hint">친구 자캐도 이름을 넣으면 그 캐릭터 페이지로 연결돼요.</div>
        </div>

        <div class="form-actions">
          <a class="btn" href="${cancel}">취소</a>
          <button type="submit" class="btn btn-primary">저장</button>
        </div>
      </form>`;

    window.scrollTo(0, scrollY);
    const $form = document.getElementById('editor');
    bindEditor($form, d, () => drawCharEditor(id), (list) => (list === 'profile' ? { label: '', value: '' }
      : list === 'sections' ? { title: '', body: '' }
      : { id: '', name: '', type: '', note: '' }));

    $form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = d.name.trim();
      if (!name) return toast('이름을 입력해 주세요');
      const c = normalizeChar({
        ...d,
        name,
        owner: d.owner || state.user.login,
        tags: [...new Set(d.tagsText.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))],
        profile: d.profile.filter((p) => p.value.trim()),
        sections: d.sections.filter((s) => s.body.trim()),
        relations: d.relations.filter((r) => r.name.trim()).map((r) => {
          const t = db().characters.find((x) => x.name === r.name.trim() && x.id !== d.id);
          return { ...r, name: r.name.trim(), id: t ? t.id : '' };
        }),
        updatedAt: new Date().toISOString(),
      });
      if (!c.images.some((img) => img.src === c.avatar)) c.avatar = '';
      $form.querySelector('[type=submit]').disabled = true;
      const ok = await trySave(`${id ? '캐릭터 수정' : '캐릭터 추가'}: ${c.name}`, (next) => {
        const idx = next.characters.findIndex((x) => x.id === c.id);
        if (idx >= 0) next.characters[idx] = { ...c, createdAt: next.characters[idx].createdAt };
        else next.characters.push(c);
      }, pendingFiles(d));
      if (ok) {
        state.draft = null;
        toast('저장했어요');
        location.hash = '#/oc/' + encId(c.id);
      } else {
        $form.querySelector('[type=submit]').disabled = false;
      }
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
    const tokenUrl = 'https://github.com/settings/tokens/new?scopes=public_repo&description=' + encId('자캐 백업 사이트');
    const myChars = state.user ? db().characters.filter((c) => c.owner === state.user.login).length : 0;
    const myPosts = state.user ? db().posts.filter((p) => p.author === state.user.login).length : 0;

    $app.innerHTML = `
      <div class="page-head"><h1>${state.user ? '내 정보' : '로그인'}</h1></div>
      <div class="backup-grid">
        ${state.user ? `
        <div class="fieldset">
          <div class="fieldset-title">계정</div>
          <div class="me-row">${avatarHtml(state.user.login, 'avatar-xl')}
            <div><strong>${esc(memberName(state.user.login))}</strong><br><span class="muted">@${esc(state.user.login)} · 캐릭터 ${myChars} · 게시물 ${myPosts}</span></div></div>
          <div class="field" style="margin-top:14px"><label for="nick">사이트에서 보일 닉네임</label>
            <input type="text" id="nick" value="${esc((db().members[state.user.login] || {}).name || '')}" placeholder="${esc(state.user.login)}"></div>
          <div class="btns">
            <button type="button" class="btn" id="save-nick">닉네임 저장</button>
            <button type="button" class="btn btn-danger" id="logout">로그아웃</button>
          </div>
        </div>` : `
        <div class="fieldset login-card">
          <div class="fieldset-title">GitHub 토큰으로 로그인</div>
          <ol class="steps">
            <li>저장소 주인(<b>${esc(CFG.owner)}</b>)에게 Collaborator 초대를 받고, 메일이나 GitHub 알림에서 <b>수락</b>해요. (주인은 생략)</li>
            <li><a href="${tokenUrl}" target="_blank" rel="noopener">여기를 눌러 토큰 만들기</a> → <b>Expiration</b>을 넉넉하게(예: 1년 또는 No expiration) 고르고, 맨 아래 <b>Generate token</b>.</li>
            <li><code>ghp_</code>로 시작하는 토큰을 복사해서 아래에 붙여넣어요.</li>
          </ol>
          <form id="login-form">
            <input type="password" id="token" placeholder="ghp_..." autocomplete="off" required>
            <div class="btns" style="margin-top:10px"><button type="submit" class="btn btn-primary">로그인</button></div>
          </form>
          <p class="hint">토큰은 이 기기 브라우저에만 저장돼요. 여러 사람이 쓰는 기기라면 다 쓴 뒤 로그아웃해 주세요. 기기마다 한 번씩 로그인하면 돼요.</p>
        </div>`}

        ${state.user && state.legacy && state.legacy.length ? `
        <div class="fieldset highlight">
          <div class="fieldset-title">예전 데이터 옮기기</div>
          <p>이 브라우저에 예전 방식으로 저장된 캐릭터 ${state.legacy.length}명(${esc(state.legacy.map((c) => c.name).join(', '))})이 있어요. 공유 저장소에 내 캐릭터로 올릴까요?</p>
          <div class="btns"><button type="button" class="btn btn-primary" id="migrate">공유 저장소로 옮기기</button>
            <button type="button" class="btn" id="drop-legacy">옮기지 않고 지우기</button></div>
        </div>` : ''}

        <div class="fieldset">
          <div class="fieldset-title">백업 받기</div>
          <p>모든 데이터는 GitHub 저장소에 저장되고 고친 기록도 다 남아요. 따로 보관하고 싶으면:</p>
          <div class="btns">
            <button type="button" class="btn" id="export-json">글·설정만 (.json)</button>
            <a class="btn" href="https://github.com/${encId(CFG.owner)}/${encId(CFG.repo)}/archive/refs/heads/${encId(CFG.branch)}.zip">그림까지 전부 (.zip)</a>
          </div>
        </div>

        ${state.user ? `
        <div class="fieldset">
          <div class="fieldset-title">파일에서 캐릭터 불러오기</div>
          <p>예전에 이 사이트에서 내보낸 .json 백업 파일의 캐릭터를 내 캐릭터로 추가해요.</p>
          <div class="btns"><label class="btn">파일 고르기<input type="file" id="import" accept=".json,application/json" hidden></label></div>
        </div>
        <div class="fieldset">
          <div class="fieldset-title">사이트 제목</div>
          <div class="field"><input type="text" id="site-title-input" value="${esc(db().siteTitle)}"></div>
          <div class="btns"><button type="button" class="btn" id="save-title">제목 저장</button></div>
        </div>` : ''}
      </div>`;

    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };

    on('login-form', 'submit', async (e) => {
      e.preventDefault();
      const token = document.getElementById('token').value.trim();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        await login(token);
        await loadDb();
        toast(`${state.user.login}님 환영해요`);
        renderMe();
      } catch (err) {
        alert(err.status === 401 ? '토큰이 올바르지 않아요. 다시 복사해 주세요.' : err.message);
        btn.disabled = false;
      }
    });
    on('logout', 'click', async () => {
      if (!confirm('로그아웃할까요?')) return;
      logout();
      await loadDb().catch(() => {});
      renderMe();
    });
    on('save-nick', 'click', async () => {
      const name = document.getElementById('nick').value.trim();
      const me = state.user.login;
      if (await trySave('닉네임 변경', (d) => { d.members[me] = { name }; })) { toast('저장했어요'); renderMe(); }
    });
    on('save-title', 'click', async () => {
      const t = document.getElementById('site-title-input').value.trim() || '자캐 백업';
      if (await trySave('사이트 제목 변경', (d) => { d.siteTitle = t; })) { toast('저장했어요'); renderMe(); }
    });
    on('export-json', 'click', () => {
      download(`oc-backup-${today()}.json`, JSON.stringify({ ...db(), exportedAt: new Date().toISOString() }, null, 2));
    });
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
    else if (page === 'edit' && id) renderCharEditor(id);
    else if (page === 'new') renderCharEditor('');
    else if (page === 'posts') renderPosts();
    else if (page === 'post' && id) renderPost(id);
    else if (page === 'write') renderPostEditor(id, query);
    else if (page === 'me' || page === 'backup') renderMe();
    else renderCharacters();
    if (!isEditing(page)) window.scrollTo(0, 0);
  }

  // 다른 탭에 있다가 돌아오면 친구가 올린 새 내용을 불러와요
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || Date.now() - state.loadedAt < 60000 || state.busy) return;
    if (isEditing(parseHash().page)) return;
    const y = window.scrollY;
    try { await loadDb(); route(); window.scrollTo(0, y); } catch (e) { /* 다음에 다시 */ }
  });

  (async function init() {
    let token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* ignore */ }
    if (token) {
      try {
        await login(token);
      } catch (err) {
        if (err.status === 401 || err.status === 403) logout();
      }
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
