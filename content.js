// Handwave content controller: renders the hand cursor, navigation flashes,
// and the dictation bubble, and executes scroll / click / type actions sent by
// the side panel. All UI lives in a pointer-events:none shadow DOM overlay, so
// it never intercepts real (or synthetic) page interaction.
(() => {
  if (window.__handwaveLoaded) return;
  window.__handwaveLoaded = true;

  let host = null, shadow = null, cursorEl = null, navFlashEl = null, dictEl = null, dictTextEl = null;
  let navFlashTimer = 0;
  let lastEditable = null;
  let flingRaf = 0;

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      return !['button', 'submit', 'checkbox', 'radio', 'range', 'color', 'file', 'reset', 'image'].includes(t);
    }
    return false;
  }
  document.addEventListener('focusin', (e) => {
    if (isEditable(e.target)) lastEditable = e.target;
  }, true);

  function ensureUi() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = '__handwave_host';
    host.style.cssText = 'all:initial; position:fixed; inset:0; z-index:2147483647; pointer-events:none;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }
      #cursor {
        position: fixed; z-index: 2; left: 0; top: 0; width: 30px; height: 30px;
        margin: -15px 0 0 -15px; border-radius: 50%;
        border: 2.5px solid #56d9ff; background: rgba(86, 217, 255, 0.18);
        box-shadow: 0 0 14px rgba(86, 217, 255, 0.55);
        opacity: 0; transition: opacity 0.15s, border-color 0.1s, background 0.1s, transform 0.08s;
        will-change: left, top;
      }
      #cursor::after {
        content: ''; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px;
        margin: -3px 0 0 -3px; border-radius: 50%; background: currentColor;
      }
      #cursor { color: #56d9ff; }
      #cursor.show { opacity: 1; }
      #cursor.pinch { border-color: #ff9ad5; color: #ff9ad5; background: rgba(255,154,213,0.25); transform: scale(0.7); }
      #cursor.pinch2 { border-color: #c9a2ff; color: #c9a2ff; background: rgba(201,162,255,0.25); transform: scale(0.7); }
      #cursor.grab { border-color: #ffb066; color: #ffb066; background: rgba(255,176,102,0.2); transform: scale(1.25); }
      #cursor.flash { animation: hwflash 0.25s; }
      @keyframes hwflash { 0% { transform: scale(1.6); } 100% { transform: scale(1); } }
      #navFlash {
        position: fixed; z-index: 1; top: 50%; width: 104px; height: 104px;
        margin-top: -52px; display: flex; align-items: center; justify-content: center;
        border-radius: 50%; font: 700 56px/1 system-ui, sans-serif;
        color: #56d9ff; background: rgba(8, 10, 22, 0.65);
        border: 1px solid rgba(86, 217, 255, 0.45);
        box-shadow: 0 0 30px rgba(86, 217, 255, 0.35);
        opacity: 0; transition: opacity 0.15s;
      }
      #navFlash.show { opacity: 1; }
      #dict {
        position: fixed; z-index: 1; left: 50%; bottom: 24px; transform: translateX(-50%);
        display: none; align-items: center; gap: 11px;
        max-width: 72vw; padding: 11px 20px; border-radius: 999px;
        background: rgba(8, 10, 22, 0.86);
        border: 1px solid rgba(255, 95, 143, 0.55);
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
        color: #dfe6ff; font: 14.5px system-ui, sans-serif;
        backdrop-filter: blur(9px);
      }
      #dict.show { display: flex; }
      #dict .mic {
        flex: none; width: 11px; height: 11px; border-radius: 50%;
        background: #ff5f8f; box-shadow: 0 0 10px rgba(255, 95, 143, 0.8);
        animation: hwpulse 1.2s ease-in-out infinite;
      }
      #dict .txt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #dict .txt em { font-style: normal; opacity: 0.55; }
      @keyframes hwpulse { 50% { transform: scale(1.5); opacity: 0.6; } }
      @media (prefers-reduced-motion: reduce) {
        #dict .mic { animation: none; }
        #cursor.flash { animation: none; }
      }
    `;
    shadow.appendChild(style);
    cursorEl = document.createElement('div');
    cursorEl.id = 'cursor';
    shadow.appendChild(cursorEl);
    navFlashEl = document.createElement('div');
    navFlashEl.id = 'navFlash';
    shadow.appendChild(navFlashEl);
    dictEl = document.createElement('div');
    dictEl.id = 'dict';
    const mic = document.createElement('span');
    mic.className = 'mic';
    dictTextEl = document.createElement('span');
    dictTextEl.className = 'txt';
    dictEl.append(mic, dictTextEl);
    shadow.appendChild(dictEl);
    (document.documentElement || document.body).appendChild(host);
  }

  function deepElementFromPoint(doc, x, y) {
    let el = doc.elementFromPoint(x, y);
    let guard = 0;
    while (el && el.shadowRoot && guard++ < 6) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // ---------------------------------------------------- scroll targeting
  // A grab scrolls the scrollable component under the hand (piercing open
  // shadow DOM and same-origin iframes), chaining leftover delta to ancestor
  // scrollers and finally the window — like real touch scrolling. The target
  // chain is resolved at grab start and locked for the whole drag.
  let scrollSession = null; // {chain, win, t}

  function resolveScrollSession(xf, yf) {
    let win = window, doc = document;
    let px = xf * win.innerWidth, py = yf * win.innerHeight;
    let el = deepElementFromPoint(doc, px, py);
    let hops = 0;
    while (el && el.tagName === 'IFRAME' && hops++ < 4) {
      let idoc = null;
      try { idoc = el.contentDocument; } catch { idoc = null; } // cross-origin
      if (!idoc) break;
      const r = el.getBoundingClientRect();
      px -= r.left; py -= r.top;
      win = el.contentWindow; doc = idoc;
      el = deepElementFromPoint(doc, px, py);
    }
    const chain = [];
    let n = el;
    while (n && n !== doc.body && n !== doc.documentElement) {
      if (n.nodeType === 1) {
        const s = win.getComputedStyle(n);
        const canY = /(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1;
        const canX = /(auto|scroll|overlay)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1;
        if (canY || canX) chain.push(n);
      }
      n = n.parentElement || n.parentNode?.host || null;
    }
    return { chain, win, t: performance.now() };
  }

  function getScrollSession(xf, yf) {
    const now = performance.now();
    if (scrollSession && now - scrollSession.t < 350) {
      scrollSession.t = now;
      return scrollSession;
    }
    scrollSession = resolveScrollSession(xf ?? 0.5, yf ?? 0.5);
    return scrollSession;
  }

  function applyScroll(session, dx, dy) {
    let rx = dx, ry = dy;
    for (const el of session.chain) {
      if (Math.abs(ry) > 0.1) {
        const b = el.scrollTop;
        el.scrollTo({ top: b + ry, left: el.scrollLeft, behavior: 'instant' });
        ry -= el.scrollTop - b;
      }
      if (Math.abs(rx) > 0.1) {
        const b = el.scrollLeft;
        el.scrollTo({ left: b + rx, top: el.scrollTop, behavior: 'instant' });
        rx -= el.scrollLeft - b;
      }
      if (Math.abs(rx) <= 0.1 && Math.abs(ry) <= 0.1) return;
    }
    session.win.scrollBy({ left: rx, top: ry, behavior: 'instant' });
  }

  function cancelFling() {
    if (flingRaf) { cancelAnimationFrame(flingRaf); flingRaf = 0; }
  }

  function fling(vx, vy, session) {
    cancelFling();
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      session.t = now; // keep the grab's target alive for the whole fling
      applyScroll(session, vx * dt, vy * dt);
      vx *= Math.pow(0.12, dt);
      vy *= Math.pow(0.12, dt);
      if (Math.hypot(vx, vy) > 40) flingRaf = requestAnimationFrame(tick);
      else flingRaf = 0;
    };
    flingRaf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ typing
  function target() {
    if (lastEditable && lastEditable.isConnected) return lastEditable;
    if (isEditable(document.activeElement)) return document.activeElement;
    return null;
  }

  function manualInsert(el, text) {
    if (el.isContentEditable) return;
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? el.value.length;
    el.setRangeText(text, s, e, 'end');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  // Insert a dictated phrase, adding a joining space when the caret sits
  // right after a non-space character.
  function typeText(text) {
    const el = target();
    if (!el) return;
    el.focus();
    let t = text.replace(/\s+$/, '');
    if (!t) return;
    let needSpace = false;
    if (!el.isContentEditable) {
      const caret = el.selectionStart ?? el.value.length;
      needSpace = caret > 0 && !/\s/.test(el.value[caret - 1] || '');
    } else {
      needSpace = !/(^|\s)$/.test(el.textContent || '');
    }
    if (needSpace && !/^\s/.test(t)) t = ' ' + t;
    if (!document.execCommand('insertText', false, t)) manualInsert(el, t);
  }

  // ------------------------------------------------------------ actions
  function pressAt(msg) {
    ensureUi();
    cursorEl.classList.add('flash');
    setTimeout(() => cursorEl.classList.remove('flash'), 260);

    const px = msg.x * window.innerWidth;
    const py = msg.y * window.innerHeight;
    const el = deepElementFromPoint(document, px, py);
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    const editable = isEditable(el);
    if (editable) { el.focus(); lastEditable = el; }
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', opts));
    // The panel starts dictation on editable targets, stops it elsewhere.
    chrome.runtime.sendMessage({ hw: true, t: 'clicked', editable }).catch(() => {});
  }

  // Right-click: full right-button event sequence ending in contextmenu.
  // Pages with their own context menus respond; Chrome's native menu cannot
  // be opened by page-dispatched events.
  function rightClickAt(msg) {
    ensureUi();
    cursorEl.classList.add('flash');
    setTimeout(() => cursorEl.classList.remove('flash'), 260);
    const px = msg.x * window.innerWidth;
    const py = msg.y * window.innerHeight;
    const el = deepElementFromPoint(document, px, py);
    if (!el) return;
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: px, clientY: py, button: 2, buttons: 2,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('contextmenu', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
  }

  function setCursor(msg) {
    ensureUi();
    if (msg.mode === 'none') {
      cursorEl.classList.remove('show');
      return;
    }
    cursorEl.style.left = `${msg.x * window.innerWidth}px`;
    cursorEl.style.top = `${msg.y * window.innerHeight}px`;
    cursorEl.className = `show ${['pinch', 'pinch2', 'grab'].includes(msg.mode) ? msg.mode : ''}`;
  }

  function setDictation(msg) {
    ensureUi();
    if (msg.state === 'listening') {
      dictEl.classList.add('show');
      dictTextEl.innerHTML = '';
      if (msg.interim) dictTextEl.textContent = msg.interim;
      else {
        const em = document.createElement('em');
        em.textContent = 'listening — just talk, click elsewhere to stop';
        dictTextEl.appendChild(em);
      }
    } else {
      dictEl.classList.remove('show');
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.hw) return;
    switch (msg.t) {
      case 'cursor':
        setCursor(msg);
        break;
      case 'scroll':
        cancelFling();
        applyScroll(getScrollSession(msg.x, msg.y), msg.dx, msg.dy);
        break;
      case 'fling':
        fling(msg.vx, msg.vy, getScrollSession(msg.x, msg.y));
        break;
      case 'press':
        pressAt(msg);
        break;
      case 'press2':
        rightClickAt(msg);
        break;
      case 'type':
        typeText(msg.text);
        break;
      case 'dict':
        setDictation(msg);
        break;
      case 'navFlash':
        ensureUi();
        navFlashEl.textContent = msg.back ? '‹' : '›';
        navFlashEl.style.left = msg.back ? '28px' : 'auto';
        navFlashEl.style.right = msg.back ? 'auto' : '28px';
        navFlashEl.classList.add('show');
        clearTimeout(navFlashTimer);
        navFlashTimer = setTimeout(() => navFlashEl.classList.remove('show'), 600);
        break;
    }
    sendResponse({ ok: true });
  });
})();
