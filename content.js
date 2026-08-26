// Handwave content controller: renders the hand cursor and on-screen keyboard,
// and executes scroll / click / type actions sent by the side panel.
// All UI lives in a pointer-events:none shadow DOM overlay, so it never
// intercepts real (or synthetic) page interaction.
(() => {
  if (window.__handwaveLoaded) return;
  window.__handwaveLoaded = true;

  let host = null, shadow = null, cursorEl = null, kbdEl = null, navFlashEl = null;
  let navFlashTimer = 0;
  let kbdVisible = false;
  let keyRects = [];        // {el, key, left, top, right, bottom}
  let hoverKeyEl = null;
  let shift = false;
  let lastEditable = null;
  let flingRaf = 0;

  const KEY_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'bksp'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'enter'],
    ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.'],
    ['hide', '@', 'space', '-', '/'],
  ];
  const KEY_LABELS = { bksp: '⌫', enter: '↵', shift: '⇧', hide: '✕', space: ' ' };

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
      #kbd {
        position: fixed; z-index: 1; left: 50%; bottom: 20px; transform: translateX(-50%);
        display: none; flex-direction: column; gap: 6px;
        padding: 12px; border-radius: 16px;
        background: rgba(8, 10, 22, 0.82);
        border: 1px solid rgba(150, 170, 255, 0.28);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(10px);
        font-family: system-ui, sans-serif;
      }
      #kbd.show { display: flex; }
      .row { display: flex; gap: 6px; justify-content: center; }
      .key {
        min-width: 46px; height: 48px; padding: 0 8px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 9px; border: 1px solid rgba(150, 170, 255, 0.22);
        background: rgba(26, 30, 54, 0.9); color: #dfe6ff;
        font-size: 17px; text-transform: none; user-select: none;
      }
      .key[data-key="space"] { min-width: 220px; }
      .key[data-key="enter"], .key[data-key="bksp"], .key[data-key="shift"], .key[data-key="hide"] {
        color: #9fb0d8; font-size: 15px;
      }
      .key.hover {
        background: #35406e; border-color: #56d9ff; color: #fff;
        box-shadow: 0 0 12px rgba(86, 217, 255, 0.45);
      }
      .key.press { background: #ff9ad5; color: #04050c; border-color: #ff9ad5; }
      .key.on { border-color: #c9a2ff; color: #c9a2ff; }
    `;
    shadow.appendChild(style);
    cursorEl = document.createElement('div');
    cursorEl.id = 'cursor';
    shadow.appendChild(cursorEl);
    navFlashEl = document.createElement('div');
    navFlashEl.id = 'navFlash';
    shadow.appendChild(navFlashEl);
    buildKeyboard();
    (document.documentElement || document.body).appendChild(host);
  }

  function buildKeyboard() {
    kbdEl = document.createElement('div');
    kbdEl.id = 'kbd';
    for (const row of KEY_ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'row';
      for (const key of row) {
        const k = document.createElement('div');
        k.className = 'key';
        k.dataset.key = key;
        k.textContent = KEY_LABELS[key] ?? key;
        rowEl.appendChild(k);
      }
      kbdEl.appendChild(rowEl);
    }
    shadow.appendChild(kbdEl);
  }

  function refreshKeyLabels() {
    for (const k of kbdEl.querySelectorAll('.key')) {
      const key = k.dataset.key;
      if (KEY_LABELS[key] !== undefined) continue;
      k.textContent = shift ? key.toUpperCase() : key;
    }
    kbdEl.querySelector('[data-key="shift"]').classList.toggle('on', shift);
  }

  function computeKeyRects() {
    keyRects = [];
    for (const k of kbdEl.querySelectorAll('.key')) {
      const r = k.getBoundingClientRect();
      keyRects.push({ el: k, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
  }
  window.addEventListener('resize', () => { if (kbdVisible) computeKeyRects(); });

  function showKeyboard(show) {
    ensureUi();
    kbdVisible = show;
    kbdEl.classList.toggle('show', show);
    if (show) computeKeyRects();
    else setHover(null);
  }

  function setHover(el) {
    if (hoverKeyEl === el) return;
    hoverKeyEl?.classList.remove('hover');
    hoverKeyEl = el;
    hoverKeyEl?.classList.add('hover');
  }

  function setCursor(msg) {
    ensureUi();
    if (msg.mode === 'none') {
      cursorEl.classList.remove('show');
      setHover(null);
      return;
    }
    const px = msg.x * window.innerWidth;
    const py = msg.y * window.innerHeight;
    cursorEl.style.left = `${px}px`;
    cursorEl.style.top = `${py}px`;
    cursorEl.className = `show ${msg.mode === 'pinch' ? 'pinch' : msg.mode === 'grab' ? 'grab' : ''}`;
    if (kbdVisible) {
      const hit = keyRects.find((r) => px >= r.left && px <= r.right && py >= r.top && py <= r.bottom);
      setHover(hit ? hit.el : null);
    }
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

  function typeChar(ch) {
    const el = target();
    if (!el) return;
    el.focus();
    if (!document.execCommand('insertText', false, ch)) manualInsert(el, ch);
  }

  function backspace() {
    const el = target();
    if (!el) return;
    el.focus();
    if (document.execCommand('delete', false)) return;
    if (!el.isContentEditable) {
      const s = el.selectionStart ?? el.value.length;
      const e = el.selectionEnd ?? el.value.length;
      if (s === e && s > 0) el.setRangeText('', s - 1, e, 'end');
      else el.setRangeText('', s, e, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
  }

  function pressEnter() {
    const el = target();
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) {
      if (!document.execCommand('insertText', false, '\n')) manualInsert(el, '\n');
      return;
    }
    const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    const canceled = !el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (!canceled) el.closest('form')?.requestSubmit?.();
  }

  function activateKey(keyEl) {
    const key = keyEl.dataset.key;
    keyEl.classList.add('press');
    setTimeout(() => keyEl.classList.remove('press'), 180);
    if (key === 'shift') { shift = !shift; refreshKeyLabels(); return; }
    if (key === 'hide') {
      showKeyboard(false);
      chrome.runtime.sendMessage({ hw: true, t: 'kbdClosed' }).catch(() => {});
      return;
    }
    if (key === 'bksp') { backspace(); return; }
    if (key === 'enter') { pressEnter(); return; }
    const ch = key === 'space' ? ' ' : shift ? key.toUpperCase() : key;
    typeChar(ch);
    if (shift && key !== 'space') { shift = false; refreshKeyLabels(); }
  }

  // ------------------------------------------------------------ actions
  function pressAt(msg) {
    ensureUi();
    cursorEl.classList.add('flash');
    setTimeout(() => cursorEl.classList.remove('flash'), 260);
    if (kbdVisible && hoverKeyEl) { activateKey(hoverKeyEl); return; }

    const px = msg.x * window.innerWidth;
    const py = msg.y * window.innerHeight;
    const el = deepElementFromPoint(document, px, py);
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: px, clientY: py };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (isEditable(el)) { el.focus(); lastEditable = el; }
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', opts));
  }

  // ---------------------------------------------------- scroll targeting
  // A grab scrolls the scrollable component under the hand (piercing open
  // shadow DOM and same-origin iframes), chaining leftover delta to ancestor
  // scrollers and finally the window — like real touch scrolling. The target
  // chain is resolved at grab start and locked for the whole drag.
  let scrollSession = null; // {chain, win, t}

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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.hw) return;
    switch (msg.t) {
      case 'cursor':
        setCursor(msg);
        if (msg.kbd !== undefined && msg.kbd !== kbdVisible) showKeyboard(msg.kbd);
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
      case 'kbd':
        showKeyboard(msg.show);
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
    sendResponse({ ok: true, kbd: kbdVisible });
  });
})();
