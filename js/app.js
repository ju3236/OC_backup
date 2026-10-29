(function () {
  'use strict';

  const DB_NAME = 'oc-backup';
  const STORE = 'kv';
  const KEY = 'data';
  const MAX_IMAGE_SIDE = 1600;

  const $app = document.getElementById('app');
  const $banner = document.getElementById('banner');
  const $lightbox = document.getElementById('lightbox');

  const state = {
    data: null,          // { version, siteTitle, characters: [] }
    source: 'repo',      // 'repo' = data/characters.js, 'local' = 이 브라우저(IndexedDB)
    filter: { q: '', world: '', tag: '' },
    draft: null,
  };

  // ---------- storage (IndexedDB) ----------
  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB 미지원'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function idb(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const loadLocal = () => idb('readonly', (s) => s.get(KEY)).catch(() => null);
  const clearLocal = () => idb('readwrite', (s) => s.delete(KEY));

  async function persist() {
    state.data.savedAt = new Date().toISOString();
    try {
      await idb('readwrite', (s) => s.put(state.data, KEY));
      state.source = 'local';
      renderBanner();
      return true;
    } catch (err) {
      alert('브라우저 저장에 실패했어요. 저장 공간이 부족할 수 있습니다.\n먼저 [백업 / 복원]에서 백업 파일을 내보내 주세요.\n\n' + err);
      return false;
    }
  }

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function safeSrc(src) {
    src = String(src || '').trim();
    if (!src) return '';
    if (/^(https?:|data:image\/|blob:)/i.test(src)) return src;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return ''; // javascript: 등 차단
    return src; // images/xxx.png 같은 상대 경로
  }
  function safeColor(c) {
    return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#5b7fd6';
  }
  const uid = () => 'oc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const chars = () => state.data.characters;
  const findChar = (id) => chars().find((c) => c.id === id);
  const coverOf = (c) => safeSrc(c.avatar) || safeSrc((c.images || [])[0] && c.images[0].src);
  const initialOf = (c) => esc((c.name || '?').trim().charAt(0) || '?');

  function thumbHtml(c) {
    const src = coverOf(c);
    return src
      ? `<img src="${esc(src)}" alt="${esc(c.name)}" loading="lazy">`
      : `<span class="initial">${initialOf(c)}</span>`;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
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

  function normalizeChar(c) {
    return {
      id: String(c.id || uid()),
      name: String(c.name || '이름 없음'),
      subname: String(c.subname || ''),
      world: String(c.world || ''),
      summary: String(c.summary || ''),
      color: safeColor(c.color),
      avatar: String(c.avatar || ''),
      tags: Array.isArray(c.tags) ? c.tags.map(String).filter(Boolean) : [],
      profile: Array.isArray(c.profile) ? c.profile.map((p) => ({ label: String(p.label || ''), value: String(p.value || '') })) : [],
      sections: Array.isArray(c.sections) ? c.sections.map((s) => ({ title: String(s.title || ''), body: String(s.body || '') })) : [],
      images: Array.isArray(c.images) ? c.images.filter((i) => i && i.src).map((i) => ({ src: String(i.src), caption: String(i.caption || '') })) : [],
      relations: Array.isArray(c.relations) ? c.relations.map((r) => ({ id: String(r.id || ''), name: String(r.name || ''), type: String(r.type || ''), note: String(r.note || '') })) : [],
      createdAt: c.createdAt || new Date().toISOString(),
      updatedAt: c.updatedAt || new Date().toISOString(),
    };
  }
  function normalizeData(d) {
    d = d || {};
    return {
      version: 1,
      siteTitle: String(d.siteTitle || '자캐 백업'),
      characters: (Array.isArray(d.characters) ? d.characters : []).map(normalizeChar),
    };
  }

  // ---------- banner / chrome ----------
  function renderBanner() {
    document.title = state.data.siteTitle;
    document.getElementById('site-title').textContent = state.data.siteTitle;
    if (state.source === 'local') {
      $banner.hidden = false;
      $banner.innerHTML = `<span>💾 이 브라우저에 저장된 편집본을 보고 있어요. 브라우저 데이터가 지워지면 사라지니 백업 파일을 꼭 내보내 두세요.</span>
        <a class="btn btn-sm" href="#/backup">백업하기</a>`;
    } else {
      $banner.hidden = true;
    }
  }

  // ---------- list ----------
  function renderList() {
    const all = chars();
    const worlds = [...new Set(all.map((c) => c.world).filter(Boolean))].sort();
    const tags = [...new Set(all.flatMap((c) => c.tags))].sort();
    const f = state.filter;
    if (f.world && !worlds.includes(f.world)) f.world = '';
    if (f.tag && !tags.includes(f.tag)) f.tag = '';

    $app.innerHTML = `
      <div class="toolbar">
        <input type="search" id="q" placeholder="이름, 태그, 설명으로 검색" value="${esc(f.q)}">
        ${worlds.length ? `<select id="world">
          <option value="">모든 세계관</option>
          ${worlds.map((w) => `<option value="${esc(w)}" ${w === f.world ? 'selected' : ''}>${esc(w)}</option>`).join('')}
        </select>` : ''}
      </div>
      ${tags.length ? `<div class="chips">
        <button type="button" class="chip ${f.tag ? '' : 'active'}" data-tag="">전체</button>
        ${tags.map((t) => `<button type="button" class="chip ${t === f.tag ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}
      </div>` : ''}
      <div id="results"></div>`;

    const $results = document.getElementById('results');
    const draw = () => {
      const q = f.q.trim().toLowerCase();
      const list = all.filter((c) => {
        if (f.world && c.world !== f.world) return false;
        if (f.tag && !c.tags.includes(f.tag)) return false;
        if (!q) return true;
        return [c.name, c.subname, c.summary, c.world, ...c.tags].join(' ').toLowerCase().includes(q);
      });
      if (!all.length) {
        $results.innerHTML = `<div class="empty">아직 등록된 캐릭터가 없어요.<br><a class="btn btn-primary" href="#/new">+ 첫 캐릭터 만들기</a></div>`;
        return;
      }
      if (!list.length) {
        $results.innerHTML = `<div class="empty">조건에 맞는 캐릭터가 없어요.</div>`;
        return;
      }
      $results.innerHTML = `<div class="count">${list.length}명</div><div class="grid">${list.map((c) => `
        <a class="card" href="#/oc/${encodeURIComponent(c.id)}" style="--oc:${safeColor(c.color)}">
          <div class="card-thumb">${thumbHtml(c)}</div>
          <div class="card-body">
            <div class="card-name">${esc(c.name)}</div>
            ${c.subname || c.world ? `<div class="card-sub">${esc([c.subname, c.world].filter(Boolean).join(' · '))}</div>` : ''}
            ${c.summary ? `<div class="card-summary">${esc(c.summary)}</div>` : ''}
          </div>
        </a>`).join('')}</div>`;
    };
    draw();

    document.getElementById('q').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
    const $world = document.getElementById('world');
    if ($world) $world.addEventListener('change', (e) => { f.world = e.target.value; draw(); });
    $app.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
      f.tag = b.dataset.tag;
      $app.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === b));
      draw();
    }));
  }

  // ---------- detail ----------
  function renderDetail(id) {
    const c = findChar(id);
    if (!c) return renderNotFound();
    const color = safeColor(c.color);
    const cover = coverOf(c);
    document.title = `${c.name} · ${state.data.siteTitle}`;

    const relHtml = c.relations.map((r) => {
      const t = (r.id && findChar(r.id)) || chars().find((x) => x.name === r.name);
      const name = t ? t.name : r.name;
      const inner = `
        <span class="mini" style="--oc:${t ? safeColor(t.color) : 'var(--muted)'}">${t ? thumbHtml(t) : esc((name || '?').charAt(0))}</span>
        <span><strong>${esc(name)}</strong>${r.type ? ` <span class="rtype">· ${esc(r.type)}</span>` : ''}
        ${r.note ? `<br><span class="rtype">${esc(r.note)}</span>` : ''}</span>`;
      return t
        ? `<a class="relation" href="#/oc/${encodeURIComponent(t.id)}" style="text-decoration:none">${inner}</a>`
        : `<div class="relation">${inner}</div>`;
    }).join('');

    $app.innerHTML = `
      <article style="--oc:${color}">
        <a class="back" href="#/">← 목록으로</a>
        <div class="hero">
          <div class="hero-img ${cover ? '' : 'no-img'}" ${cover ? `data-zoom="${esc(cover)}" data-caption="${esc(c.name)}"` : ''}>${thumbHtml(c)}</div>
          <div>
            ${c.world ? `<span class="world">${esc(c.world)}</span>` : ''}
            <h1>${esc(c.name)}</h1>
            ${c.subname ? `<div class="sub">${esc(c.subname)}</div>` : ''}
            ${c.summary ? `<p class="summary">${esc(c.summary)}</p>` : ''}
            ${c.tags.length ? `<div class="tags">${c.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
            <div class="actions">
              <a class="btn btn-primary" href="#/edit/${encodeURIComponent(c.id)}">편집</a>
              <button type="button" class="btn" id="export-one">이 캐릭터만 내보내기</button>
              <button type="button" class="btn btn-danger" id="delete">삭제</button>
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

        ${c.images.length ? `<section class="section"><h2>갤러리</h2><div class="gallery">
          ${c.images.map((img) => `<figure data-zoom="${esc(safeSrc(img.src))}" data-caption="${esc(img.caption)}">
            <img src="${esc(safeSrc(img.src))}" alt="${esc(img.caption || c.name)}" loading="lazy">
            ${img.caption ? `<figcaption>${esc(img.caption)}</figcaption>` : ''}
          </figure>`).join('')}
        </div></section>` : ''}

        <div class="meta">등록 ${esc(fmtDate(c.createdAt))} · 수정 ${esc(fmtDate(c.updatedAt))}</div>
      </article>`;

    document.getElementById('delete').addEventListener('click', async () => {
      if (!confirm(`'${c.name}'을(를) 삭제할까요? 되돌릴 수 없어요.`)) return;
      state.data.characters = chars().filter((x) => x.id !== c.id);
      if (await persist()) { toast('삭제했어요'); location.hash = '#/'; }
    });
    document.getElementById('export-one').addEventListener('click', () => {
      download(`oc-${c.name}-${today()}.json`, JSON.stringify({ version: 1, characters: [c] }, null, 2));
    });
  }

  function renderNotFound() {
    $app.innerHTML = `<div class="empty">캐릭터를 찾을 수 없어요.<br><a class="btn" href="#/">목록으로</a></div>`;
  }

  // ---------- editor ----------
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    o[keys[keys.length - 1]] = value;
  }

  function renderEditor(id) {
    if (!state.draft || state.draft._for !== (id || 'new')) {
      const base = id ? findChar(id) : null;
      if (id && !base) return renderNotFound();
      const d = JSON.parse(JSON.stringify(base || normalizeChar({
        id: uid(),
        name: '',
        profile: [
          { label: '나이', value: '' }, { label: '성별', value: '' },
          { label: '키', value: '' }, { label: '생일', value: '' },
        ],
        sections: [{ title: '성격', body: '' }, { title: '배경', body: '' }],
      })));
      if (!base) d.name = '';
      d.tagsText = d.tags.join(', ');
      d._for = id || 'new';
      state.draft = d;
      window.scrollTo(0, 0);
    }
    drawEditor(id);
  }

  function drawEditor(id) {
    const d = state.draft;
    const others = chars().filter((c) => c.id !== d.id);
    const scrollY = window.scrollY;

    $app.innerHTML = `
      <form class="editor" id="editor" autocomplete="off" style="--accent:${safeColor(d.color)}">
        <a class="back" href="${id ? '#/oc/' + encodeURIComponent(id) : '#/'}">← 취소</a>
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
              <datalist id="world-list">${[...new Set(chars().map((c) => c.world).filter(Boolean))].map((w) => `<option value="${esc(w)}">`).join('')}</datalist></div>
            <div class="field"><label for="f-color">테마 색</label>
              <input type="color" id="f-color" data-path="color" value="${esc(safeColor(d.color))}"></div>
          </div>
          <div class="field"><label for="f-summary">한 줄 소개</label>
            <input type="text" id="f-summary" data-path="summary" value="${esc(d.summary)}"></div>
          <div class="field"><label for="f-tags">태그</label>
            <input type="text" id="f-tags" data-path="tagsText" value="${esc(d.tagsText)}" placeholder="쉼표로 구분 (예: 인간, 마법사, 주인공)"></div>
        </div>

        <div class="fieldset">
          <div class="fieldset-title">이미지</div>
          <div class="img-edit-list">
            ${d.images.map((img, i) => `
              <div class="img-edit ${d.avatar && d.avatar === img.src ? 'is-avatar' : ''}">
                <img src="${esc(safeSrc(img.src))}" alt="">
                <input type="text" data-path="images.${i}.caption" value="${esc(img.caption)}" placeholder="설명">
                <div class="btns">
                  <button type="button" class="btn" data-act="avatar" data-i="${i}">${d.avatar === img.src ? '★ 대표' : '대표로'}</button>
                  <button type="button" class="btn" data-act="up" data-list="images" data-i="${i}" title="앞으로">←</button>
                  <button type="button" class="btn btn-danger" data-act="del" data-list="images" data-i="${i}">삭제</button>
                </div>
              </div>`).join('')}
          </div>
          <div class="img-add">
            <label class="btn">📷 파일 업로드<input type="file" id="img-file" accept="image/*" multiple hidden></label>
            <input type="url" id="img-url" placeholder="또는 이미지 주소 / images/파일명.png">
            <button type="button" class="btn" data-act="add-url">추가</button>
          </div>
          <div class="hint">첫 번째 이미지(또는 ★ 대표)가 썸네일이 돼요. 업로드한 파일은 최대 ${MAX_IMAGE_SIDE}px로 줄여서 저장돼요(GIF는 원본 유지).</div>
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
          <div class="hint">등록된 캐릭터 이름을 입력하면 상세 페이지에서 그 캐릭터로 링크돼요.</div>
        </div>

        <div class="form-actions">
          <a class="btn" href="${id ? '#/oc/' + encodeURIComponent(id) : '#/'}">취소</a>
          <button type="submit" class="btn btn-primary">저장</button>
        </div>
      </form>`;

    window.scrollTo(0, scrollY);
    const $form = document.getElementById('editor');

    $form.addEventListener('input', (e) => {
      const p = e.target.dataset && e.target.dataset.path;
      if (!p) return;
      setPath(d, p, e.target.value);
      if (p.startsWith('relations.') && p.endsWith('.name')) setPath(d, p.replace(/name$/, 'id'), '');
      if (p === 'color') $form.style.setProperty('--accent', safeColor(e.target.value));
    });

    $form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const list = b.dataset.list;
      const i = Number(b.dataset.i);
      if (act === 'add') {
        d[list].push(list === 'profile' ? { label: '', value: '' }
          : list === 'sections' ? { title: '', body: '' }
          : { id: '', name: '', type: '', note: '' });
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
        const $u = document.getElementById('img-url');
        const src = safeSrc($u.value);
        if (!src) return toast('이미지 주소를 확인해 주세요');
        d.images.push({ src, caption: '' });
      } else {
        return;
      }
      drawEditor(id);
    });

    document.getElementById('img-file').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      if (!files.length) return;
      toast('이미지 처리 중…');
      for (const file of files) {
        try {
          d.images.push({ src: await fileToDataUrl(file), caption: '' });
        } catch (err) {
          alert(`'${file.name}'을(를) 불러오지 못했어요.`);
        }
      }
      drawEditor(id);
    });

    $form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = d.name.trim();
      if (!name) return toast('이름을 입력해 주세요');
      const now = new Date().toISOString();
      const c = normalizeChar({
        ...d,
        name,
        tags: [...new Set(d.tagsText.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))],
        profile: d.profile.filter((p) => p.value.trim()),
        sections: d.sections.filter((s) => s.body.trim()),
        relations: d.relations.filter((r) => r.name.trim()).map((r) => {
          const t = chars().find((x) => x.name === r.name.trim());
          return { ...r, name: r.name.trim(), id: t ? t.id : '' };
        }),
        updatedAt: now,
      });
      if (!c.images.some((img) => img.src === c.avatar)) c.avatar = '';
      const idx = chars().findIndex((x) => x.id === c.id);
      if (idx >= 0) chars()[idx] = c; else chars().push(c);
      if (await persist()) {
        state.draft = null;
        toast('저장했어요');
        location.hash = '#/oc/' + encodeURIComponent(c.id);
      }
    });
  }

  function fileToDataUrl(file) {
    const read = () => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    if (file.type === 'image/gif' || file.type === 'image/svg+xml') return read();
    return read().then((url) => new Promise((resolve, reject) => {
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
    }));
  }

  // ---------- backup / restore ----------
  function exportPayload() {
    return { version: 1, siteTitle: state.data.siteTitle, exportedAt: new Date().toISOString(), characters: chars() };
  }

  function renderBackup() {
    const bytes = new Blob([JSON.stringify(state.data)]).size;
    const imgCount = chars().reduce((n, c) => n + c.images.length, 0);
    $app.innerHTML = `
      <a class="back" href="#/">← 목록으로</a>
      <h1 style="margin:0 0 6px">백업 / 복원</h1>
      <p class="stat" style="color:var(--muted);margin:0 0 20px">
        캐릭터 ${chars().length}명 · 이미지 ${imgCount}장 · 약 ${(bytes / 1024 / 1024).toFixed(2)}MB ·
        현재 데이터: ${state.source === 'local' ? '이 브라우저에 저장된 편집본' : '사이트 기본 데이터 (data/characters.js)'}
      </p>
      <div class="backup-grid">
        <div class="fieldset">
          <div class="fieldset-title">백업 파일 내보내기</div>
          <p>모든 캐릭터와 업로드한 이미지를 JSON 파일 하나로 받아요. 클라우드 드라이브 등에 보관해 두세요.</p>
          <div class="btns"><button type="button" class="btn btn-primary" id="export-json">백업 파일 받기 (.json)</button></div>
        </div>
        <div class="fieldset">
          <div class="fieldset-title">백업 파일 불러오기</div>
          <p>내보낸 .json(또는 characters.js) 파일을 불러와요. '합치기'는 같은 캐릭터라면 더 최근에 수정된 쪽을 남겨요.</p>
          <div class="btns">
            <label class="btn">합치기<input type="file" id="import-merge" accept=".json,.js,application/json" hidden></label>
            <label class="btn btn-danger">전부 덮어쓰기<input type="file" id="import-replace" accept=".json,.js,application/json" hidden></label>
          </div>
        </div>
        <div class="fieldset">
          <div class="fieldset-title">사이트에 영구 반영</div>
          <p>받은 <code>characters.js</code>로 저장소의 <code>data/characters.js</code>를 교체하고 커밋하면, 어느 기기에서 접속하든 같은 내용이 보여요.</p>
          <div class="btns"><button type="button" class="btn" id="export-js">사이트 데이터 파일 받기 (characters.js)</button></div>
        </div>
        <div class="fieldset">
          <div class="fieldset-title">사이트 설정</div>
          <div class="field"><label for="site-title-input">사이트 제목</label>
            <input type="text" id="site-title-input" value="${esc(state.data.siteTitle)}"></div>
          <div class="btns">
            <button type="button" class="btn" id="save-title">제목 저장</button>
            ${state.source === 'local' ? '<button type="button" class="btn btn-danger" id="reset-local">브라우저 편집본 지우기</button>' : ''}
          </div>
        </div>
      </div>`;

    document.getElementById('export-json').addEventListener('click', () => {
      download(`oc-backup-${today()}.json`, JSON.stringify(exportPayload(), null, 2));
    });
    document.getElementById('export-js').addEventListener('click', () => {
      const p = exportPayload();
      delete p.exportedAt;
      download('characters.js',
        '// 사이트에 기본으로 표시되는 캐릭터 데이터입니다. (자캐 백업에서 내보냄: ' + new Date().toLocaleString('ko-KR') + ')\n' +
        'window.OC_DATA = ' + JSON.stringify(p, null, 2) + ';\n', 'text/javascript');
    });
    document.getElementById('import-merge').addEventListener('change', (e) => importFile(e.target.files[0], 'merge'));
    document.getElementById('import-replace').addEventListener('change', (e) => importFile(e.target.files[0], 'replace'));
    document.getElementById('save-title').addEventListener('click', async () => {
      state.data.siteTitle = document.getElementById('site-title-input').value.trim() || '자캐 백업';
      if (await persist()) toast('저장했어요');
    });
    const $reset = document.getElementById('reset-local');
    if ($reset) $reset.addEventListener('click', async () => {
      if (!confirm('이 브라우저에 저장된 편집본을 지우고 사이트 기본 데이터로 돌아갈까요?\n백업 파일을 먼저 받아두는 걸 권장해요.')) return;
      await clearLocal().catch(() => {});
      state.data = normalizeData(window.OC_DATA);
      state.source = 'repo';
      renderBanner();
      toast('초기화했어요');
      renderBackup();
    });
  }

  async function importFile(file, mode) {
    if (!file) return;
    let parsed;
    try {
      let text = await file.text();
      text = text.trim().replace(/^(\/\/[^\n]*\n)*\s*window\.OC_DATA\s*=\s*/, '').replace(/;\s*$/, '');
      parsed = JSON.parse(text);
    } catch (err) {
      return alert('파일을 읽지 못했어요. 이 사이트에서 내보낸 백업 파일인지 확인해 주세요.');
    }
    const incoming = normalizeData(Array.isArray(parsed) ? { characters: parsed } : parsed);
    if (!incoming.characters.length) return alert('파일에 캐릭터가 없어요.');

    if (mode === 'replace') {
      if (!confirm(`현재 캐릭터 ${chars().length}명을 지우고 파일의 ${incoming.characters.length}명으로 바꿀까요?`)) return;
      state.data = { ...incoming, siteTitle: parsed.siteTitle ? incoming.siteTitle : state.data.siteTitle };
    } else {
      let added = 0, updated = 0;
      for (const c of incoming.characters) {
        const idx = chars().findIndex((x) => x.id === c.id);
        if (idx < 0) { chars().push(c); added++; }
        else if (new Date(c.updatedAt) > new Date(chars()[idx].updatedAt)) { chars()[idx] = c; updated++; }
      }
      if (!confirm(`새 캐릭터 ${added}명 추가, ${updated}명 업데이트. 저장할까요?`)) {
        state.data = normalizeData((await loadLocal()) || window.OC_DATA);
        return renderBackup();
      }
    }
    if (await persist()) { toast('불러왔어요'); renderBackup(); }
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
  function route() {
    $lightbox.hidden = true;
    const hash = location.hash.replace(/^#\/?/, '');
    const [page, rawId] = hash.split('/');
    const id = rawId ? decodeURIComponent(rawId) : '';
    if (page !== 'edit' && page !== 'new') state.draft = null;
    document.title = state.data.siteTitle;

    if (page === 'oc' && id) renderDetail(id);
    else if (page === 'edit' && id) renderEditor(id);
    else if (page === 'new') renderEditor('');
    else if (page === 'backup') renderBackup();
    else renderList();
    if (page !== 'edit' && page !== 'new') window.scrollTo(0, 0);
  }

  (async function init() {
    const local = await loadLocal();
    if (local && Array.isArray(local.characters)) {
      state.data = normalizeData(local);
      state.source = 'local';
    } else {
      state.data = normalizeData(window.OC_DATA);
    }
    renderBanner();
    window.addEventListener('hashchange', route);
    route();
  })();
})();
