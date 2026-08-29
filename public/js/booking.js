/* ============================================================
   PausenPlay — customer booking (live seat map)
   Talks to /api/state, /api/book and the /api/events live stream.
   ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'pausenplay.mySession';
  var POLL_MS = 15000;

  var state = null;          // latest server state
  var selectedSeat = null;   // seat id currently picked in the form
  var minutes = 60;          // chosen duration
  var clockOffset = 0;       // server time - client time
  var live = false;
  var pollTimer = null;
  var seatEls = {};          // seatId -> element

  var el = {};
  function $(id) { return document.getElementById(id); }

  /* --------------------------- helpers --------------------------- */
  function serverNow() { return Date.now() + clockOffset; }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtCountdown(ms) {
    if (ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  // every time shown to players is in the store timezone (Ahmedabad)
  var clockFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true
  });
  function fmtClock(ms) {
    return clockFmt.format(new Date(ms)).replace(' am', ' AM').replace(' pm', ' PM');
  }

  function fmtDuration(min) {
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60);
    var m = min % 60;
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }

  function toast(message, kind) {
    var t = $('ppToast');
    if (!t) return;
    t.textContent = message;
    t.className = 'pp-toast show ' + (kind || '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.className = 'pp-toast ' + (kind || ''); }, 4200);
  }

  /* ------------------------- my session -------------------------- */
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function saveSession(s) {
    if (s) localStorage.setItem(STORE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORE_KEY);
  }

  function renderMySession() {
    var s = loadSession();
    var bar = $('mySession');
    if (!bar) return;
    if (!s) { bar.classList.remove('show'); return; }

    // forget sessions that are over
    if (state) {
      var seat = state.seats.filter(function (x) { return x.id === s.seatId; })[0];
      var stillMine = seat && seat.booking && seat.booking.id === s.id;
      if (!stillMine && s.endAt < serverNow() - 5000) {
        saveSession(null);
        bar.classList.remove('show');
        return;
      }
    }
    if (s.endAt < serverNow()) {
      saveSession(null);
      bar.classList.remove('show');
      toast('Your session on ' + s.seatLabel + ' has finished. GG!', 'ok');
      return;
    }
    bar.classList.add('show');
    $('msSeat').textContent = s.seatLabel;
    $('msName').textContent = s.name + ' · ends at ' + fmtClock(s.endAt);
  }

  function tickMySession() {
    var s = loadSession();
    var bar = $('mySession');
    if (!s || !bar) return;
    var left = s.endAt - serverNow();
    var t = $('msTime');
    if (left <= 0) {
      t.textContent = '00:00';
      saveSession(null);
      setTimeout(function () { bar.classList.remove('show'); }, 1200);
      toast('Time up on ' + s.seatLabel + ' — thanks for playing!', 'ok');
      return;
    }
    t.textContent = fmtCountdown(left);
  }

  /* --------------------------- rendering ------------------------- */
  function renderSeats() {
    var map = $('storeMap');
    if (!map || !state) return;

    state.seats.forEach(function (seat) {
      var node = seatEls[seat.id];
      if (!node) {
        node = document.createElement('button');
        node.type = 'button';
        node.className = 'seat';
        node.dataset.seat = seat.id;
        node.innerHTML =
          '<span class="seat-name"></span>' +
          '<span class="seat-meta"></span>' +
          '<span class="seat-who"></span>' +
          '<span class="seat-bar" style="display:none"><i></i></span>';
        node.addEventListener('click', function () { onSeatClick(seat.id); });
        map.appendChild(node);
        seatEls[seat.id] = node;
      }

      node.style.left = seat.x + '%';
      node.style.top = seat.y + '%';
      node.style.width = seat.w + '%';
      node.style.height = seat.h + '%';

      var name = node.querySelector('.seat-name');
      var meta = node.querySelector('.seat-meta');
      var who = node.querySelector('.seat-who');
      var bar = node.querySelector('.seat-bar');
      var fill = bar.querySelector('i');

      name.textContent = seat.label;

      if (seat.status === 'busy' && seat.booking) {
        node.classList.remove('free');
        node.classList.add('busy');
        var left = seat.booking.endAt - serverNow();
        meta.textContent = left > 0 ? '⏱ ' + fmtCountdown(left) : 'TIME UP';
        who.textContent = seat.booking.name || 'BOOKED';
        bar.style.display = 'block';
        var pct = Math.max(0, Math.min(100, (left / (seat.booking.endAt - seat.booking.startAt)) * 100));
        fill.style.width = pct + '%';
        node.classList.toggle('expiring', left > 0 && left < 5 * 60 * 1000);
        node.title = seat.label + ' — ' + (seat.booking.name || 'booked') +
          ' · free at ' + fmtClock(seat.booking.endAt);
        node.disabled = true;
      } else {
        node.classList.remove('busy', 'expiring');
        node.classList.add('free');
        meta.textContent = 'FREE';
        who.textContent = seat.zone || '';
        bar.style.display = 'none';
        node.title = seat.label + ' — ' + seat.zone + ' (tap to book)';
        node.disabled = false;
      }

      node.classList.toggle('selected', selectedSeat === seat.id);
    });

    var free = state.seats.filter(function (s) { return s.status === 'free'; }).length;
    if (el.freeCount) el.freeCount.textContent = free + ' of ' + state.seats.length + ' stations free';
  }

  function tickSeats() {
    if (!state) return;
    var changed = false;
    state.seats.forEach(function (seat) {
      if (seat.status !== 'busy' || !seat.booking) return;
      var left = seat.booking.endAt - serverNow();
      var node = seatEls[seat.id];
      if (!node) return;
      if (left <= 0) {
        seat.status = 'free';
        seat.booking = null;
        changed = true;
        renderSeats();
        return;
      }
      var meta = node.querySelector('.seat-meta');
      if (meta) meta.textContent = '⏱ ' + fmtCountdown(left);
      var pct = Math.max(0, Math.min(100, (left / (seat.booking.endAt - seat.booking.startAt)) * 100));
      var fill = node.querySelector('.seat-bar i');
      if (fill) fill.style.width = pct + '%';
      node.classList.toggle('expiring', left < 5 * 60 * 1000);
    });
    if (changed) renderSeats();
  }

  function renderDurations() {
    var wrap = $('durations');
    if (!wrap || !state) return;
    if (wrap.dataset.built === '1') return;
    wrap.innerHTML = '';
    state.durations.forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dur-chip' + (m === minutes ? ' active' : '');
      b.dataset.minutes = m;
      b.innerHTML = fmtDuration(m);
      b.addEventListener('click', function () {
        minutes = m;
        Array.prototype.forEach.call(wrap.children, function (c) {
          c.classList.toggle('active', Number(c.dataset.minutes) === minutes);
        });
        updateSummary();
      });
      wrap.appendChild(b);
    });
    wrap.dataset.built = '1';
  }

  function updateSummary() {
    if (!$('summaryStart')) return;
    var start = serverNow();
    $('summaryStart').textContent = fmtClock(start) + ' → ' + fmtClock(start + minutes * 60000);
    $('summaryDuration').textContent = fmtDuration(minutes);
  }

  /* --------------------------- actions --------------------------- */
  function onSeatClick(seatId) {
    var seat = state.seats.filter(function (s) { return s.id === seatId; })[0];
    if (!seat) return;
    if (seat.status === 'busy') {
      toast(seat.label + ' is booked right now — free at ' + fmtClock(seat.booking.endAt) + '.', 'err');
      return;
    }
    selectedSeat = seatId;
    renderSeats();
    if (el.picked) {
      el.picked.classList.remove('empty');
      $('pickedSeat').textContent = seat.label;
      $('pickedZone').textContent = seat.zone;
    }
    updateSummary();
    var section = document.getElementById('book');
    if (window.innerWidth < 1000 && section) {
      section.querySelector('.book-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (el.nameInput && !el.nameInput.value) el.nameInput.focus();
  }

  function submitBooking(e) {
    e.preventDefault();
    if (!selectedSeat) { toast('First, tap a green station on the map.', 'err'); return; }
    var name = (el.nameInput.value || '').trim();
    var phone = (el.phoneInput.value || '').trim();
    if (name.length < 2) { toast('Please enter your name.', 'err'); el.nameInput.focus(); return; }
    if (phone.replace(/\D/g, '').length < 10) { toast('Please enter a 10 digit phone number.', 'err'); el.phoneInput.focus(); return; }

    var btn = $('bookSubmit');
    btn.disabled = true;
    btn.textContent = 'BOOKING…';

    fetch('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: selectedSeat, name: name, phone: phone, minutes: minutes })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'LOCK IN MY SEAT';
        if (!res.ok) { toast(res.d.error || 'Could not complete the booking.', 'err'); fetchState(); return; }
        var b = res.d.booking;
        var seat = state.seats.filter(function (s) { return s.id === b.seatId; })[0];
        saveSession({
          id: b.id, seatId: b.seatId, seatLabel: seat ? seat.label : b.seatId,
          name: b.name, endAt: b.endAt, startAt: b.startAt
        });
        selectedSeat = null;
        showDone(b, seat);
        renderMySession();
        fetchState();
        toast('Booked! ' + (seat ? seat.label : '') + ' is yours for ' + fmtDuration(b.durationMin) + '.', 'ok');
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'LOCK IN MY SEAT';
        toast('Network problem — please try again.', 'err');
      });
  }

  function showDone(b, seat) {
    var form = $('bookForm');
    var done = $('bookDone');
    if (!form || !done) return;
    form.style.display = 'none';
    done.style.display = 'block';
    $('doneSeat').textContent = seat ? seat.label : b.seatId;
    $('doneZone').textContent = seat ? seat.zone : '';
    $('doneName').textContent = b.name;
    $('doneUntil').textContent = fmtClock(b.endAt);
    $('doneDuration').textContent = fmtDuration(b.durationMin);
  }

  function resetForm() {
    var form = $('bookForm');
    var done = $('bookDone');
    if (form) { form.style.display = 'block'; form.reset(); }
    if (done) done.style.display = 'none';
    if (el.picked) {
      el.picked.classList.add('empty');
      $('pickedSeat').textContent = 'No station picked';
      $('pickedZone').textContent = '';
    }
    selectedSeat = null;
    renderSeats();
    updateSummary();
  }

  /* ---------------------------- network -------------------------- */
  function applyLayout() {
    var map = $('storeMap');
    if (!map || !state.layout) return;
    if (state.layout.width && state.layout.height) {
      map.style.aspectRatio = state.layout.width + ' / ' + state.layout.height;
    }
    var img = map.querySelector('img');
    if (img && state.layout.image && img.getAttribute('src') !== state.layout.image) {
      img.src = state.layout.image;
    }
  }

  function applyState(data) {
    state = data;
    clockOffset = data.serverTime - Date.now();
    applyLayout();
    if (el.mapLoading) el.mapLoading.style.display = 'none';
    if (!minutes && data.defaultDuration) minutes = data.defaultDuration;
    renderDurations();
    renderSeats();
    renderMySession();
    updateSummary();
  }

  function fetchState() {
    return fetch('/api/state', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(applyState)
      .catch(function () { setLive(false); });
  }

  function setLive(isLive) {
    live = isLive;
    var dot = $('liveDot');
    if (dot) dot.classList.toggle('offline', !isLive);
    var label = $('liveLabel');
    if (label) label.textContent = isLive ? 'LIVE' : 'RECONNECTING…';
  }

  function connectStream() {
    if (typeof EventSource === 'undefined') return;
    var es = new EventSource('/api/events');
    es.addEventListener('state', function (ev) {
      try { applyState(JSON.parse(ev.data)); setLive(true); }
      catch (e) { /* ignore */ }
    });
    es.addEventListener('open', function () { setLive(true); });
    es.addEventListener('error', function () { setLive(false); });
  }

  /* ----------------------------- init ---------------------------- */
  function init() {
    el = {
      mapLoading: $('mapLoading'),
      freeCount: $('freeCount'),
      picked: $('pickedSeat') ? $('pickedSeat').closest('.picked') : null,
      nameInput: $('playerName'),
      phoneInput: $('playerPhone'),
      summaryStart: $('summaryStart')
    };

    if (!document.getElementById('storeMap')) return; // booking section not on this page

    var form = $('bookForm');
    if (form) form.addEventListener('submit', submitBooking);
    var again = $('bookAgain');
    if (again) again.addEventListener('click', resetForm);

    renderMySession();
    updateSummary();
    fetchState();
    connectStream();

    setInterval(function () {
      tickSeats();
      tickMySession();
    }, 1000);

    pollTimer = setInterval(function () {
      if (!live) fetchState();
    }, POLL_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
