/* ============================================================
   PausenPlay — customer booking (live seat map)
   Talks to /api/state, /api/book and the /api/events live stream.

   Players can either start right away or reserve a station for a
   date + time of their choosing — the store's timezone decides what
   "18:30" means, so the server converts the picked wall clock.
   ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'pausenplay.mySession';
  var POLL_MS = 15000;
  var DEFAULT_TZ = 'Asia/Kolkata';

  var state = null;          // latest server state
  var selectedSeat = null;   // first selected station, retained for legacy helpers
  var selectedSeats = [];
  var minutes = 60;          // chosen duration
  var whenMode = 'now';      // 'now' | 'later'
  var clockOffset = 0;       // server time - client time
  var live = false;
  var pollTimer = null;
  var seatEls = {};          // seatId -> element

  var el = {};
  function $(id) { return document.getElementById(id); }

  /* --------------------------- helpers --------------------------- */
  function serverNow() { return Date.now() + clockOffset; }
  function tzName() { return (state && state.booking && state.booking.timezone) || DEFAULT_TZ; }

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
    timeZone: DEFAULT_TZ, hour: '2-digit', minute: '2-digit', hour12: true
  });
  var dayFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: DEFAULT_TZ, weekday: 'short', day: '2-digit', month: 'short'
  });
  function upper(t) { return t.replace(' am', ' AM').replace(' pm', ' PM'); }
  function fmtClock(ms) { return upper(clockFmt.format(new Date(ms))); }
  function fmtDay(ms) { return dayFmt.format(new Date(ms)); }
  function fmtWhen(ms) { return fmtDay(ms) + ' · ' + fmtClock(ms); }

  function fmtDuration(min) {
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60);
    var m = min % 60;
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }
  function fmtPrice(amount) { return '₹' + Number(amount || 0).toLocaleString('en-IN'); }
  function selectedStation() { return state && state.seats.filter(function (s) { return s.id === selectedSeat; })[0]; }

  /* ---- wall clock <-> instant, in the store timezone ---- */
  function zoneOffsetMs(ms, timeZone) {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(ms));
    function get(type) {
      for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return Number(parts[i].value);
      return 0;
    }
    var hour = get('hour') % 24; // some builds report midnight as 24
    return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - ms;
  }

  function zonedTimeToMs(dateStr, timeStr, timeZone) {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    var t = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ''));
    if (!d || !t) return null;
    var asUTC = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]), 0);
    var guess = asUTC - zoneOffsetMs(asUTC, timeZone);
    return asUTC - zoneOffsetMs(guess, timeZone);
  }

  /** 'YYYY-MM-DD' + 'HH:MM' as the store sees the given instant. */
  function wallClock(ms) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tzName(), hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date(ms));
    var out = {};
    parts.forEach(function (p) { out[p.type] = p.value; });
    var hour = Number(out.hour) % 24;
    return { date: out.year + '-' + out.month + '-' + out.day, time: pad(hour) + ':' + out.minute };
  }

  function shiftDays(dateStr, days) {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!d) return dateStr;
    var ms = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) + days * 86400000;
    var x = new Date(ms);
    return x.getUTCFullYear() + '-' + pad(x.getUTCMonth() + 1) + '-' + pad(x.getUTCDate());
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

  /**
   * Find the player's own booking in the latest server snapshot.
   * Running sessions live on their seat, reservations in `upcoming`.
   * Returns null once the counter has ended or cancelled it.
   */
  function findMyBooking(s) {
    if (!state) return undefined; // no snapshot yet — cannot say anything
    var seat = state.seats.filter(function (x) { return x.id === s.seatId; })[0];
    if (seat && seat.booking && seat.booking.id === s.id) {
      return { status: 'active', startAt: seat.booking.startAt, endAt: seat.booking.endAt };
    }
    var up = (state.upcoming || []).filter(function (u) { return u.id === s.id; })[0];
    if (up) return { status: 'scheduled', startAt: up.startAt, endAt: up.endAt };
    return null;
  }

  function renderMySession() {
    var s = loadSession();
    var bar = $('mySession');
    if (!bar) return;
    if (!s) { bar.classList.remove('show', 'reserved'); return; }

    var wasShown = bar.classList.contains('show');

    if (state) {
      // a snapshot taken before the booking was made cannot know about it
      if (!s.createdAt || state.serverTime >= s.createdAt) {
        var liveBooking = findMyBooking(s);
        if (liveBooking === null) {
          var ranOut = s.endAt <= serverNow() + 2000;
          saveSession(null);
          bar.classList.remove('show', 'reserved');
          if (wasShown) {
            toast(ranOut
              ? 'Your session on ' + s.seatLabel + ' has finished. GG!'
              : 'Your session on ' + s.seatLabel + ' was ended by the counter. Thanks for playing!', 'ok');
          }
          return;
        }
        // the counter may have added or cut time — trust the server
        if (liveBooking.endAt !== s.endAt || liveBooking.status !== s.status) {
          s.endAt = liveBooking.endAt;
          s.startAt = liveBooking.startAt;
          s.status = liveBooking.status;
          saveSession(s);
        }
      }
    }

    var pending = s.status === 'scheduled' && s.startAt > serverNow();
    if (!pending && s.endAt < serverNow()) {
      saveSession(null);
      bar.classList.remove('show', 'reserved');
      if (wasShown) toast('Your session on ' + s.seatLabel + ' has finished. GG!', 'ok');
      return;
    }

    bar.classList.add('show');
    bar.classList.toggle('reserved', pending);
    $('msSeat').textContent = s.seatLabel;
    if (pending) {
      $('msLabel').textContent = 'Your booking is confirmed';
      $('msName').textContent = s.name + ' · starts ' + fmtWhen(s.startAt);
      $('msTimeLabel').textContent = 'Starts in';
    } else {
      $('msLabel').textContent = 'Your session is running';
      $('msName').textContent = s.name + ' · ends at ' + fmtClock(s.endAt);
      $('msTimeLabel').textContent = 'Time left';
    }
    tickMySession();
  }

  function tickMySession() {
    var s = loadSession();
    var bar = $('mySession');
    if (!s || !bar || !bar.classList.contains('show')) return;
    var t = $('msTime');

    if (s.status === 'scheduled' && s.startAt > serverNow()) {
      t.textContent = fmtCountdown(s.startAt - serverNow());
      return;
    }

    var left = s.endAt - serverNow();
    if (left <= 0) {
      t.textContent = '00:00';
      saveSession(null);
      setTimeout(function () { bar.classList.remove('show', 'reserved'); }, 1200);
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
        node.classList.remove('free', 'soon');
        node.classList.add('busy');
        var left = seat.booking.endAt - serverNow();
        meta.textContent = left > 0 ? '⏱ ' + fmtCountdown(left) : 'TIME UP';
        who.textContent = seat.booking.name || 'BOOKED';
        bar.style.display = 'block';
        var pct = Math.max(0, Math.min(100, (left / (seat.booking.endAt - seat.booking.startAt)) * 100));
        fill.style.width = pct + '%';
        node.classList.toggle('expiring', left > 0 && left < 5 * 60 * 1000);
        node.title = seat.label + ' — ' + (seat.booking.name || 'booked') +
          ' · free at ' + fmtClock(seat.booking.endAt) + ' (tap to reserve it for later)';
        // still clickable: the station can be reserved for a later slot
        node.disabled = false;
      } else {
        node.classList.remove('busy', 'expiring');
        node.classList.add('free');
        node.classList.toggle('soon', !!seat.next);
        if (seat.next) {
          meta.textContent = 'FREE ⏰ ' + fmtClock(seat.next.startAt);
          who.textContent = 'reserved later';
          node.title = seat.label + ' — free now · reserved from ' + fmtWhen(seat.next.startAt);
        } else {
          meta.textContent = 'FREE';
          who.textContent = seat.zone || '';
          node.title = seat.label + ' — ' + seat.zone + ' (tap to book)';
        }
        bar.style.display = 'none';
        node.disabled = false;
      }

      node.classList.toggle('selected', selectedSeats.indexOf(seat.id) !== -1);
    });

    var free = state.seats.filter(function (s) { return s.status === 'free'; }).length;
    if (el.freeCount) {
      var soon = state.seats.filter(function (s) { return s.status === 'free' && s.next; }).length;
      el.freeCount.textContent = free + ' of ' + state.seats.length + ' stations free' +
        (soon ? ' · ' + soon + ' reserved later' : '');
    }
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

  /* ---------------------- when do you play? ---------------------- */
  function setWhenMode(mode) {
    whenMode = mode === 'later' ? 'later' : 'now';
    Array.prototype.forEach.call(document.querySelectorAll('#whenToggle .when-chip'), function (c) {
      c.classList.toggle('active', c.dataset.when === whenMode);
    });
    var later = $('whenLater');
    if (later) later.style.display = whenMode === 'later' ? 'block' : 'none';
    if (whenMode === 'later' && el.dateInput && !el.dateInput.value) {
      // default to the next full hour in the store timezone
      var next = Math.ceil((serverNow() + 15 * 60000) / 3600000) * 3600000;
      var wc = wallClock(next);
      el.dateInput.value = wc.date;
      el.timeInput.value = wc.time;
    }
    updateSummary();
  }

  function clampDateBounds() {
    if (!el.dateInput) return;
    var today = wallClock(serverNow()).date;
    var days = state && state.booking ? Number(state.booking.advanceDays) : 30;
    if (!Number.isFinite(days) || days <= 0) days = 30;
    if (el.dateInput.min !== today) el.dateInput.min = today;
    var max = shiftDays(today, days);
    if (el.dateInput.max !== max) el.dateInput.max = max;
    if (el.dateInput.value && (el.dateInput.value < today || el.dateInput.value > max)) {
      el.dateInput.value = today;
    }
  }

  /** The window the player picked, in absolute time (null when incomplete). */
  function chosenWindow() {
    if (whenMode !== 'later') return null;
    if (!el.dateInput || !el.timeInput) return null;
    var d = el.dateInput.value, t = el.timeInput.value;
    if (!d || !t) return null;
    var start = zonedTimeToMs(d, t, tzName());
    if (!start) return null;
    return { date: d, time: t, start: start, end: start + minutes * 60000 };
  }

  /** Every booking that occupies `seatId`, running or reserved. */
  function seatBookings(seatId) {
    var out = [];
    if (!state) return out;
    state.seats.forEach(function (s) {
      if (s.id === seatId && s.booking) {
        out.push({ id: s.booking.id, startAt: s.booking.startAt, endAt: s.booking.endAt });
      }
    });
    (state.upcoming || []).forEach(function (u) {
      if (u.seatId === seatId) out.push({ id: u.id, startAt: u.startAt, endAt: u.endAt });
    });
    return out;
  }

  /** The booking that blocks `seatId` during [startMs, endMs), if any. */
  function slotClash(seatId, startMs, endMs) {
    var mine = (loadSession() || {}).id;
    return seatBookings(seatId).filter(function (b) {
      return b.id !== mine && b.startAt < endMs && b.endAt > startMs;
    })[0] || null;
  }

  function refreshSlotNote() {
    var note = $('slotNote');
    if (!note) return;
    if (!state || !selectedSeat) { note.textContent = ''; note.className = 'slot-note'; return; }
    var seat = state.seats.filter(function (s) { return s.id === selectedSeat; })[0];
    var label = seat ? seat.label : selectedSeat;

    if (whenMode === 'now') {
      if (seat && seat.status === 'busy') {
        note.textContent = label + ' is in play right now — free at ' + fmtClock(seat.booking.endAt) + '.';
        note.className = 'slot-note bad';
      } else {
        note.textContent = label + ' is free — your timer starts the moment you book.';
        note.className = 'slot-note good';
      }
      return;
    }

    var w = chosenWindow();
    if (!w) {
      note.textContent = 'Pick a date and a start time to see if the station is free.';
      note.className = 'slot-note';
      return;
    }
    if (w.start < serverNow() - 60000) {
      note.textContent = 'That time has already passed — pick a slot in the future.';
      note.className = 'slot-note bad';
      return;
    }
    var clash = slotClash(selectedSeat, w.start, w.end);
    if (clash) {
      note.textContent = label + ' is already booked from ' + fmtClock(clash.startAt) +
        ' to ' + fmtClock(clash.endAt) + '. Try another time or station.';
      note.className = 'slot-note bad';
    } else {
      note.textContent = label + ' is free ' + fmtWhen(w.start) + ' → ' + fmtClock(w.end) + '.';
      note.className = 'slot-note good';
    }
  }

  function updateSummary() {
    if (!$('summaryStart')) return;
    var startEl = $('summaryStart');
    var w = chosenWindow();
    if (w) {
      startEl.textContent = fmtWhen(w.start) + ' → ' + fmtClock(w.end);
    } else if (whenMode === 'later') {
      startEl.textContent = 'pick a date and time';
    } else {
      var start = serverNow();
      startEl.textContent = 'Now (' + fmtClock(start) + ') → ' + fmtClock(start + minutes * 60000);
    }
    $('summaryDuration').textContent = fmtDuration(minutes);
    var seat = selectedStation();
    $('summaryRate').textContent = seat ? fmtPrice(seat.hourlyRate) + '/hour' : 'Pick a station';
    $('summaryPrice').textContent = seat ? fmtPrice(seat.hourlyRate * minutes / 60) : '—';
    var btn = $('bookSubmit');
    if (btn) btn.textContent = whenMode === 'later' ? 'RESERVE MY STATION' : 'LOCK IN MY SEAT';
    refreshSlotNote();
  }

  /* --------------------------- actions --------------------------- */
  function onSeatClick(seatId) {
    var seat = state.seats.filter(function (s) { return s.id === seatId; })[0];
    if (!seat) return;
    if (seat.status === 'busy' && whenMode === 'now') {
      toast(seat.label + ' is booked right now — free at ' + fmtClock(seat.booking.endAt) +
        '. You can still reserve it for later.', 'err');
    }
    var index = selectedSeats.indexOf(seatId);
    if (index === -1) selectedSeats.push(seatId); else selectedSeats.splice(index, 1);
    selectedSeat = selectedSeats[0] || null;
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
    if (!selectedSeats.length) { toast('First, tap one or more stations on the map.', 'err'); return; }
    var name = (el.nameInput.value || '').trim();
    var phone = (el.phoneInput.value || '').trim();
    if (name.length < 2) { toast('Please enter your name.', 'err'); el.nameInput.focus(); return; }
    if (phone.replace(/\D/g, '').length < 10) { toast('Please enter a 10 digit phone number.', 'err'); el.phoneInput.focus(); return; }

    var payload = { seatId: selectedSeats[0], stationIds: selectedSeats, name: name, phone: phone, minutes: minutes };
    var w = chosenWindow();
    if (whenMode === 'later') {
      if (!w) { toast('Please pick the date and time you want to play.', 'err'); if (el.dateInput) el.dateInput.focus(); return; }
      payload.date = w.date;
      payload.time = w.time;
    } else {
      var chosen = state ? state.seats.filter(function (s) { return s.id === selectedSeat; })[0] : null;
      if (chosen && chosen.status === 'busy') {
        toast(chosen.label + ' is in play until ' + fmtClock(chosen.booking.endAt) +
          ' — switch to "Pick date & time" to reserve it for later.', 'err');
        setWhenMode('later');
        return;
      }
    }

    var btn = $('bookSubmit');
    btn.disabled = true;
    btn.textContent = 'BOOKING…';

    fetch('/api/payment/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { btn.disabled = false; updateSummary(); toast(res.d.error || 'Could not prepare payment.', 'err'); fetchState(); return; }
        if (!window.Razorpay) { btn.disabled = false; updateSummary(); toast('Payment checkout did not load. Please try again.', 'err'); return; }
        btn.textContent = 'OPENING PAYMENT...';
        var completed = false;
        var checkout = new window.Razorpay({
          key: res.d.keyId, order_id: res.d.order.id, amount: res.d.order.amount, currency: res.d.order.currency,
          name: 'PausenPlay', description: 'Gaming station booking',
          prefill: { name: name, contact: phone.replace(/\D/g, '') }, theme: { color: '#d6ff00' },
          handler: function (payment) {
            completed = true;
            btn.textContent = 'VERIFYING PAYMENT...';
            fetch('/api/payment/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payment) })
              .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
              .then(function (verified) {
                btn.disabled = false; updateSummary();
                if (!verified.ok) { toast(verified.d.error || 'Payment could not be verified.', 'err'); fetchState(); return; }
                var b = verified.d.booking;
                var seat = state.seats.filter(function (s) { return s.id === b.seatId; })[0];
                saveSession({ id: b.id, seatId: b.seatId, seatLabel: seat ? seat.label : b.seatId, name: b.name, startAt: b.startAt, endAt: b.endAt, status: b.status, createdAt: serverNow() });
                selectedSeat = null; showDone(b, seat); renderMySession(); fetchState();
                toast(b.status === 'scheduled' ? 'Reserved! ' + (seat ? seat.label : '') + ' is yours ' + fmtWhen(b.startAt) + '.' : 'Booked! ' + (seat ? seat.label : '') + ' is yours for ' + fmtDuration(b.durationMin) + '.', 'ok');
              })
              .catch(function () { btn.disabled = false; updateSummary(); toast('Network problem while verifying payment. Contact the lounge if you were charged.', 'err'); });
          },
          modal: { ondismiss: function () { if (!completed) { btn.disabled = false; updateSummary(); toast('Payment was cancelled.', 'err'); } } }
        });
        checkout.on('payment.failed', function () { btn.disabled = false; updateSummary(); toast('Payment failed. Please try again.', 'err'); });
        checkout.open();
      })
      .catch(function () {
        btn.disabled = false;
        updateSummary();
        toast('Network problem — please try again.', 'err');
      });
  }

  function showDone(b, seat) {
    var form = $('bookForm');
    var done = $('bookDone');
    if (!form || !done) return;
    form.style.display = 'none';
    done.style.display = 'block';
    var title = $('doneTitle');
    if (title) title.textContent = b.status === 'scheduled' ? 'STATION RESERVED' : 'YOU ARE IN';
    var sub = $('doneSub');
    if (sub) {
      sub.textContent = b.status === 'scheduled'
        ? 'Be at the counter a few minutes before your slot'
        : 'Show this at the counter and start playing';
    }
    $('doneSeat').textContent = seat ? seat.label : b.seatId;
    $('doneZone').textContent = seat ? seat.zone : '';
    $('doneName').textContent = b.name;
    var startRow = $('doneStartRow');
    if (startRow) {
      startRow.style.display = b.status === 'scheduled' ? 'flex' : 'none';
      $('doneStart').textContent = fmtWhen(b.startAt);
    }
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
    selectedSeats = [];
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
    clampDateBounds();
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
      dateInput: $('startDate'),
      timeInput: $('startTime'),
      summaryStart: $('summaryStart')
    };

    if (!document.getElementById('storeMap')) return; // booking section not on this page

    var form = $('bookForm');
    if (form) form.addEventListener('submit', submitBooking);
    var again = $('bookAgain');
    if (again) again.addEventListener('click', resetForm);

    Array.prototype.forEach.call(document.querySelectorAll('#whenToggle .when-chip'), function (chip) {
      chip.addEventListener('click', function () { setWhenMode(chip.dataset.when); });
    });
    if (el.dateInput) {
      el.dateInput.addEventListener('change', updateSummary);
      el.timeInput.addEventListener('change', updateSummary);
    }
    Array.prototype.forEach.call(document.querySelectorAll('#quickSlots .quick-slot'), function (btn) {
      btn.addEventListener('click', function () {
        setWhenMode('later');
        var minsAhead = Number(btn.dataset.minutes);
        var wc = wallClock(serverNow() + minsAhead * 60000);
        el.dateInput.value = wc.date;
        el.timeInput.value = wc.time;
        updateSummary();
      });
    });

    setWhenMode('now');
    renderMySession();
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
