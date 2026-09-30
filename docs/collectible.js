/* global window, document, crypto, TextEncoder, Blob, URL, localStorage */
/**
 * Objetos coleccionables: una sorpresa para el equipo.
 *
 * El repo es público, así que acá no hay nombres ni fotos a la vista. La
 * imagen viaja cifrada (AES-GCM) con una llave de contenido, y esa llave va
 * "envuelta" una vez por cada usuario habilitado: cada uno la abre con una
 * clave que sale de su propio usuario. Se reconoce a cada persona por un hash.
 *
 * La tarjeta queda en pantalla hasta que se acepta (no se cierra con Esc ni
 * clickeando afuera). Después queda una estrellita en el avatar del menú para
 * volver a mirarla.
 */
(function () {
  const W = (window.W = window.W || {});

  const ITEM = { id: 1, file: 'c/1.bin', title: 'Santa Dai', rarity: 'Legendario' };
  // Saludo propio para quien inspiró la tarjeta; el resto ve su nombre.
  const HELLO = { '70eae642ed37c4f7': 'Hola Dai' };
  // Llave de contenido envuelta por usuario (hash del usuario -> iv + llave cifrada).
  const KEYS = {
    '4f06eb7853b0cfb9': 'dtkTyEvsjAZ94ifQqX8xuBOlQgPLZYKGzE2nJ4fhM3nFwnqCPupuPMzUxD7apANXoL1zo0L9Jc63WB8k',
    '70eae642ed37c4f7': 'qhSkdmET6zg8eNWR67tWsqwYfoLEeDn75wQEay16RCViPCYWu5azBllSlW1yf/CvseLs4eDYaD5u+41h',
    '33e048eb83fb888c': 'u4mbsUrKmfNKKkSnRMbQFnO8F4L5kr7Drj2Rs0CeheALGThB+XYNwhUyVJxhPRftRsG9G9nBvHd+VozS',
    'd0d0791f9b7bd1a9': 'ZAoT/1epNX++b6Zbt1G1NJTKuYHBjGcof9MEAe32rAWEHvfwud1DkogBWKA5pZjQQxhEgaUDvSiHfA0U',
    '49142fdfb9ce4542': 'rme6n62oCqJ0bRxwETay6rJaaT8vMUrPPLwaVXVcfc5jLR0lVIJxjv3mHt4NJ83dTyXdTfkNCk4hwfJs',
    '93f49132b0ad9fef': 'kKI3f7wSlco1MbxT168m3RDUpaDBBYXTV8Inx8IBCSxFRkQxDDwVOXn2Q+NVJFXnt0RjUBfy7HHNqNru',
    '04b4648aaf85af1f': 'ASTqKSg3vVnCjRi6nDF742LM0qHGWQbABArZ4iZLIB4SlAbI+xIn+c8CVGvbZs0gBhYsh6/KKDMkPp37',
    'c95cf9508de7bb48': 'Dfsfoqouso5IzygVNLRgPaZ/IZKnIuG26vxuqViVmdRDML6W3aKryff3gfSJHbtiI5NUq31IwQtiNG2J',
    '37e838e1ad067f78': '389i5pIxLkR34eQsVIfGapCjgf2GSVF22w4zmc8ZBoaBBRNX2lMebLc4ZoZqHOUS2M6iQwnFT7ru8Xa9',
    'd8a5ee60ac5bf0c0': '/23P7C7X2EO8ubtj6R5InsJX5lg8MNKHuEz/CunM4fdY+akYNA5Vb3hkHJx83Gr/D3yLJU4s6awTct2B',
    '67f8e339b263e056': 'tEino1Ymwg0GzpmJC1REbZ0DFzxpe4IX+FlpIjeW9+e7UcQmcfLeq7QrUZlYMsMPRmYi9/ZwWw/IyLOF',
    '73b16b5bf130c665': 'RNnoGNULfiyWLf9KDflvFIjQ50IKoBrzlSmwQEGT7dfOYWR9DpjW83WHvB1RSzMcSyfJjyBKPZL6y7dV',
    'cc65cb18afa75aeb': '/O6g3YnvrolWgDKUCBdH5HDxnGuDbWK97D/53fAE3y2txy33Fn02sc+B8faIIiEBXvHrey8o8gyUfkat',
    '7547699fbd589f89': '1zysuruZkayJrl5kDALDxh5QPt71g/aNxxOdX51JhV/2OAKcGZXosBD5lpdaRdfIbPfi/9EixIIca5zW',
    '8cb04a9f7e1339aa': '0y/UtnqOxreSvTfXFwNzjVBbMhFtLPHPwcwMCdAmewUY2mAiHuSFvlmvEIIZXsPmUR5MMJYOPjaQOubT',
    'd67f7c55fb0c79b1': 'abkzKs+xENuoOf47ATeFc3iWWzKF3j/Waen3T8Pk87PYHDQBy6cEwYc482FaqIJMNLnvL8o0OA89Zahl',
    '2c64c57c206847a3': 'xWJAdfZo92sq2RGdoRmHxScRAOu6QYAyyLZmy6XuCU5TiJmPo8vrRSOq5WW0qEYfS8SlzTd4VMjHIjIC',
    '5a01620f32820816': '0vqrM+1x+2i1NUQMPRiltydxIr4vAYewKJOkTB9qoTCZonW6Ppu2O9yZGZ4Cf76xzrUr/LuhF8RB6Wu4',
    '5179b5ff390d2ef5': 'RVee89YIiv+1GyCjcd+Zjt4eRCH0uBhTNtE38at6I5uF+2Gc6fW8eLxzMZ6AvcPmH8msDebcDbdPWbiL',
    '24a22e309d3c726b': 'QqWL/LxhdtZbxrVkkCJMJ+DphLKWDeawKUzIG3szRLBkoGGXSi1PpBuvbqYM3sd/KJDWMpf+KjURy/zi',
    '8aa801e342b64e27': 'wJ6vVzSAJEPg3zbzw/f+n251w4rHck8CFff/weiwZVtZ3fiIzfbaNurXc1PHUNmMYWOqEpw5kconjye0',
    'f08648e2e9694ef1': 'jzdQrXffomBVQzmBhAfzkJL/CODW7NtNgcZ/3fhtyzUFbQNN59uB3lpcYIRHpC1lHByY6MSfvM2rMeeD',
  };

  const enc = new TextEncoder();
  const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const seenKey = (h, id) => `webdash:collect:${id}:${h}`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin storage: se vuelve a mostrar */ } },
  };

  const b64 = (x) => Uint8Array.from(atob(x), (ch) => ch.charCodeAt(0));

  async function decryptImage(file, username, wrapped) {
    const res = await fetch(file, { cache: 'force-cache' });
    if (!res.ok) throw new Error('no file');
    const buf = new Uint8Array(await res.arrayBuffer());
    const w = b64(wrapped);
    const userKey = await crypto.subtle.importKey('raw', await sha(`webdash-collectible:v1:${username}`), 'AES-GCM', false, ['decrypt']);
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: w.slice(0, 12) }, userKey, w.slice(12));
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
    return URL.createObjectURL(new Blob([plain], { type: 'image/webp' }));
  }

  function injectCss() {
    if (document.getElementById('clx-css')) return;
    const st = document.createElement('style');
    st.id = 'clx-css';
    st.textContent = `
.clx { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; overflow: hidden;
  background: radial-gradient(ellipse at center, #3b1d7a 0%, #1a0b3d 55%, #07021a 100%); font-family: inherit; color: #fff; }
.clx * { box-sizing: border-box; }
.clx-rays { position: absolute; left: 50%; top: 50%; width: 220vmax; height: 220vmax; margin: -110vmax 0 0 -110vmax; opacity: 0;
  background: repeating-conic-gradient(from 0deg, rgba(255,215,120,.16) 0deg 7deg, transparent 7deg 18deg);
  animation: clxSpin 26s linear infinite, clxFadeIn 1s 2.4s forwards; }
.clx-glow { position: absolute; width: 70vmin; height: 70vmin; border-radius: 50%; background: radial-gradient(circle, rgba(255,210,110,.55), rgba(160,90,255,.25) 45%, transparent 70%);
  filter: blur(10px); opacity: 0; animation: clxFadeIn .8s 2.5s forwards, clxPulse 3s 3.3s ease-in-out infinite; }
.clx-bars { position: absolute; inset: 0; pointer-events: none; }
.clx-bars i { position: absolute; left: 0; right: 0; height: 12.5%; background: #000; transform: scaleX(0); }
.clx-bars i:nth-child(odd) { transform-origin: left; animation: clxBar 1.1s cubic-bezier(.7,0,.3,1) forwards; }
.clx-bars i:nth-child(even) { transform-origin: right; animation: clxBar 1.1s cubic-bezier(.7,0,.3,1) forwards; }
.clx-flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; animation: clxFlash 1s .05s, clxBurst .9s 2.35s; }
.clx-ball { position: absolute; width: 96px; height: 96px; border-radius: 50%; top: -140px;
  background: linear-gradient(#e8283c 0 46%, #111 46% 54%, #f5f5f5 54% 100%); box-shadow: inset -8px -10px 0 rgba(0,0,0,.18), 0 12px 30px rgba(0,0,0,.5);
  animation: clxDrop .8s 1.05s cubic-bezier(.3,1.5,.6,1) forwards, clxWobble .9s 1.65s ease-in-out 1, clxPop .25s 2.35s forwards; }
.clx-ball::after { content: ''; position: absolute; left: 50%; top: 50%; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%;
  background: #f5f5f5; border: 6px solid #111; box-shadow: 0 0 0 3px #f5f5f5 inset; animation: clxBlink .3s 1.9s 3; }
.clx-sparks { position: absolute; inset: 0; pointer-events: none; }
.clx-sparks i { position: absolute; width: var(--s); height: var(--s); left: var(--x); top: var(--y); opacity: 0;
  background: radial-gradient(circle, #fff 0 20%, var(--c) 40%, transparent 70%); border-radius: 50%;
  animation: clxTwinkle var(--d) var(--dl) ease-in-out infinite; }
.clx-conf { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.clx-conf i { position: absolute; top: -20px; left: var(--x); width: 8px; height: 14px; background: var(--c); opacity: 0; border-radius: 2px;
  animation: clxFall var(--d) var(--dl) linear infinite; }
.clx-stage { position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 1rem; padding: 1rem; max-height: 100vh; }
.clx-hello { text-align: center; opacity: 0; animation: clxUp .6s 2.7s forwards; }
.clx-hello h2 { margin: 0; font-size: clamp(1.8rem, 5vw, 2.8rem); font-weight: 800; letter-spacing: -.02em;
  background: linear-gradient(90deg, #ffe08a, #fff, #ffc95a, #fff, #ffe08a); background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: clxShine 3s linear infinite; text-shadow: 0 0 30px rgba(255,210,110,.25); }
.clx-hello p { margin: .3rem 0 0; font-size: clamp(.95rem, 2.4vw, 1.15rem); color: #e9e2ff; }
.clx-hello p b { color: #ffd66e; }
.clx-cardwrap { margin-top: .6rem; perspective: 1200px; opacity: 0; animation: clxCardIn 1.1s 2.45s cubic-bezier(.2,1.2,.4,1) forwards; }
.clx-card { position: relative; width: min(300px, 62vw, calc((100vh - 280px) * .75)); aspect-ratio: 438 / 582; border-radius: 16px; transform-style: preserve-3d;
  transition: transform .15s ease-out; box-shadow: 0 0 0 3px #f7d774, 0 0 40px rgba(255,210,110,.6), 0 30px 60px rgba(0,0,0,.6);
  animation: clxFloat 4s 3.6s ease-in-out infinite; }
.clx-card img { width: 100%; height: 100%; object-fit: cover; border-radius: 16px; display: block; }
.clx-holo { position: absolute; inset: 0; border-radius: 16px; pointer-events: none; mix-blend-mode: color-dodge; opacity: .5;
  background: linear-gradient(115deg, transparent 20%, rgba(255,0,180,.35) 36%, rgba(0,220,255,.35) 46%, rgba(255,240,0,.35) 56%, transparent 72%);
  background-size: 250% 250%; background-position: var(--hx, 50%) var(--hy, 50%); animation: clxHolo 5s ease-in-out infinite; }
.clx-shine { position: absolute; inset: 0; border-radius: 16px; pointer-events: none;
  background: radial-gradient(circle at var(--mx, 50%) var(--my, 30%), rgba(255,255,255,.45), transparent 45%); mix-blend-mode: overlay; }
.clx-tag { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); white-space: nowrap; font-size: .7rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase;
  background: linear-gradient(90deg, #f7c948, #ffe9a6, #f7c948); color: #3b2300; padding: .28rem .8rem; border-radius: 20px; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
.clx-btn { opacity: 0; animation: clxUp .5s 3.4s forwards; border: none; cursor: pointer; font: inherit; font-weight: 800; font-size: 1rem;
  padding: .9rem 1.6rem; border-radius: 40px; color: #3b2300; background: linear-gradient(90deg, #f7c948, #ffe9a6, #f7c948); background-size: 200% auto;
  box-shadow: 0 8px 26px rgba(247,201,72,.45), inset 0 -3px 0 rgba(0,0,0,.12); transition: transform .12s; }
.clx-btn { animation: clxUp .5s 3.4s forwards, clxShine 2.5s 3.9s linear infinite; }
.clx-btn:hover { transform: translateY(-2px) scale(1.03); }
.clx-btn:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
.clx.bye .clx-cardwrap { animation: clxAway .7s cubic-bezier(.6,0,.4,1) forwards; }
.clx.bye { animation: clxOut .5s .45s forwards; }
.clx.quick * { animation-delay: 0s !important; }
.clx.quick .clx-ball, .clx.quick .clx-bars, .clx.quick .clx-flash { display: none; }
.nav-av { position: relative; }
.nav-av .clx-star { position: absolute; right: -4px; bottom: -4px; width: 17px; height: 17px; border-radius: 50%; background: #f7c948; color: #3b2300;
  font-size: .62rem; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 0 2px #1a1446; cursor: pointer; animation: clxPulse 2.4s ease-in-out infinite; }
@keyframes clxSpin { to { transform: rotate(360deg); } }
@keyframes clxFadeIn { to { opacity: 1; } }
@keyframes clxPulse { 50% { transform: scale(1.08); } }
@keyframes clxBar { 0% { transform: scaleX(0); } 45%, 60% { transform: scaleX(1); } 100% { transform: scaleX(1); opacity: 0; } }
@keyframes clxFlash { 0%, 20%, 40% { opacity: 0; } 10%, 30% { opacity: .9; } 100% { opacity: 0; } }
@keyframes clxBurst { 0% { opacity: 0; } 25% { opacity: 1; } 100% { opacity: 0; } }
@keyframes clxDrop { to { top: calc(50% - 48px); } }
@keyframes clxWobble { 0%, 100% { transform: rotate(0); } 20% { transform: rotate(-22deg); } 45% { transform: rotate(18deg); } 70% { transform: rotate(-10deg); } }
@keyframes clxBlink { 50% { background: #ffe066; box-shadow: 0 0 18px #ffe066; } }
@keyframes clxPop { to { transform: scale(2.2); opacity: 0; } }
@keyframes clxTwinkle { 0%, 100% { opacity: 0; transform: scale(.4); } 50% { opacity: 1; transform: scale(1); } }
@keyframes clxFall { 0% { opacity: 0; transform: translateY(0) rotate(0); } 10% { opacity: 1; } 100% { opacity: .9; transform: translateY(110vh) rotate(720deg); } }
@keyframes clxUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
@keyframes clxShine { to { background-position: 200% center; } }
@keyframes clxCardIn { 0% { opacity: 0; transform: rotateY(540deg) scale(.2); } 70% { opacity: 1; } 100% { opacity: 1; transform: rotateY(0) scale(1); } }
@keyframes clxFloat { 50% { translate: 0 -8px; } }
@keyframes clxHolo { 50% { background-position: 100% 100%; } }
@keyframes clxAway { to { transform: translate(-40vw, 40vh) scale(.05) rotate(-30deg); opacity: 0; } }
@keyframes clxOut { to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .clx *, .clx { animation-duration: .01s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; }
  .clx-ball, .clx-bars, .clx-flash, .clx-conf { display: none; }
}`;
    document.head.appendChild(st);
  }

  function particles() {
    const cs = ['#ffd66e', '#ff7ad9', '#7ae0ff', '#b69cff', '#ffffff'];
    const r = (a, b) => a + Math.random() * (b - a);
    const sparks = Array.from({ length: 46 }, () =>
      `<i style="--x:${r(0, 100)}%;--y:${r(0, 100)}%;--s:${r(6, 18)}px;--c:${cs[Math.floor(r(0, 5))]};--d:${r(1.6, 3.4)}s;--dl:${r(2.4, 5)}s"></i>`).join('');
    const conf = Array.from({ length: 60 }, () =>
      `<i style="--x:${r(0, 100)}%;--c:${cs[Math.floor(r(0, 5))]};--d:${r(3.5, 7)}s;--dl:${r(2.5, 8)}s"></i>`).join('');
    return { sparks, conf };
  }

  function show(item, img, { quick = false, onAccept } = {}) {
    injectCss();
    const { sparks, conf } = particles();
    const el = document.createElement('div');
    el.className = `clx${quick ? ' quick' : ''}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', `${item.hello}, desbloqueaste tu primer objeto coleccionable`);
    el.innerHTML = `
      <div class="clx-rays"></div><div class="clx-glow"></div>
      <div class="clx-sparks">${sparks}</div><div class="clx-conf">${conf}</div>
      <div class="clx-bars">${'<i></i>'.repeat(8)}</div>
      <div class="clx-ball"></div>
      <div class="clx-flash"></div>
      <div class="clx-stage">
        <div class="clx-hello"><h2>¡${item.hello}!</h2><p>Desbloqueaste tu <b>primer objeto coleccionable</b></p></div>
        <div class="clx-cardwrap"><div class="clx-card">
          <img src="${img}" alt="${item.title}" draggable="false"/>
          <div class="clx-holo"></div><div class="clx-shine"></div>
          <span class="clx-tag">★ Objeto #00${item.id} · ${item.rarity} ★</span>
        </div></div>
        <button class="clx-btn" type="button">Aceptar objeto coleccionable</button>
      </div>`;
    el.querySelectorAll('.clx-bars i').forEach((b, i) => { b.style.top = `${i * 12.5}%`; b.style.animationDelay = `${i * 0.04}s`; });
    document.body.appendChild(el);

    // La tarjeta sigue al mouse (o al dedo): efecto de carta holográfica.
    const card = el.querySelector('.clx-card');
    const tilt = (x, y) => {
      const b = card.getBoundingClientRect();
      const px = Math.min(1, Math.max(0, (x - b.left) / b.width));
      const py = Math.min(1, Math.max(0, (y - b.top) / b.height));
      card.style.transform = `rotateY(${(px - 0.5) * 24}deg) rotateX(${(0.5 - py) * 20}deg)`;
      card.style.setProperty('--mx', `${px * 100}%`); card.style.setProperty('--my', `${py * 100}%`);
      card.style.setProperty('--hx', `${px * 100}%`); card.style.setProperty('--hy', `${py * 100}%`);
    };
    el.addEventListener('pointermove', (e) => tilt(e.clientX, e.clientY));
    el.addEventListener('pointerleave', () => { card.style.transform = ''; });

    // Solo se cierra aceptando: ni Esc ni click afuera.
    const trap = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } };
    document.addEventListener('keydown', trap, true);
    const btn = el.querySelector('.clx-btn');
    setTimeout(() => btn.focus({ preventScroll: true }), quick ? 50 : 3500);
    btn.addEventListener('click', () => {
      document.removeEventListener('keydown', trap, true);
      el.classList.add('bye');
      if (onAccept) onAccept();
      setTimeout(() => el.remove(), 1000);
    });
  }

  function addStar(item, img) {
    const av = document.getElementById('nav-av');
    if (!av || av.querySelector('.clx-star')) return;
    injectCss();
    const s = document.createElement('span');
    s.className = 'clx-star';
    s.textContent = '★';
    s.title = 'Tu objeto coleccionable';
    s.addEventListener('click', (e) => { e.stopPropagation(); show(item, img, { quick: true }); });
    av.appendChild(s);
  }

  /** Se llama con { username } apenas se sabe quién está logueado. */
  W.collectible = async function (me) {
    try {
      if (!me?.username || !window.crypto?.subtle) return;
      const h = hex(await sha(`webdash-user:${me.username}`)).slice(0, 16);
      if (!KEYS[h]) return;
      const first = String(me.name || '').split(/\s+/)[0];
      const item = { ...ITEM, hello: HELLO[h] || (first && first !== me.username ? `Hola ${first}` : 'Hola') };
      const img = await decryptImage(item.file, me.username, KEYS[h]);
      const k = seenKey(h, item.id);
      if (store.get(k)) { addStar(item, img); return; }
      show(item, img, { onAccept: () => { store.set(k, new Date().toISOString()); addStar(item, img); } });
    } catch { /* sin sorpresa, el dashboard sigue igual */ }
  };
})();
