(function () {
  'use strict';

  if (window.__ppPixelCatMounted || window.PAUSENPLAY_DISABLE_PIXEL_CAT) return;
  window.__ppPixelCatMounted = true;

  var HIDE_KEY = 'pausenplay.pixelCat.hidden';
  var root = document.createElement('div');
  root.className = 'pp-pixel-cat-root';
  root.setAttribute('data-state', 'idle');
  root.setAttribute('data-blink', 'false');
  root.setAttribute('data-sleeping', 'false');

  root.innerHTML =
    '<button type="button" class="pp-pixel-cat-show" aria-label="Show orange pixel cat widget" hidden>Show cat</button>' +
    '<div class="pp-pixel-cat-shell">' +
      '<button type="button" class="pp-pixel-cat-hide" aria-label="Hide orange pixel cat widget">Hide</button>' +
      '<button type="button" class="pp-pixel-cat" aria-label="Orange pixel cat. Press Enter or Space to pet the cat.">' +
        '<svg viewBox="0 0 96 96" role="presentation" aria-hidden="true">' +
          '<rect x="20" y="22" width="56" height="48" fill="#ff7a1f"/>' +
          '<rect x="16" y="26" width="4" height="38" fill="#d44f00"/>' +
          '<rect x="76" y="26" width="4" height="38" fill="#d44f00"/>' +
          '<polygon points="20,24 32,8 38,24" fill="#ff7a1f"/>' +
          '<polygon points="76,24 64,8 58,24" fill="#ff7a1f"/>' +
          '<polygon points="25,21 32,12 35,21" fill="#ffd3a4"/>' +
          '<polygon points="71,21 64,12 61,21" fill="#ffd3a4"/>' +
          '<rect x="30" y="42" width="36" height="18" fill="#ffd3a4"/>' +
          '<g class="pp-cat-eye-open">' +
            '<rect x="33" y="33" width="10" height="8" fill="#fff9eb"/>' +
            '<rect x="53" y="33" width="10" height="8" fill="#fff9eb"/>' +
            '<g class="pp-cat-pupils">' +
              '<rect x="37" y="35" width="3" height="4" fill="#101010"/>' +
              '<rect x="57" y="35" width="3" height="4" fill="#101010"/>' +
            '</g>' +
          '</g>' +
          '<g class="pp-cat-eye-closed">' +
            '<rect x="33" y="36" width="10" height="2" fill="#101010"/>' +
            '<rect x="53" y="36" width="10" height="2" fill="#101010"/>' +
          '</g>' +
          '<rect x="46" y="44" width="4" height="3" fill="#101010"/>' +
          '<rect x="42" y="49" width="4" height="2" fill="#101010"/>' +
          '<rect x="50" y="49" width="4" height="2" fill="#101010"/>' +
          '<rect x="26" y="70" width="12" height="8" fill="#ff7a1f"/>' +
          '<rect x="58" y="70" width="12" height="8" fill="#ff7a1f"/>' +
          '<rect x="72" y="58" width="16" height="4" fill="#ff7a1f"/>' +
          '<rect x="84" y="50" width="4" height="8" fill="#ff7a1f"/>' +
        '</svg>' +
      '</button>' +
      '<span class="pp-cat-zzz" aria-hidden="true">Zz</span>' +
    '</div>';

  document.body.appendChild(root);

  var shell = root.querySelector('.pp-pixel-cat-shell');
  var cat = root.querySelector('.pp-pixel-cat');
  var hideBtn = root.querySelector('.pp-pixel-cat-hide');
  var showBtn = root.querySelector('.pp-pixel-cat-show');

  var state = {
    hidden: false,
    sleeping: false,
    reducedMotion: false,
    lastActivityAt: Date.now(),
    modeTimer: null,
    blinkTimer: null
  };

  function setHidden(hidden) {
    state.hidden = hidden;
    root.setAttribute('data-hidden', hidden ? 'true' : 'false');
    shell.hidden = hidden;
    showBtn.hidden = !hidden;
    if (hidden) localStorage.setItem(HIDE_KEY, '1');
    else localStorage.removeItem(HIDE_KEY);
  }

  function setStateMode(mode, ttl) {
    root.setAttribute('data-state', mode);
    clearTimeout(state.modeTimer);
    if (ttl) {
      state.modeTimer = setTimeout(function () {
        root.setAttribute('data-state', 'idle');
      }, ttl);
    }
  }

  function setSleeping(sleeping) {
    state.sleeping = sleeping;
    root.setAttribute('data-sleeping', sleeping ? 'true' : 'false');
    if (sleeping) {
      setStateMode('sleep');
      root.setAttribute('data-blink', 'false');
    } else if (root.getAttribute('data-state') === 'sleep') {
      setStateMode('idle');
    }
  }

  function markActivity() {
    state.lastActivityAt = Date.now();
    if (state.sleeping) setSleeping(false);
  }

  function blinkOnce() {
    if (state.hidden || state.sleeping || state.reducedMotion) return;
    root.setAttribute('data-blink', 'true');
    setTimeout(function () { root.setAttribute('data-blink', 'false'); }, 130);
  }

  function scheduleBlink() {
    clearTimeout(state.blinkTimer);
    var delay = 2200 + Math.floor(Math.random() * 2600);
    state.blinkTimer = setTimeout(function () {
      blinkOnce();
      scheduleBlink();
    }, delay);
  }

  function updateEyeTracking(clientX, clientY) {
    if (state.hidden || state.sleeping || state.reducedMotion) return;
    var rect = cat.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var dx = (clientX - cx) / Math.max(rect.width, 1);
    var dy = (clientY - cy) / Math.max(rect.height, 1);
    var eyeX = Math.max(-2.6, Math.min(2.6, dx * 7));
    var eyeY = Math.max(-2.2, Math.min(2.2, dy * 7));
    root.style.setProperty('--pp-eye-x', eyeX.toFixed(2) + 'px');
    root.style.setProperty('--pp-eye-y', eyeY.toFixed(2) + 'px');
  }

  function reactToTyping(event) {
    if (state.hidden || state.sleeping) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!(event.key.length === 1 || event.key === 'Backspace' || event.key === 'Enter')) return;
    markActivity();
    setStateMode('typing', 520);
  }

  function petReaction() {
    markActivity();
    setStateMode('happy', 780);
  }

  var media = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function setReducedMotion(on) {
    state.reducedMotion = !!on;
    root.setAttribute('data-reduced-motion', on ? 'true' : 'false');
  }
  if (media) {
    setReducedMotion(media.matches);
    if (media.addEventListener) media.addEventListener('change', function (ev) { setReducedMotion(ev.matches); });
    else if (media.addListener) media.addListener(function (ev) { setReducedMotion(ev.matches); });
  }

  hideBtn.addEventListener('click', function () {
    setHidden(true);
  });
  showBtn.addEventListener('click', function () {
    markActivity();
    setHidden(false);
  });
  cat.addEventListener('click', petReaction);
  cat.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') petReaction();
  });

  window.addEventListener('pointermove', function (event) {
    markActivity();
    updateEyeTracking(event.clientX, event.clientY);
  }, { passive: true });

  window.addEventListener('pointerdown', markActivity, { passive: true });
  window.addEventListener('scroll', markActivity, { passive: true });
  window.addEventListener('keydown', reactToTyping);

  setInterval(function () {
    if (state.hidden) return;
    if (Date.now() - state.lastActivityAt > 18000) setSleeping(true);
  }, 1000);

  setHidden(localStorage.getItem(HIDE_KEY) === '1');
  scheduleBlink();
})();
