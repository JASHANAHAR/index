/* chat-widget.js — Floating bottom-right chat widget (iPhone-ready)
   - Sticky header
   - Input stays above keyboard (iOS + Android) using visualViewport
   - Safe-area padding (viewport-fit=cover)
   - Mobile = full-screen sheet; locks page scroll while open
*/

(function () {
  const WIDGET_ID = "pw-chat-widget";
  if (document.getElementById(WIDGET_ID)) return;

  // ---- iOS detection & helpers ----
  const ua = navigator.userAgent || "";
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes("Mac") && "ontouchend" in document); // iPadOS desktop UA

  // Ensure viewport-fit=cover for correct safe-area on iPhone
  (function ensureViewportFit() {
    const metas = [...document.querySelectorAll('meta[name="viewport"]')];
    if (metas.length === 0) {
      const m = document.createElement("meta");
      m.name = "viewport";
      m.content =
        "width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1";
      document.head.appendChild(m);
      return;
    }
    const m = metas[metas.length - 1];
    if (!/viewport-fit=cover/.test(m.content)) {
      m.content = m.content.replace(/\s+/g, ", ").replace(/,+/g, ", ");
      m.content += ", viewport-fit=cover";
    }
  })();

  // vh fix for old Safari toolbars
  function setVH() {
    document.documentElement.style.setProperty(
      "--pw-vh",
      window.innerHeight * 0.01 + "px"
    );
  }
  setVH();
  window.addEventListener("resize", setVH);

  // ---- DOM ----
  const root = document.createElement("div");
  root.id = WIDGET_ID;
  root.setAttribute("aria-live", "polite");
  if (isIOS) root.classList.add("pw-ios");
  root.innerHTML = `
    <button class="pw-launcher" aria-label="Open chat" title="Chat">
      <svg viewBox="0 0 24 24" class="pw-ic" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
    </button>

    <section class="pw-panel" role="dialog" aria-modal="true" aria-label="Chat">
      <header class="pw-header">
        <div class="pw-brand">
          <span class="pw-logo"></span>
          <strong class="pw-title">Prosper Pharmacy</strong>
        </div>
        <button class="pw-close" aria-label="Close chat">
          <svg viewBox="0 0 24 24" class="pw-ic" aria-hidden="true"><path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.71 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29l6.3 6.3 6.29-6.3z"/></svg>
        </button>
      </header>

      <main class="pw-body" tabindex="0">
        <div class="pw-msg pw-msg-bot">Hi! How can we help you today?</div>
      </main>

      <footer class="pw-input">
        <form class="pw-form">
          <input class="pw-field" type="text" placeholder="How can we help you today?" aria-label="Type your message" />
          <button class="pw-send" type="submit" aria-label="Send">Send</button>
        </form>
      </footer>
    </section>
  `;
  document.body.appendChild(root);

  // ---- Styles ----
  const css = `
  :root{
    --pw-green-1:#6bb36d;
    --pw-green-2:#8bc34a;
    --pw-bg:#ffffff;
    --pw-border:#e6e9ee;
    --pw-shadow:0 10px 30px rgba(0,0,0,.12);
    --pw-z: 2147483000;
    --pw-panel-w: 360px;
    --pw-panel-h: 520px;
    --pw-input-h: 56px;
    --pw-kb: 0px; /* keyboard overlap */
    --pw-safe-bottom: env(safe-area-inset-bottom, 0px);
  }

  #${WIDGET_ID}{
    position: fixed;
    bottom: 20px; right: 20px;
    z-index: var(--pw-z);
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans";
  }

  /* Launcher */
  #${WIDGET_ID} .pw-launcher{
    all: unset;
    display: grid; place-items: center;
    width: 56px; height: 56px; border-radius: 50%;
    background: linear-gradient(135deg,var(--pw-green-1),var(--pw-green-2));
    color:#fff; box-shadow: var(--pw-shadow); cursor: pointer;
  }
  #${WIDGET_ID} .pw-launcher .pw-ic{ width:28px; height:28px; fill: currentColor; }

  /* Panel */
  #${WIDGET_ID} .pw-panel{
    position: fixed;
    right: 20px; bottom: 20px;
    width: var(--pw-panel-w);
    height: var(--pw-panel-h);
    background: var(--pw-bg);
    border: 1px solid var(--pw-border);
    border-radius: 16px;
    box-shadow: var(--pw-shadow);
    display: grid;
    grid-template-rows: auto 1fr auto;
    overflow: hidden;
    transform: translateY(16px) scale(.98);
    opacity: 0; pointer-events: none;
    transition: transform .18s ease, opacity .18s ease;
  }
  #${WIDGET_ID}.pw-open .pw-panel{ transform: translateY(0) scale(1); opacity:1; pointer-events:auto; }

  /* Header */
  #${WIDGET_ID} .pw-header{
    position: sticky; top: 0;
    display:flex; align-items:center; justify-content:space-between;
    background: linear-gradient(90deg,var(--pw-green-1),var(--pw-green-2));
    color:#0b1a0b; min-height: 48px; padding: 8px 12px;
  }
  #${WIDGET_ID} .pw-brand{ display:flex; align-items:center; gap:10px; }
  #${WIDGET_ID} .pw-logo{ width:20px; height:20px; border-radius:4px; background:#e9f5ea; display:inline-block; }
  #${WIDGET_ID} .pw-title{ font-weight:700; }
  #${WIDGET_ID} .pw-close{ all: unset; cursor:pointer; padding:6px; border-radius:8px; }
  #${WIDGET_ID} .pw-close .pw-ic{ width:20px; height:20px; fill:#0b1a0b; }

  /* Messages */
  #${WIDGET_ID} .pw-body{
    overflow:auto; -webkit-overflow-scrolling:touch;
    padding: 12px;
    padding-bottom: calc(var(--pw-input-h) + 16px);
    background:#fafafa;
  }
  #${WIDGET_ID} .pw-msg{ max-width: 85%; margin: 6px 0; padding: 8px 10px; border-radius: 12px; line-height:1.35; font-size: 14px; }
  #${WIDGET_ID} .pw-msg-bot{ background:#eef7ee; border:1px solid #e0f0e1; }
  #${WIDGET_ID} .pw-msg-user{ background:#eaf0ff; border:1px solid #dae5ff; margin-left:auto; }

  /* Input (sticks & lifts above keyboard) */
  #${WIDGET_ID} .pw-input{
    position: sticky; bottom: 0;
    background:#fff; border-top:1px solid var(--pw-border);
    transform: translateY(calc(-1 * var(--pw-kb)));
    padding-bottom: calc(8px + var(--pw-safe-bottom));
  }
  #${WIDGET_ID} .pw-form{ display:flex; gap:8px; padding: 8px; }
  #${WIDGET_ID} .pw-field{
    flex:1; min-height:40px; padding:10px 12px; border-radius:12px;
    border:1px solid #dfe3ea; outline:none; background:#fafcf8;
  }
  #${WIDGET_ID} .pw-send{
    all: unset; cursor:pointer; min-width:68px;
    background: linear-gradient(135deg,var(--pw-green-1),var(--pw-green-2));
    color:#fff; padding:0 14px; border-radius:12px; display:grid; place-items:center;
  }

  /* Mobile: full-screen sheet */
  @media (max-width: 480px){
    #${WIDGET_ID}{ right: 12px; bottom: 12px; }
    #${WIDGET_ID} .pw-panel{
      right: 0; bottom: 0; left: 0;
      width: 100vw;
      height: calc(var(--pw-vh, 1vh) * 100); /* robust iOS height */
      border-radius: 0; border: none;
    }
  }

  /* When iOS: reduce spring/bounce */
  #${WIDGET_ID}.pw-open .pw-panel, #${WIDGET_ID} .pw-body{ overscroll-behavior: contain; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ---- Behavior ----
  const launcher = root.querySelector(".pw-launcher");
  const panel = root.querySelector(".pw-panel");
  const closeBtn = root.querySelector(".pw-close");
  const bodyEl = root.querySelector(".pw-body");
  const inputWrap = root.querySelector(".pw-input");
  const form = root.querySelector(".pw-form");
  const field = root.querySelector(".pw-field");
  const docEl = document.documentElement;
  let pageScrollY = 0;

  function lockBodyScroll() {
    pageScrollY = window.scrollY || document.documentElement.scrollTop;
    document.body.style.position = "fixed";
    document.body.style.top = -pageScrollY + "px";
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
  }
  function unlockBodyScroll() {
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.left = "";
    document.body.style.right = "";
    document.body.style.width = "";
    window.scrollTo(0, pageScrollY);
  }

  function openChat() {
    root.classList.add("pw-open");
    panel.setAttribute("aria-hidden", "false");
    lockBodyScroll();
    setTimeout(() => {
      field.focus({ preventScroll: true });
      // iOS: ensure the field is visible when keyboard opens
      field.scrollIntoView({ block: "nearest", behavior: "instant" });
      updateKeyboardOffset();
      scrollToBottom();
    }, 120);
  }
  function closeChat() {
    root.classList.remove("pw-open");
    panel.setAttribute("aria-hidden", "true");
    unlockBodyScroll();
    // reset keyboard offset to avoid ghost spacing later
    docEl.style.setProperty("--pw-kb", "0px");
  }
  function scrollToBottom() {
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  launcher.addEventListener("click", openChat);
  closeBtn.addEventListener("click", closeChat);

  // Demo send — replace with your own handler
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = field.value.trim();
    if (!text) return;
    appendMsg(text, "user");
    field.value = "";
    setTimeout(() => appendMsg("Thanks! We’ll get back to you shortly.", "bot"), 300);
  });

  function appendMsg(text, who = "bot") {
    const div = document.createElement("div");
    div.className = `pw-msg ${who === "user" ? "pw-msg-user" : "pw-msg-bot"}`;
    div.textContent = text;
    bodyEl.appendChild(div);
    scrollToBottom();
  }

  // ---- Keyboard awareness (iOS + Android) ----
  const vv = window.visualViewport;

  function updateKeyboardOffset() {
    // On iOS Safari, the viewport is shifted; use offsetTop too.
    let kb = 0;
    if (vv) {
      const used = vv.height + vv.offsetTop; // visible height incl. top toolbar shift
      kb = Math.max(0, Math.round(window.innerHeight - used));
    }
    docEl.style.setProperty("--pw-kb", kb + "px");

    // Ensure message list keeps clear of the composer
    const h = Math.round(inputWrap.getBoundingClientRect().height);
    docEl.style.setProperty("--pw-input-h", h + "px");

    // Keep latest messages visible
    scrollToBottom();
  }

  if (vv) {
    vv.addEventListener("resize", updateKeyboardOffset);
    vv.addEventListener("scroll", updateKeyboardOffset);
  }
  window.addEventListener("orientationchange", () => setTimeout(updateKeyboardOffset, 250));
  window.addEventListener("resize", updateKeyboardOffset);
  inputWrap.addEventListener("focusin", updateKeyboardOffset);
  inputWrap.addEventListener("focusout", () => {
    // When keyboard closes
    setTimeout(updateKeyboardOffset, 100);
  });

  // Esc to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && root.classList.contains("pw-open")) closeChat();
  });
})();
