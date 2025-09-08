/*! Medical Assistant Chat Widget v1.8 (hardened, fixed & enhanced)
   Public API: window.MedAssistWidget.init(options?)
   options: { endpoint, id, labels:{title,subtitle}, timeout, mock, verbose }
*/

const ASSETS = (typeof window !== 'undefined' && window.MACW_ASSETS_URL) ? window.MACW_ASSETS_URL : '';

(function () {
  if (window.MedAssistWidget) return; // prevent double-initialize

  ensureViewportMeta();

  const DEFAULT_ENDPOINT = (typeof window !== 'undefined' && window.MACW_ENDPOINT) ? window.MACW_ENDPOINT : 'https://example.com/webhook/oat-clinic';
  const DEFAULT_ID = (typeof window !== 'undefined' && window.MACW_ID) ? window.MACW_ID : '';
  const DEFAULT_LABELS = { title: 'OAT Clinic', subtitle: '' };

  const DEFAULTS = {
    endpoint: "https://assist.medidoze.com/webhook/oat_clinic",
    id: "oat_clinic",
    labels: DEFAULT_LABELS,
    timeout: 60000,
    mock: false,
    verbose: false,

      headerGradient: 'linear-gradient(86deg, rgb(0 103 167), rgba(244,127,32,1))',
  userMessageColor: 'rgba(0,94,153,.85)',
  sendButtonColor: 'rgb(0 103 167)',
  clinicNameColor: '#0067a7',
  logoUrl: ASSETS + 'images/logo2.png',
  };
    const STORAGE_KEYS = { collapsed: 'medical_bot_collapsed' };

    function h(tag, attrs = {}, ...children) {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v !== null && v !== undefined) el.setAttribute(k, v);
      }
      for (const c of children.flat()) {
        if (c == null) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
      return el;
    }
  
    function linkifyFragment(rootOrDoc, text) {
      const d = (rootOrDoc && rootOrDoc.ownerDocument) || document;
      const frag = d.createDocumentFragment();
      const urlRe = /((?:https?:\/\/|www\.)[^\s<)]+)|(?:mailto:([^\s<)]+))/gi;
      let last = 0, m;
      while ((m = urlRe.exec(text))) {
        if (m.index > last) frag.appendChild(d.createTextNode(text.slice(last, m.index)));
        const raw = m[0];
        const a = d.createElement('a');
        if (raw.toLowerCase().startsWith('mailto:')) { a.href = raw; a.textContent = raw.replace(/^mailto:/i, ''); }
        else if (/^www\./i.test(raw)) { a.href = 'https://' + raw; a.textContent = raw; }
        else { a.href = raw; a.textContent = raw; }
        a.target = '_blank'; a.rel = 'noopener noreferrer';
        frag.appendChild(a);
        last = urlRe.lastIndex;
      }
      if (last < text.length) frag.appendChild(d.createTextNode(text.slice(last)));
      return frag;
    }
  
    function extractGeminiText(obj) {
      const cand = (obj?.candidates || [])[0] || {};
      const parts = cand?.content?.parts || [];
      return parts.map(p => p?.text || '').join('').trim();
    }
  
    function ensureViewportMeta() {
      try {
        const head = document.head || document.getElementsByTagName('head')[0];
        let meta = document.querySelector('meta[name="viewport"]');
        const wanted = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content';
        if (!meta) {
          meta = document.createElement('meta');
          meta.setAttribute('name', 'viewport');
          meta.setAttribute('content', wanted);
          head.appendChild(meta);
          return;
        }
        const content = meta.getAttribute('content') || '';
        const tokens = new Set(content.split(',').map(s => s.trim()).filter(Boolean));
        tokens.add('viewport-fit=cover');
        tokens.add('interactive-widget=resizes-content');
        meta.setAttribute('content', Array.from(tokens).join(', '));
      } catch { /* no-op */ }
    }
  
    function normalize(data) {
      if (Array.isArray(data)) data = data[0] || {};
      const status = data.status || 'success';
      const body = data.data || data;
  
      let message = body.answer || body.response || body.message || body.output_text || body.text || body.content || '';
      if (!message && body.raw) message = extractGeminiText(body.raw);
      if (!message && data.candidates) message = extractGeminiText(data);
  
      const confidence = (body.confidence || body.confidence_level || '').toString().toLowerCase();
      const sources = body.sources || body.refs || [];
      const meta = { clinic_url: body.clinic_url, clinic_phone: body.clinic_phone, timestamp: body.now || new Date().toISOString() };
      return { status, message, confidence, sources, meta, error: body.error || null, raw: body.raw || null };
    }
  
    function createWidgetRoot(position = 'bottom-right') {
      const positions = {
        'bottom-right': { right: '20px', bottom: '20px' },
        'bottom-left': { left: '20px', bottom: '20px' },
        'top-right': { right: '20px', top: '20px' },
        'top-left': { left: '20px', top: '20px' }
      };
      
      const pos = positions[position] || positions['bottom-right'];
      
      const container = h('div', {
        id: 'medassist-launcher',
        style: { position: 'fixed', ...pos, zIndex: 999999 }
      });
      document.body.appendChild(container);
      const host = h('div');
      container.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      return { container, shadow };
    }
  
    function buildWidget(shadow, options, container) {
      console.log('buildWidget function CALLED. Creating styles...');
      const cfg = { ...DEFAULTS, ...(options || {}) };
      cfg.labels = { ...DEFAULTS.labels, ...(options?.labels || {}) };
    
      try {
        const current = document.currentScript?.src || '';
        const q = current.split('?')[1];
        if (q) {
          const p = new URLSearchParams(q);
          if (p.has('mock')) cfg.mock = p.get('mock') === '1';
          if (p.has('verbose')) cfg.verbose = p.get('verbose') === '1';
          if (p.has('timeout')) cfg.timeout = parseInt(p.get('timeout') || '60000', 10);
          if (p.has('id')) cfg.id = p.get('id') || cfg.id;
        }
      } catch { }


      // Fix: Ensure the style element is created properly and added to shadow DOM first
      const style = document.createElement('style');
      style.textContent = `
        :host{ all: initial; }
        @keyframes pop{ from{ transform:scale(.98); opacity:.0 } to{ transform:scale(1); opacity:1 } }
        @keyframes rise{ to{ opacity:1; transform:translateY(0) } }
        @keyframes blink{ 0%,80%,100%{ transform:translateY(0); opacity:.6 } 40%{ transform:translateY(-3px); opacity:1 } }
        
        :root{ --bg1:#6a8dff; --bg2:#9c6bff; --card:#ffffffee; --ink:#111827; --muted:#6b7280;
                --line:#e5e7eb; --primary:#6a8dff; --primary2:#9c6bff; --message:#ffffff;
                --user1:#0067a7; --user2:#f47f20; --shadow: 0 20px 50px rgba(0,0,0,.18); }
        .widget{ font: 14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,"Helvetica Neue",Arial,"Noto Sans","Apple Color Emoji","Segoe UI Emoji"; color:var(--ink); }
        input, textarea, select, button { font-size:16px !important; }
        .input,.send{ font-size:15px !important; -webkit-text-size-adjust:100%; }
          @supports (-webkit-touch-callout: none) {
            input, select, textarea, .input {
              font-size: 16px !important;
            }
          }

        .button{
          width:54px;height:54px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;
          box-shadow:0 12px 30px rgba(0,0,0,.20);background:linear-gradient(135deg,var(--primary),var(--primary2));
          color:#fff;font-size:24px;transition:transform .15s ease, box-shadow .2s ease;position:relative;
        }
        .button:hover{ transform: translateY(-1px); box-shadow: 0 16px 36px rgba(0,0,0,.26) }
        .badge{ position:absolute; top:-6px; right:-6px; background:#ef4444; color:#fff; border-radius:999px; font-size:11px; padding:2px 6px; display:none; }
        
        :host,.widget,.panel{ overscroll-behavior: contain; }
        .panel{
          position:fixed;  width:min(380px, 92vw); height:520px; background:#f7f8fb;
          border-radius:16px; box-shadow:var(--shadow); overflow:hidden; border:1px solid rgba(255,255,255,.25);
          display:none; animation: pop .35s ease-out; backdrop-filter: blur(6px);touch-action: pan-y;
        }
        .panel.open{
          display:flex;
          flex-direction:column;
        }
        .panel.fullscreen{
          position:fixed !important; inset:0 !important;width: auto !important;
            height: auto !important;padding-top: env(safe-area-inset-top);
          border-radius:0 !important; border:none !important; background:#f7f8fb;
          overflow:hidden !important; backdrop-filter:none !important; -webkit-backdrop-filter:none !important;
        }

        .head{
          padding:9px 13px;
          position: sticky;  /* safe because .head is outside the scrolling .stream */
          top: 0;
          z-index: 2;
          border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between;
          border-top-left-radius:16px; border-top-right-radius:16px; border:1px solid #e1e1e1;
        }
        .panel.fullscreen .head{ border-radius:0 !important; padding-top: calc(9px + env(safe-area-inset-top)); }
        .title{ display:flex; align-items:center; gap:10px; }
        .title h1{ font-size:16px; font-weight:700; margin:0;}
        .title small{ color:var(--muted); font-size:12px }
        .close{ border:none; background:#0000; padding: 10px 14px; cursor:pointer; font-size:18px; }
        .head, .composer{ flex: 0 0 auto; }
        .row{ display:flex; opacity:0; transform:translateY(8px); animation: rise .28s ease forwards; flex-direction:column;}
        .row.user{ align-items:flex-end } .row.message{ align-items:flex-start }
        .bubble{ padding:5px 10px; border-radius:14px; max-width:78%; white-space:pre-wrap; word-wrap:break-word; line-height:1.45; box-shadow:0 3px 10px rgba(0,0,0,.05); }
        .message .bubble{ background:#fff; border:1px solid var(--line); border-bottom-left-radius:0px; }
        .user .bubble{ color:#fff9f2; background: ${cfg.userMessageColor}; border-bottom-right-radius:0px; }
        .time{ font-size:10px !important; color:#9ca3af; margin-top: 4px; }
        .row.message .time{ text-align:left; } .row.user .time{ text-align:right; }
        
        .dots{ display:flex; gap:6px } .dot{ width:8px; height:8px; background:#d1d5db; border-radius:50%; animation: blink 1.2s infinite ease-in-out }
        .dot:nth-child(2){ animation-delay:.15s } .dot:nth-child(3){ animation-delay:.3s }
        .composer{ position:relative; background:#f7f8fb; border-top: 1px solid #e5e7eb; }
        .panel.fullscreen .composer{ padding-bottom: max(var(--kb, 0px), env(safe-area-inset-bottom)); }
        .form{
          display:flex;
          align-items:center;
          position:relative;
          box-sizing:border-box;
        }
        .input{
            flex: 1;
            max-height: 120px;
            border: 1px solid #E1E1E1;
            border-radius: 16px;
            padding: 4px 80px 0 10px;
            outline: none;
            resize: none;
            line-height: 1.3;
            border-top-left-radius: 0;
            border-top-right-radius: 0;
            overflow-y: scroll;
            scrollbar-width: none;
            font-family: Arial;
        }
        .input::-webkit-scrollbar{ display:none; }
        
      .stream{
        padding: 7px 8px;
        flex: 1 1 auto;
        min-height: 0;           /* CRITICAL for iOS */
        min-width: 0;            /* also helpful */
       border: 1px solid #E1E1E1;
        border-bottom: none;
        border-top: none;
        overflow-y: auto;
        overflow-x: hidden;
        -webkit-overflow-scrolling: touch;
        /* remove this if you had it */
        /* overflow-anchor: none;  */
      }
        
        .typing{
          display:none; position:absolute; left:12px; z-index: 3;
          bottom: calc(var(--composer-h, 58px) + 8px);
          padding:8px; background:#fff; border:1px solid var(--line); border-radius:14px; width: 38px; box-shadow:0 2px 6px rgba(0,0,0,.06);margin: 0;
        }
        .panel.fullscreen .typing {
          bottom: calc(var(--composer-h, 58px) + 8px + max(var(--kb, 0px), env(safe-area-inset-bottom)));
        }
        
        .send{
            position: absolute;
            right: 16px;
            top: 50%;
            transform: translateY(-50%);
            height: 32px;
            min-width: 60px;
            border: none;
            border-radius: 6px;
            color: #fff;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }
        .send:hover{ background: ${cfg.sendButtonColor}dd }
        .send:disabled{ opacity:.6; background: #9ca3af; cursor: default; }
        
        .error{ background:#ffe8e8; color:#b00020; border:1px solid #ffb3b3; padding:10px 12px; border-radius:12px; margin:8px 18px; white-space:pre-wrap }
        .refs{ margin-top:6px; padding-left:18px } .refs li{ font-size:12px; color:#374151 }
        
        @media (max-width:480px){
          .panel:not(.fullscreen){ right:12px; bottom:76px; width:94vw; height:72dvh; border-radius:0 !important; }
          .input{
            border-bottom-left-radius: 0;
            border-bottom-right-radius: 0;  
          }
          .typing {
            position: static;
            margin: 0 0 10px 11px;
          }
          @supports not (height: 100dvh) {
            @media (max-width:480px){
              .panel:not(.fullscreen){ height:72vh; } /* legacy */
            }
          }
        }
        `;
    
      const wrap = h('div', { class: 'widget' });
      const launcherIcon = h('span', { 'aria-hidden': 'true', id: 'launcherIcon' });
      const launcherBtn = h('button', { class: 'button', title: 'Chat' },
        launcherIcon, h('span', { class: 'badge', id: 'badge' }, '1')
      );
      const panel = h('div', { class: 'panel' });
      const head = h('div', { class: 'head', style: { background: cfg.headerGradient } },
        h('div', { class: 'title', style: { color: cfg.clinicNameColor } },
          h('img', { src: cfg.logoUrl, alt: '', style: 'width:45px;height:45px;margin:0; ' }),
          h('div', {}, h('h1', {}, cfg.labels.title), h('small', {}, cfg.labels.subtitle || ''))
        ),
        h('div', {},
          h('button', { class: 'close', id: 'closeBtn' },
            h('img', { src: (ASSETS + 'images/close.svg'), alt: 'Close', style: 'width:11px;height:11px;filter:invert(1);' })
          )
        )
      );
      const stream = h('div', { class: 'stream', id: 'stream' });
      const bottomSpacer = h('div', { id: '__bottom_spacer', style: 'height:1px; flex:0 0 auto;' });
      const typing = h('div', { class: 'typing', id: 'typing' },
        h('div', { class: 'dots' }, h('div', { class: 'dot' }), h('div', { class: 'dot' }), h('div', { class: 'dot' }))
      );
      const composer = h('div', { class: 'composer' });
      const form = h('form', { class: 'form', id: 'form' });
      const sendIcon = 'Send';
      const msgEl = h('textarea', {
        class: 'input',
        id: 'msg',
        placeholder: 'How can we help you today?',
        rows: '3',
        maxlength: '500',
        autocapitalize: 'sentences',
        autocomplete: 'on',
        autocorrect: 'on',
        enterkeyhint: 'send',   // iOS shows "Send" on the key
        inputmode: 'text'
      });
      
      const sendEl = h('button', { class: 'send', id: 'send', type: 'submit', title: 'Send', style: { background: cfg.sendButtonColor } }, sendIcon);
      // One fast-submit binding; keeps focus on the textarea and prevents duplicate submits
      function fastSubmit(e) {
        // Stop the default press/click lifecycle so we control submission timing
        if (e) e.preventDefault();

        // If we’re already mid-send (typing dots), ignore
        if (sendEl.disabled) return;

        // Submit once, through the single form handler
        try {
          // requestSubmit triggers the 'submit' event without blurring the textarea
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            // Fallback for very old engines
            form.dispatchEvent(new Event('submit', { cancelable: true }));
          }
        } catch {}

        // Immediately re-focus to keep the keyboard latched (particularly on iOS)
        forceFocusComposer();
      }

      // Keep focus: don’t let button mousedown steal it
      sendEl.addEventListener('mousedown', (e) => e.preventDefault());

      // Fast path on touch and pen/mouse down
      sendEl.addEventListener('touchstart', fastSubmit, { passive: false });
      sendEl.addEventListener('pointerdown', fastSubmit);


      
      function forceFocusComposer() {
        // try immediate focus without scrolling the page
        try { msgEl.focus({ preventScroll: true }); } catch { msgEl.focus(); }
      
        // put caret at end (helps Android keep IME alive)
        try {
          const len = msgEl.value.length;
          msgEl.setSelectionRange(len, len);
        } catch {}
      
        // iOS sometimes needs a short tick to keep the keyboard up
        if (typeof IS_IOS !== 'undefined' && IS_IOS) {
          setTimeout(() => {
            try { msgEl.focus({ preventScroll: true }); } catch { msgEl.focus(); }
            try {
              const len2 = msgEl.value.length;
              msgEl.setSelectionRange(len2, len2);
            } catch {}
            // if you have kbLatchUpdate from the iOS section, ping it:
            if (typeof kbLatchUpdate === 'function') kbLatchUpdate('refocus');
          }, 30);
        }
      }
      
      form.append(msgEl, sendEl);
      composer.append(form);
      panel.append(head, stream, typing, composer);
      wrap.append(launcherBtn, panel);
      shadow.append(style, wrap);
          // --- Dynamic positioning ----------------------------------------------
    const POSITION_OFFSETS = {
      'bottom-right': {
        container: { left: '', right: '20px', top: '', bottom: '20px' },
        panel:     { left: '', right: '20px', top: '', bottom: '84px' }
      },
      'bottom-left': {
        container: { left: '20px', right: '', top: '', bottom: '20px' },
        panel:     { left: '20px', right: '', top: '', bottom: '84px' }
      },
      'top-right': {
        container: { left: '', right: '20px', top: '20px', bottom: '' },
        panel:     { left: '', right: '20px', top: '84px', bottom: '' }
      },
      'top-left': {
        container: { left: '20px', right: '', top: '20px', bottom: '' },
        panel:     { left: '20px', right: '', top: '84px', bottom: '' }
      }
    };

    function applyPosition(pos) {
      const cfgPos = POSITION_OFFSETS[pos] || POSITION_OFFSETS['bottom-right'];

      // move the outer container (the launcher button)
      Object.assign(container.style, cfgPos.container);

      // move the panel (chat window)
      ['left','right','top','bottom'].forEach(s => panel.style[s] = '');  // reset
      Object.assign(panel.style, cfgPos.panel);
    }

    // apply initial position (options.position or default)
    applyPosition(cfg.position || 'bottom-right');
      stream.appendChild(bottomSpacer);
  
      let history = [];
      const badge = shadow.getElementById('badge');
      const state = { stickToBottom: true };
  
      const BOTTOM_EPS = 32;
      let readingHistory = false;
      
      function nearBottom(el) {
        return (el.scrollHeight - el.clientHeight - el.scrollTop) <= BOTTOM_EPS;
      }
      
      function smartScrollToBottom(force = false) {
        if (!force && (readingHistory || !state.stickToBottom)) return;
        stream.scrollTop = stream.scrollHeight;
      }
      

      
      // // Small helper UI
      // let jumpBtn = null;
      // function ensureJumpButton() {
      //   if (jumpBtn) return;
      //   jumpBtn = h('button', {
      //     id: '__jump_latest',
      //     style: {
      //       position: 'absolute', right: '16px', bottom: '64px', zIndex: 4,
      //       border: 'none', borderRadius: '14px', padding: '6px 10px',
      //       background: cfg.sendButtonColor, color: '#fff', boxShadow: '0 3px 10px rgba(0,0,0,.15)', display: 'none'
      //     },
      //     onclick: () => { readingHistory = false; smartScrollToBottom(true); toggleJumpButton(false); }
      //   }, 'Jump to latest');
      //   // Place it inside the panel shadow next to the stream
      //   panel.appendChild(jumpBtn);
      // }
      // function toggleJumpButton(show) {
      //   ensureJumpButton();
      //   jumpBtn.style.display = show ? 'block' : 'none';
      // }
    // ---- Platform flags & shared helpers (place near the top of buildWidget) ----
    const UA = navigator.userAgent || '';
    const IS_IOS = /iP(hone|ad|od)/.test(UA);
    const IS_ANDROID = /Android/i.test(UA);
    const VV = window.visualViewport || null;

    // one writer for --kb (shared)
    function writeKb(px) {
      document.documentElement.style.setProperty('--kb', String(Math.max(0, Math.round(px || 0))) + 'px');
      
    }

    // compute occlusion via VisualViewport (shared)
    function occludedPx() {
      if (!VV) return 0;
      return Math.max(0, window.innerHeight - VV.height - (VV.offsetTop || 0));
    }

    // tiny debounce util (shared)
    function debounce(fn, ms = 80) {
      let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    }

    // ---- iOS page scroll lock helpers ----
    let __prevHtmlOverflow = '';
    let __prevBodyOverflow = '';
    function lockPageScroll() {
      if (!IS_IOS) return;
      const html = document.documentElement, body = document.body;
      __prevHtmlOverflow = html.style.overflow;
      __prevBodyOverflow = body.style.overflow;
      html.style.overflow = 'hidden';
      body.style.overflow = 'hidden';
    }
    function unlockPageScroll() {
      if (!IS_IOS) return;
      const html = document.documentElement, body = document.body;
      html.style.overflow = __prevHtmlOverflow;
      body.style.overflow = __prevBodyOverflow;
    }
    // ---- iOS latched keyboard handling ----
    let __latched = false;
    let __lastPx = 0;
    let __zeroTimer = null;

    const OPEN_THRESH = 60;   // px → definitely open
    const CLOSE_THRESH = 30;  // px → maybe closing
    const CLOSE_GRACE_MS = 350;

    function kbLatchUpdate(_from) {
      const occ = occludedPx();

      if (occ >= OPEN_THRESH) {
        __latched = true;
        __lastPx = occ;
        if (__zeroTimer) { clearTimeout(__zeroTimer); __zeroTimer = null; }
        writeKb(__lastPx);
        return;
      }

      if (__latched && occ >= CLOSE_THRESH) {
        if (occ > 0) __lastPx = Math.max(__lastPx, occ);
        writeKb(__lastPx);
        return;
      }

      if (__latched && occ < CLOSE_THRESH) {
        if (!__zeroTimer) {
          __zeroTimer = setTimeout(() => {
            __latched = false;
            __lastPx = 0;
            writeKb(0);
            __zeroTimer = null;
          }, CLOSE_GRACE_MS);
        }
        writeKb(__lastPx || 0);
        return;
      }

      // not latched + small occlusion
      writeKb(0);
    }

    function kbOnFocus() {
      kbLatchUpdate('focus');
      // a few fast ticks to catch the open animation
      let ticks = 8;
      const id = setInterval(() => {
        kbLatchUpdate('focus-interval');
        if (--ticks <= 0) clearInterval(id);
      }, 50);
    }

    function kbOnBlur() {
      if (__zeroTimer) { clearTimeout(__zeroTimer); __zeroTimer = null; }
      __latched = false;
      __lastPx = 0;
      writeKb(0);
    }
// ---- iOS event wiring ----
    if (IS_IOS) {
      if (VV) {
        const pump = debounce(() => kbLatchUpdate('vv'), 80);
        VV.addEventListener('resize', pump, { passive: true });
        VV.addEventListener('scroll',  pump, { passive: true });
        kbLatchUpdate('init');
      }

      msgEl.addEventListener('focus', kbOnFocus, { passive: true });
      msgEl.addEventListener('blur',  kbOnBlur,  { passive: true });
      msgEl.addEventListener('input', () => kbLatchUpdate('input'), { passive: true });
      msgEl.addEventListener('touchmove', () => kbLatchUpdate('touchmove'), { passive: true });
      panel.addEventListener('transitionend', () => kbLatchUpdate('panel-transition'), { passive: true });

      window.addEventListener('orientationchange', () => {
        setTimeout(() => kbLatchUpdate('orientation'), 250);
      }, { passive: true });
    }
    // ---- ANDROID keyboard handling (keep) ----
    if (IS_ANDROID) {
      if (VV) {
        const onViewportChange = debounce(() => writeKb(occludedPx()), 120);
        VV.addEventListener('resize', onViewportChange, { passive: true });
        VV.addEventListener('scroll',  onViewportChange, { passive: true });
        writeKb(occludedPx());
      } else {
        let baseline = window.innerHeight;
        msgEl.addEventListener('focus', () => { baseline = window.innerHeight; }, { passive: true });
        window.addEventListener('resize', () => {
          if (document.activeElement === msgEl) writeKb(Math.max(0, baseline - window.innerHeight));
        }, { passive: true });
      }
      msgEl.addEventListener('blur', () => writeKb(0), { passive: true });
      window.addEventListener('orientationchange', () => {
        setTimeout(() => { if (VV) writeKb(occludedPx()); else writeKb(0); }, 250);
      }, { passive: true });
    }


      let _scrollQueued = false;
      function scheduleScrollToBottom({ force = false } = {}) {
        // Never fight the user unless explicitly forced (e.g., panel just opened)
        if (!force && (userScrolling || !state.stickToBottom)) return;
        if (_scrollQueued) return;
        _scrollQueued = true;
      
        requestAnimationFrame(() => {
          _scrollQueued = false;
          // Re-check right before moving
          if (!force && (userScrolling || !nearBottom(stream))) return;
          stream.scrollTop = stream.scrollHeight;
        });
      }
    
      stream.addEventListener('scroll', () => { state.stickToBottom = nearBottom(stream); }, { passive: true });
      // Only watch for added/removed message rows; ignore characterData + subtree noise
      new MutationObserver(() => scheduleScrollToBottom())
      .observe(stream, { childList: true }); // no subtree, no characterData
    
      function layoutStreamHeight() {
        // Ensure panel is in the DOM and sized
        const panelRect = panel.getBoundingClientRect();
        const headH    = head.getBoundingClientRect().height || 0;
        const compH    = composer.getBoundingClientRect().height || 0;
      
        // Leave at least some height so it never collapses
        const avail = Math.max(80, Math.round(panelRect.height - headH - compH));
        stream.style.height = avail + 'px';
      }
      
  
      function updateComposerHeightVar() {
        const h = Math.round(composer.getBoundingClientRect().height || 58);
        panel.style.setProperty('--composer-h', h + 'px');
      }
  
      msgEl.addEventListener('input', () => {
        msgEl.style.height = '54px';
        msgEl.style.height = Math.min(msgEl.scrollHeight, 110) + 'px';
        updateComposerHeightVar();
        scheduleScrollToBottom({force: true});
      });
  
      const MOBILE_MAX_WIDTH = 768;
      function isMobile() {
        try { return window.matchMedia(`(max-width:${MOBILE_MAX_WIDTH}px)`).matches; } catch {}
        return window.innerWidth <= MOBILE_MAX_WIDTH;
      }
  
      function toggle(open) {
        if (open === undefined) open = !panel.classList.contains('open');
        panel.classList.toggle('open', open);
        badge.style.display = 'none';
      
        if (open) {
          if (isMobile()) panel.classList.add('fullscreen');
          if (IS_IOS) lockPageScroll();          // <— iOS only
          layoutStreamHeight();
          if (IS_IOS && document.activeElement === msgEl) {
            // prime latch if already focused
            msgEl.dispatchEvent(new Event('focus'));
          }
          smartScrollToBottom(true);
        } else {
          panel.classList.remove('fullscreen');
          if (IS_IOS) unlockPageScroll();        // <— iOS only
          if (IS_ANDROID) writeKb(0);            // clear kb padding on close
        }
      
        launcherIcon.innerHTML = '';
        if (open) {
          launcherIcon.appendChild(h('img', { src: (ASSETS + 'images/close.svg'), alt: 'Close', style:'width:15px;height:15px;filter:brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(4543%) hue-rotate(92deg) brightness(107%) contrast(97%);'}));
        } else {
          launcherIcon.appendChild(h('img', { src: (ASSETS + 'images/up-arrow1.svg'), alt: 'Chat', style: 'width:20px;height:20px;' }));
        }
      }
      
  
      window.addEventListener('resize', () => {
        if (panel.classList.contains('open')) {
          layoutStreamHeight();                 // <-- ADD
          if (isMobile()) panel.classList.add('fullscreen');
          else panel.classList.remove('fullscreen');
        }
      });
  
      let userScrolling = false;
      let _userScrollCooloff = null;
      
      stream.addEventListener('scroll', () => {
        const atBottom = nearBottom(stream);
        state.stickToBottom = atBottom;
        if (!atBottom) {
            userScrolling = true;
            clearTimeout(_userScrollCooloff);
            _userScrollCooloff = setTimeout(() => { userScrolling = false; }, 200);
          }
      }, { passive: true });
      
      // Also mark during touch gestures (helps iOS momentum)
      stream.addEventListener('touchstart', () => { userScrolling = true; }, { passive: true });
      stream.addEventListener('touchend',   () => {
        clearTimeout(_userScrollCooloff);
        _userScrollCooloff = setTimeout(() => { userScrolling = false; }, 200);
      }, { passive: true });
      
  
      if (window.visualViewport) {
        const vv = window.visualViewport;
        let vvTimer;
        const onViewportChange = () => {
          clearTimeout(vvTimer);
          vvTimer = setTimeout(() => {
            layoutStreamHeight();                 // <-- ADD
            const occluded = Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0));
            document.documentElement.style.setProperty('--kb', occluded + 'px');
            updateComposerHeightVar();
      
            if (panel.classList.contains('open') && state.stickToBottom && !userScrolling) {            // <-- ADD
              smartScrollToBottom(true); 
            }
          }, 120);
        };
        vv.addEventListener('resize', onViewportChange);
        vv.addEventListener('scroll', onViewportChange);
      }
      
      window.addEventListener('orientationchange', () => {
        setTimeout(() => {
          if (panel.classList.contains('open') && state.stickToBottom && !userScrolling) {
            scheduleScrollToBottom({force: true}); // no force
          }
        }, 250);
      });
      
  
      function setBusy(on) {
        typing.style.display = on ? 'flex' : 'none';
        if (on) {
          updateComposerHeightVar();
          if (state.stickToBottom && !userScrolling) scheduleScrollToBottom();
        }
        sendEl.disabled = on;
      }
      
  
      function addMessage(text, who) {
        const row = h('div', { class: `row ${who}` });
        const bubble = h('div', { class: 'bubble' });
        bubble.appendChild(linkifyFragment(shadow, text || ''));
        row.appendChild(bubble);
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        row.appendChild(h('div', { class: 'time' }, timeStr));
      
        stream.insertBefore(row, bottomSpacer);
        // Only scroll if the user was already at bottom
        scheduleScrollToBottom({force: true}); // <-- no force
      }
      
  
      function showError(msg) {
        const errorRow = h('div', { class: 'row message' });
        errorRow.appendChild(h('div', { class: 'bubble', style: 'background-color:#ffe8e8; color:#b00020; border:1px solid #ffb3b3;' }, 'Error: ' + msg));
        stream.insertBefore(errorRow, bottomSpacer);
        scheduleScrollToBottom({force: true}); // <-- no force
      }
      
      
      launcherBtn.addEventListener('click', () => toggle());
      shadow.getElementById('closeBtn').addEventListener('click', () => toggle(false));
      msgEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (!sendEl.disabled) send();
        }
      });
      form.addEventListener('submit', e => { e.preventDefault(); if (!sendEl.disabled) send(); });
  
      async function send() {
        if (sendEl.disabled) return;
        const text = msgEl.value.trim();
        if (!text) return;
  
        const endpoint = cfg.endpoint;
        const id = cfg.id;
        if (!endpoint) return showError('Missing API endpoint configuration.');
        if (!id) return showError('Missing widget ID.');
  
        addMessage(text, 'user');
        history.push({ role: 'user', content: text });
        if (history.length > 16) history = history.slice(-16);
  
        msgEl.value = '';
        msgEl.dispatchEvent(new Event('input'));
        forceFocusComposer(); 
        setBusy(true);
  
        try {
          const payload = { message: text, history: history.slice(-8), id: id };
          const data = await callApi(endpoint, payload);
          if (cfg.verbose) console.log('[MedAssist] API response:', data);
  
          const n = normalize(data);
          if (n.status !== 'success' || !n.message) {
            showError(n.error || 'No response from server.');
            return;
          }
          addMessage(n.message, 'message');
          history.push({ role: 'assistant', content: n.message });
        } catch (err) {
          showError(err.message || 'Network error.');
        } finally {
          setBusy(false);
          forceFocusComposer(); 
        }
      }
  
      // --- TEST ONLY: delay the assistant's reply while showing the "..." typing dots ---
      window.__medassistDelayOnce = async function (ms = 600000) { // default 10 minutes
        if (sendEl.disabled) return;
  
        const text = msgEl.value.trim();
        const endpoint = cfg.endpoint;
        const id = cfg.id;
  
        if (!text) return showError('Please enter a message.');
        if (!endpoint) return showError('Missing API endpoint configuration.');
        if (!id) return showError('Missing widget ID.');
  
        // Show the user's message immediately (like normal)
        addMessage(text, 'user');
        history.push({ role: 'user', content: text });
        if (history.length > 16) history = history.slice(-16);
  
        // Clear input and show the typing dots
        msgEl.value = '';
        msgEl.dispatchEvent(new Event('input'));
        setBusy(true); // shows the 3-dot typing indicator
  
        // Wait, then actually call your API and render the assistant reply
        setTimeout(async () => {
          try {
            const payload = { message: text, history: history.slice(-8), id };
            const data = await callApi(endpoint, payload);
            const n = normalize(data);
  
            if (n.status !== 'success' || !n.message) {
              showError(n.error || 'No response from server.');
              return;
            }
  
            addMessage(n.message, 'message');
            history.push({ role: 'assistant', content: n.message });
          } catch (err) {
            showError(err.message || 'Network error.');
          } finally {
            setBusy(false);
            msgEl.focus();
          }
        }, ms);
      };
  
      async function callApi(url, body) {
        if (cfg.mock) return new Promise(r => setTimeout(() => r([{ answer: `[MOCK] ${body.message}` }]), 500));
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), cfg.timeout);
        try {
          const res = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: ac.signal
          });
          clearTimeout(t);
          if (!res.ok) throw new Error(`Server error ${res.status}`);
          return await res.json();
        } catch (e) {
          clearTimeout(t);
          if (e.name === 'AbortError') e.message = `Request timed out after ${Math.round(cfg.timeout / 1000)}s.`;
          throw e;
        }
      }
      
      launcherIcon.appendChild(h('img', { src: (ASSETS + 'images/up-arrow1.svg'), alt: 'Chat', style: 'width:20px;height:20px;' }));
  
      return {
        open: () => toggle(true),
        close: () => toggle(false),
        setOptions: (opts) => {
          Object.assign(cfg, opts || {});
          if (opts && 'position' in opts) applyPosition(cfg.position);
        },        
        setPosition: (pos) => {
          applyPosition(pos);
          // keep config in sync for future setOptions calls
          cfg.position = pos;
          // if panel is open and not mobile-fullscreen, ensure layout fits
          if (panel.classList.contains('open') && !panel.classList.contains('fullscreen')) {
            layoutStreamHeight();
          }
        },
        
      };
    }
  
    window.MedAssistWidget = {
      init(options) {
        ensureViewportMeta();
        const cfg = { ...DEFAULTS, ...(options || {}) };
        const { container, shadow } = createWidgetRoot(cfg.position);
        return buildWidget(shadow, options, container);
      }
    };
  
    try {
      const s = document.currentScript;
      if (s && s.getAttribute('data-auto-init') === '1') {
        const opts = s.getAttribute('data-options') ? JSON.parse(s.getAttribute('data-options')) : {};
        window.MedAssistWidget.init(opts);
      }
    } catch (e) { console.error("MedAssistWidget auto-init failed:", e); }
  
  })();