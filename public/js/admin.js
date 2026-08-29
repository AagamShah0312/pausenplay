/* ============================================================
   PausenPlay — Admin console
   ============================================================ */
(function () {
  'use strict';

  var state = null;          // /api/admin/state payload
  var offset = 0;            // server time - client time
  var selectedSeat = null;
  var historyCache = [];
  var live = false;
  var refreshTimer = null;

  function $(id) { return document.getElementById(id); }
  function serverNow() { return Date.now() + offset; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtCountdown(ms) {
    if (ms < 0) ms = 0;
    var t = Math.floor(ms / 1000);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }
  // all times are shown in the store timezone (Ahmedabad)
  var timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
  });
  var clockFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true
  });
  function upper(t) { return t.replace(' am', ' AM').replace(' pm', ' PM'); }
  function fmtTime(ms) { return ms ? upper(timeFmt.format(new Date(ms))) : '—'; }
  function fmtClockOnly(ms) { return ms ? upper(clockFmt.format(new Date(ms))) : '—'; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var STATUS_PILL = {
    active: { cls: 'live', label: 'Running' },
    scheduled: { cls: 'soon', label: 'Scheduled' },
    expired: { cls: 'done', label: 'Finished' },
    ended: { cls: 'done', label: 'Ended early' },
    cancelled: { cls: 'cancelled', label: 'Cancelled' }
  };

  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('ppToast');
    t.textContent = msg;
    t.className = 'pp-toast show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'pp-toast ' + (kind || ''); }, 4000);
  }

  function setLive(on) {
    live = on;
    var d = $('liveDot');
    if (d) d.classList.toggle('offline', !on);
  }

  /* ------------------------------ api ------------------------------ */
  function api(path, options) {
    return fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}))
      .then(function (r) {
        if (r.status === 401) { showLogin('Your session expired — please sign in again.'); throw new Error('unauthorized'); }
        return r.json().then(function (data) { return { ok: r.ok, data: data }; });
      });
  }

  /* ----------------------------- auth ------------------------------ */
  function showLogin(message) {
    $('appView').style.display = 'none';
    $('loginView').style.display = 'flex';
    var err = $('loginError');
    if (message) { err.textContent = message; err.style.display = 'block'; }
    else { err.style.display = 'none'; }
  }

  function showApp(user) {
    $('loginView').style.display = 'none';
    $('appView').style.display = 'block';
    if (user) $('tbUser').textContent = user;
    loadState();
  }

  function doLogin(e) {
    e.preventDefault();
    var btn = $('loginBtn');
    var err = $('loginError');
    err.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'SIGNING IN…';
    api('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('loginUser').value, password: $('loginPass').value })
    }).then(function (res) {
      btn.disabled = false;
      btn.textContent = 'SIGN IN';
      if (!res.ok) {
        err.textContent = res.data.error || 'Login failed.';
        err.style.display = 'block';
        return;
      }
      $('loginPass').value = '';
      showApp(res.data.username);
      if (res.data.usingDefault) {
        setTimeout(function () { toast('You are still on the default password — change it in Settings.', 'err'); }, 600);
      }
    }).catch(function (err2) {
      btn.disabled = false;
      btn.textContent = 'SIGN IN';
      if (err2.message !== 'unauthorized') toast('Could not reach the server.', 'err');
    });
  }

  function doLogout() {
    api('/api/admin/logout', { method: 'POST' })
      .then(function () { showLogin(''); })
      .catch(function () { showLogin(''); });
  }

  /* ---------------------------- rendering -------------------------- */
  function renderStats() {
    if (!state) return;
    var busy = state.seats.filter(function (s) { return s.status === 'busy'; }).length;
    $('statActive').textContent = busy;
    $('statFree').textContent = state.seats.length - busy;
    $('statToday').textContent = state.stats.today;
    $('statHours').textContent = Math.round((state.stats.minutesToday / 60) * 10) / 10 + 'h';
    $('statTotal').textContent = state.stats.total;
    $('statPlayers').textContent = state.stats.customers;
  }

  function applyLayout() {
    var map = $('adminMap');
    if (!map || !state.layout) return;
    if (state.layout.width && state.layout.height) {
      map.style.aspectRatio = state.layout.width + ' / ' + state.layout.height;
    }
    var img = map.querySelector('img');
    if (img && state.layout.image && img.getAttribute('src') !== state.layout.image) {
      img.src = state.layout.image;
    }
  }

  var seatEls = {};
  function renderMap() {
    var map = $('adminMap');
    if (!map || !state) return;
    state.seats.forEach(function (seat) {
      var node = seatEls[seat.id];
      if (!node) {
        node = document.createElement('button');
        node.type = 'button';
        node.className = 'seat';
        node.innerHTML = '<span class="seat-name"></span><span class="seat-meta"></span><span class="seat-who"></span><span class="seat-bar" style="display:none"><i></i></span>';
        node.addEventListener('click', function () {
        if (editing) { selectDraftSeat(seat.id); return; }
        openSeatModal(seat.id);
      });
        map.appendChild(node);
        seatEls[seat.id] = node;
      }
      node.style.left = seat.x + '%';
      node.style.top = seat.y + '%';
      node.style.width = seat.w + '%';
      node.style.height = seat.h + '%';
      node.querySelector('.seat-name').textContent = seat.label;

      var meta = node.querySelector('.seat-meta');
      var who = node.querySelector('.seat-who');
      var bar = node.querySelector('.seat-bar');

      if (seat.status === 'busy' && seat.booking) {
        node.classList.remove('free'); node.classList.add('busy');
        var left = seat.booking.endAt - serverNow();
        meta.textContent = '⏱ ' + fmtCountdown(left);
        who.textContent = seat.booking.name;
        bar.style.display = 'block';
        bar.querySelector('i').style.width = Math.max(0, Math.min(100, (left / (seat.booking.endAt - seat.booking.startAt)) * 100)) + '%';
        node.title = seat.label + ' — ' + seat.booking.name + ' (click to manage)';
      } else {
        node.classList.remove('busy'); node.classList.add('free');
        node.classList.toggle('soon', !!seat.next);
        if (seat.next) {
          meta.textContent = '⏰ ' + fmtClockOnly(seat.next.startAt);
          who.textContent = 'reserved later';
          node.title = seat.label + ' — free now · reserved from ' + fmtTime(seat.next.startAt);
        } else {
          meta.textContent = 'FREE';
          who.textContent = seat.zone;
          node.title = seat.label + ' — free (click to book)';
        }
        bar.style.display = 'none';
      }
      node.classList.toggle('sel', selectedSeat === seat.id);
    });
  }

  function tickMap() {
    if (!state) return;
    var dirty = false;
    state.seats.forEach(function (seat) {
      var node = seatEls[seat.id];
      if (!node) return;
      if (seat.status !== 'busy' || !seat.booking) return;
      var left = seat.booking.endAt - serverNow();
      if (left <= 0) { dirty = true; return; }
      var meta = node.querySelector('.seat-meta');
      if (meta) meta.textContent = '⏱ ' + fmtCountdown(left);
      var fill = node.querySelector('.seat-bar i');
      if (fill) fill.style.width = Math.max(0, Math.min(100, (left / (seat.booking.endAt - seat.booking.startAt)) * 100)) + '%';
    });
    if (dirty) loadState();
  }

  function renderActive() {
    var body = $('activeBody');
    if (!body) return;
    var rows = state.seats.filter(function (s) { return s.status === 'busy' && s.booking; });
    rows.sort(function (a, b) { return a.booking.endAt - b.booking.endAt; });

    if (!rows.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="5">No station is running right now</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function (seat) {
      var b = seat.booking;
      var left = b.endAt - serverNow();
      return '<tr data-seat="' + esc(seat.id) + '" data-booking="' + esc(b.id) + '" class="' + (selectedSeat === seat.id ? 'row-sel' : '') + '">' +
        '<td><span class="seat-tag">' + esc(seat.label) + '</span><div class="mono" style="font-size:10px;">' + esc(seat.zone) + '</div></td>' +
        '<td class="name">' + esc(b.name) + '</td>' +
        '<td class="mono">' + fmtClockOnly(b.endAt) + '</td>' +
        '<td><span class="countdown' + (left < 300000 ? ' low' : '') + '" data-end="' + b.endAt + '">' + fmtCountdown(left) + '</span></td>' +
        '<td><div class="time-btns">' +
          '<button class="tbtn minus" data-act="adjust" data-delta="-30" data-id="' + esc(b.id) + '">−30m</button>' +
          '<button class="tbtn minus" data-act="adjust" data-delta="-15" data-id="' + esc(b.id) + '">−15m</button>' +
          '<button class="tbtn plus" data-act="adjust" data-delta="15" data-id="' + esc(b.id) + '">+15m</button>' +
          '<button class="tbtn plus" data-act="adjust" data-delta="30" data-id="' + esc(b.id) + '">+30m</button>' +
          '<button class="tbtn plus" data-act="adjust" data-delta="60" data-id="' + esc(b.id) + '">+1h</button>' +
          '<button class="tbtn stop" data-act="end" data-id="' + esc(b.id) + '">END</button>' +
        '</div></td>' +
        '</tr>';
    }).join('');
  }

  function tickActiveCountdowns() {
    document.querySelectorAll('#activeBody .countdown').forEach(function (el) {
      var left = Number(el.dataset.end) - serverNow();
      el.textContent = fmtCountdown(left);
      el.classList.toggle('low', left < 300000);
    });
  }

  /* --------------------- upcoming (reserved) ---------------------- */
  function fmtUntil(ms) {
    var mins = Math.max(0, Math.round((ms - serverNow()) / 60000));
    if (mins < 60) return 'in ' + mins + ' min';
    var h = Math.floor(mins / 60);
    if (h < 24) return 'in ' + h + 'h ' + (mins % 60) + 'm';
    return 'in ' + Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }

  function renderUpcoming() {
    var body = $('upcomingBody');
    if (!body) return;
    var rows = state.upcomingBookings || [];
    $('upcomingCount').textContent = rows.length
      ? rows.length + ' reservation' + (rows.length === 1 ? '' : 's') + ' waiting to start'
      : 'Reservations players made for a later date and time';

    if (!rows.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="8">No station is reserved for later</td></tr>';
      return;
    }

    body.innerHTML = rows.map(function (b) {
      return '<tr data-booking="' + esc(b.id) + '">' +
        '<td><span class="seat-tag">' + esc(b.seatLabel) + '</span><div class="mono" style="font-size:10px;">' + esc(b.zone || '') + '</div></td>' +
        '<td class="name">' + esc(b.name) + '</td>' +
        '<td class="mono">' + esc(b.phone || '—') + '</td>' +
        '<td class="mono">' + fmtTime(b.startAt) + '<div class="mono" style="font-size:10px;color:var(--gold);" data-start="' + b.startAt + '">' + fmtUntil(b.startAt) + '</div></td>' +
        '<td class="mono">' + fmtTime(b.endAt) + '</td>' +
        '<td>' + esc(b.durationMin) + '</td>' +
        '<td>' + (b.createdBy === 'admin' ? '<span class="pill admin">Admin</span>' : '<span class="mono">Customer</span>') + '</td>' +
        '<td><div class="time-btns">' +
          '<button class="tbtn go" data-act="start" data-id="' + esc(b.id) + '">START NOW</button>' +
          '<button class="tbtn plus" data-act="adjust" data-delta="30" data-id="' + esc(b.id) + '">+30m</button>' +
          '<button class="tbtn minus" data-act="adjust" data-delta="-30" data-id="' + esc(b.id) + '">−30m</button>' +
          '<button class="tbtn stop" data-act="cancel" data-id="' + esc(b.id) + '">CANCEL</button>' +
        '</div></td>' +
        '</tr>';
    }).join('');
  }

  function tickUpcomingCountdowns() {
    document.querySelectorAll('#upcomingBody [data-start]').forEach(function (el) {
      el.textContent = fmtUntil(Number(el.dataset.start));
    });
  }

  function renderHistory() {
    var body = $('historyBody');
    if (!body) return;
    historyCache = state.bookings || [];
    applyHistoryFilter();
  }

  function applyHistoryFilter() {
    var body = $('historyBody');
    if (!body) return;
    var q = ($('searchInput').value || '').trim().toLowerCase();
    var status = $('statusFilter').value;

    var rows = historyCache.filter(function (b) {
      if (status === 'active' && b.status !== 'active') return false;
      if (status === 'scheduled' && b.status !== 'scheduled') return false;
      if (status === 'cancelled' && b.status !== 'cancelled') return false;
      if (status === 'past' && (b.status === 'active' || b.status === 'scheduled')) return false;
      if (!q) return true;
      var seat = (state.seats.filter(function (s) { return s.id === b.seatId; })[0] || {}).label || '';
      return (b.name || '').toLowerCase().indexOf(q) > -1 ||
        (b.phone || '').indexOf(q) > -1 ||
        seat.toLowerCase().indexOf(q) > -1;
    });

    if (!rows.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="9">No bookings found</td></tr>';
      $('historyCount').textContent = '0 records';
      return;
    }

    body.innerHTML = rows.map(function (b) {
      var seat = state.seats.filter(function (s) { return s.id === b.seatId; })[0] || { label: b.seatId, zone: '' };
      var edits = (b.adjustments || []).filter(function (a) { return typeof a.delta === 'number'; });
      var pill = STATUS_PILL[b.status] || { cls: 'done', label: b.status };
      return '<tr>' +
        '<td><span class="seat-tag">' + esc(seat.label) + '</span><div class="mono" style="font-size:10px;">' + esc(seat.zone) + '</div></td>' +
        '<td class="name">' + esc(b.name) + '</td>' +
        '<td class="mono">' + esc(b.phone || '—') + '</td>' +
        '<td class="mono">' + fmtTime(b.startAt) + '</td>' +
        '<td class="mono">' + fmtTime(b.endAt) + '</td>' +
        '<td>' + esc(b.durationMin) + '</td>' +
        '<td><span class="pill ' + pill.cls + '">' + pill.label + '</span></td>' +
        '<td>' + (b.createdBy === 'admin' ? '<span class="pill admin">Admin</span>' : '<span class="mono">Customer</span>') + '</td>' +
        '<td class="mono">' + (edits.length ? edits.map(function (a) { return (a.delta > 0 ? '+' : '') + a.delta + 'm'; }).join(', ') : '—') + '</td>' +
        '</tr>';
    }).join('');
    $('historyCount').textContent = rows.length + ' of ' + historyCache.length + ' records';
  }

  function renderSelects() {
    if (!state) return;
    var sel = $('adminSeat');
    var prev = sel.value;
    sel.innerHTML = state.seats.filter(function (s) { return s.status === 'free'; })
      .map(function (s) {
        var soon = s.next ? ' · reserved ' + fmtClockOnly(s.next.startAt) : '';
        return '<option value="' + esc(s.id) + '">' + esc(s.label + ' — ' + s.zone + soon) + '</option>';
      }).join('')
      || '<option value="">No free station</option>';
    if (prev && sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;

    // reservations cannot be made in the past
    var dateInp = $('adminDate');
    if (dateInp) {
      var tz = (state.booking && state.booking.timezone) || 'Asia/Kolkata';
      var today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(new Date(serverNow()));
      if (dateInp.min !== today) dateInp.min = today;
      var days = Number(state.booking && state.booking.advanceDays);
      if (Number.isFinite(days) && days > 0) {
        var max = new Date(serverNow() + days * 86400000);
        var maxStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(max);
        if (dateInp.max !== maxStr) dateInp.max = maxStr;
      }
    }

    ['adminMinutes', 'modalMinutes'].forEach(function (id) {
      var m = $(id);
      if (!m) return;
      var keep = m.value;
      m.innerHTML = state.durations.map(function (d) { return '<option value="' + d + '">' + d + ' minutes</option>'; }).join('');
      if (keep) m.value = keep;
      else m.value = state.defaultDuration;
    });
  }

  /* ----------------------------- modal ----------------------------- */
  function openSeatModal(seatId) {
    var seat = state.seats.filter(function (s) { return s.id === seatId; })[0];
    if (!seat) return;
    selectedSeat = seatId;
    renderMap();

    $('modalTitle').textContent = seat.label;
    $('modalSub').textContent = seat.zone;
    var busy = seat.status === 'busy' && seat.booking;
    $('modalBusy').style.display = busy ? 'block' : 'none';
    $('modalFree').style.display = busy ? 'none' : 'block';
    $('modalJustClose').style.display = 'none';
    $('customDelta').value = '';

    if (busy) {
      $('modalSub').textContent = seat.zone + ' · ' + seat.booking.name +
        ' · ends ' + fmtClockOnly(seat.booking.endAt) + ' (' + fmtCountdown(seat.booking.endAt - serverNow()) + ' left)';
      $('modalBusy').dataset.booking = seat.booking.id;
      $('modalBusy').dataset.seat = seat.id;
    } else {
      $('modalFree').dataset.seat = seat.id;
      $('modalBookForm').dataset.seat = seat.id;
      if (seat.next) {
        $('modalSub').textContent = seat.zone + ' · reserved from ' + fmtTime(seat.next.startAt) +
          ' to ' + fmtClockOnly(seat.next.endAt) + ' · free until then';
      }
    }
    $('seatModal').classList.add('show');
    if (!busy) setTimeout(function () { $('modalName').focus(); }, 100);
  }

  function closeModal() {
    $('seatModal').classList.remove('show');
  }

  function modalAdjust(delta) {
    var id = $('modalBusy').dataset.booking;
    if (!id) return;
    adjust(id, delta);
  }

  function adjust(bookingId, delta) {
    if (!delta) return;
    api('/api/admin/adjust', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId: bookingId, deltaMinutes: Number(delta) })
    }).then(function (res) {
      if (!res.ok) { toast(res.data.error || 'Could not change the time.', 'err'); return; }
      var b = res.data.booking;
      if (b.status === 'scheduled') {
        toast('Reservation is now ' + b.durationMin + ' minutes long.', 'ok');
      } else if (b.status === 'active') {
        toast(delta > 0 ? 'Added ' + delta + ' minutes.' : 'Removed ' + Math.abs(delta) + ' minutes.', 'ok');
        closeModal();
      } else {
        closeModal();
        toast('Session closed.', 'ok');
      }
      loadState();
    }).catch(function () {});
  }

  function endSession(bookingId) {
    if (!confirm('End this session now?')) return;
    api('/api/admin/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId: bookingId })
    }).then(function (res) {
      if (!res.ok) { toast(res.data.error || 'Could not end the session.', 'err'); return; }
      closeModal();
      toast('Session ended — station is free again.', 'ok');
      loadState();
    }).catch(function () {});
  }

  /** Cancel a reservation that has not started yet. */
  function cancelBooking(bookingId) {
    if (!confirm('Cancel this reservation? The player will lose the slot.')) return;
    api('/api/admin/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId: bookingId })
    }).then(function (res) {
      if (!res.ok) { toast(res.data.error || 'Could not cancel the booking.', 'err'); return; }
      closeModal();
      toast('Reservation cancelled — the station is open for that slot.', 'ok');
      loadState();
    }).catch(function () {});
  }

  /** The player turned up early — start the reserved session right away. */
  function startBooking(bookingId) {
    api('/api/admin/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId: bookingId })
    }).then(function (res) {
      if (!res.ok) { toast(res.data.error || 'Could not start the session.', 'err'); return; }
      var b = res.data.booking;
      toast('Session started — runs until ' + fmtClockOnly(b.endAt) + '.', 'ok');
      loadState();
    }).catch(function () {});
  }


  /* ================= LAYOUT EDITOR (move / resize stations) ================= */
  var editing = false;
  var draftSeats = [];
  var editingSeatId = null;

  function cloneSeats(list) {
    return (list || []).map(function (s) {
      return { id: s.id, label: s.label, zone: s.zone, type: s.type, x: s.x, y: s.y, w: s.w, h: s.h };
    });
  }

  function draftSeat(id) {
    return draftSeats.filter(function (s) { return s.id === id; })[0] || null;
  }

  function currentSeatId() { return editing ? editingSeatId : selectedSeat; }

  function enterEditMode() {
    if (!state) return;
    editing = true;
    draftSeats = cloneSeats(state.seats);
    editingSeatId = (draftSeats[0] || {}).id || null;
    $('layoutEditor').style.display = 'block';
    $('adminMap').classList.add('editing');
    $('editLayoutBtn').textContent = 'Editing stations…';
    $('mapHint').textContent = 'Drag a station to move it · drag its bottom-right corner to resize';
    $('mapHint').classList.add('map-hint-on');
    renderEditMap();
    renderSeatSelect();
    syncEditorFields();
  }

  function exitEditMode() {
    editing = false;
    draftSeats = [];
    editingSeatId = null;
    $('layoutEditor').style.display = 'none';
    $('adminMap').classList.remove('editing');
    $('editLayoutBtn').textContent = 'Move / resize stations';
    $('mapHint').textContent = 'Green = free · Red = booked · Click a station to manage it';
    $('mapHint').classList.remove('map-hint-on');
    Object.keys(seatEls).forEach(function (k) { seatEls[k].remove(); delete seatEls[k]; });
    selectedSeat = null;
    loadState();
  }

  function renderEditMap() {
    var map = $('adminMap');
    Object.keys(seatEls).forEach(function (k) { seatEls[k].remove(); delete seatEls[k]; });
    draftSeats.forEach(function (seat) {
      var node = document.createElement('div');
      node.className = 'seat free editing';
      node.dataset.seat = seat.id;
      node.innerHTML = '<span class="seat-name"></span><span class="seat-who"></span><span class="seat-bar" style="display:none"><i></i></span>';
      positionNode(node, seat);
      node.querySelector('.seat-name').textContent = seat.label;
      node.querySelector('.seat-who').textContent = seat.zone;
      map.appendChild(node);
      seatEls[seat.id] = node;
      attachDrag(node, seat);
    });
    markEditingSelection();
  }

  function positionNode(node, seat) {
    node.style.left = seat.x + '%';
    node.style.top = seat.y + '%';
    node.style.width = seat.w + '%';
    node.style.height = seat.h + '%';
  }

  function markEditingSelection() {
    Object.keys(seatEls).forEach(function (id) {
      seatEls[id].classList.toggle('picked', id === editingSeatId);
    });
  }

  function attachDrag(node, seat) {
    node.addEventListener('pointerdown', function (e) {
      if (!editing) return;
      e.preventDefault();
      selectDraftSeat(seat.id);
      var map = $('adminMap');
      var mapRect = map.getBoundingClientRect();
      var nodeRect = node.getBoundingClientRect();
      var isResize = (e.clientX - nodeRect.right > -18) && (e.clientY - nodeRect.bottom > -18);
      var startX = e.clientX, startY = e.clientY;
      var orig = { x: seat.x, y: seat.y, w: seat.w, h: seat.h };
      node.classList.add('picked');
      try { node.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }

      function move(ev) {
        var dxPct = ((ev.clientX - startX) / mapRect.width) * 100;
        var dyPct = ((ev.clientY - startY) / mapRect.height) * 100;
        if (isResize) {
          seat.w = clamp(orig.w + dxPct, 3, 100 - seat.x);
          seat.h = clamp(orig.h + dyPct, 3, 100 - seat.y);
        } else {
          seat.x = clamp(orig.x + dxPct, 0, 100 - seat.w);
          seat.y = clamp(orig.y + dyPct, 0, 100 - seat.h);
        }
        positionNode(node, seat);
      }
      function up() {
        node.classList.remove('picked');
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
      }
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    });
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v * 100) / 100)); }

  function selectDraftSeat(id) {
    editingSeatId = id;
    markEditingSelection();
    syncEditorFields();
  }

  function renderSeatSelect() {
    var sel = $('seatSelect');
    sel.innerHTML = draftSeats.map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>';
    }).join('');
    if (editingSeatId) sel.value = editingSeatId;
  }

  function syncEditorFields() {
    var seat = draftSeat(editingSeatId);
    if (!seat) return;
    $('edLabel').value = seat.label;
    $('edZone').value = seat.zone;
    $('edType').value = seat.type;
  }

  function addDraftSeat() {
    var n = draftSeats.length + 1;
    var id = 'SEAT-' + String(n).padStart(2, '0');
    var k = 1;
    while (draftSeats.some(function (s) { return s.id === id; })) id = 'SEAT-' + String(n + (++k)).padStart(2, '0');
    var last = draftSeats[draftSeats.length - 1];
    draftSeats.push({
      id: id, label: id, zone: last ? last.zone : 'Gaming Zone', type: last ? last.type : 'other',
      x: last ? Math.min(80, last.x + 6) : 6, y: last ? Math.min(80, last.y + 6) : 6, w: 12, h: 14
    });
    editingSeatId = id;
    renderEditMap();
    renderSeatSelect();
    syncEditorFields();
  }

  function deleteDraftSeat() {
    var seat = draftSeat(editingSeatId);
    if (!seat) return;
    var live = state.seats.filter(function (s) { return s.id === seat.id && s.status === 'busy'; })[0];
    if (live) { toast(seat.label + ' is in use right now — end the session first.', 'err'); return; }
    if (!confirm('Remove station ' + seat.label + '?')) return;
    draftSeats = draftSeats.filter(function (s) { return s.id !== seat.id; });
    editingSeatId = (draftSeats[0] || {}).id || null;
    renderEditMap();
    renderSeatSelect();
    syncEditorFields();
  }

  function arrangeGrid() {
    var rows = Math.max(1, Math.min(20, Number($('gridRows').value) || 1));
    var cols = Math.max(1, Math.min(20, Number($('gridCols').value) || 1));
    var margin = 4, gap = 2;
    var w = (100 - margin * 2 - gap * (cols - 1)) / cols;
    var h = (100 - margin * 2 - gap * (rows - 1)) / rows;
    var next = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var existing = draftSeats[next.length];
        next.push({
          id: existing ? existing.id : 'SEAT-' + String(next.length + 1).padStart(2, '0'),
          label: existing ? existing.label : 'SEAT-' + String(next.length + 1).padStart(2, '0'),
          zone: existing ? existing.zone : 'Gaming Zone',
          type: existing ? existing.type : 'other',
          x: Math.round((margin + c * (w + gap)) * 100) / 100,
          y: Math.round((margin + r * (h + gap)) * 100) / 100,
          w: Math.round(w * 100) / 100,
          h: Math.round(h * 100) / 100
        });
      }
    }
    draftSeats = next;
    editingSeatId = (draftSeats[0] || {}).id || null;
    renderEditMap();
    renderSeatSelect();
    syncEditorFields();
    toast('Arranged ' + (rows * cols) + ' stations in a grid — drag them onto the right spots, then save.', 'ok');
  }

  function saveLayout() {
    if (!draftSeats.length) { toast('The floor plan needs at least one station.', 'err'); return; }
    var btn = $('saveLayoutBtn');
    btn.disabled = true;
    api('/api/admin/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seats: draftSeats, layout: { image: state.layout.image, width: state.layout.width, height: state.layout.height } })
    }).then(function (res) {
      btn.disabled = false;
      if (!res.ok) { toast(res.data.error || 'Could not save the layout.', 'err'); return; }
      toast('Layout saved.', 'ok');
      exitEditMode();
    }).catch(function () { btn.disabled = false; });
  }

  function uploadFloorImage(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('That image is bigger than 8 MB.', 'err'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result);
      var probe = new Image();
      probe.onload = function () {
        $('uploadImgBtn').disabled = true;
        $('uploadImgBtn').textContent = 'Uploading…';
        api('/api/admin/layout-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, data: dataUrl, width: probe.naturalWidth, height: probe.naturalHeight })
        }).then(function (res) {
          $('uploadImgBtn').disabled = false;
          $('uploadImgBtn').textContent = 'Upload floor photo';
          if (!res.ok) { toast(res.data.error || 'Upload failed.', 'err'); return; }
          toast('Floor photo updated — now drag the stations onto it.', 'ok');
          loadState();
        }).catch(function () {
          $('uploadImgBtn').disabled = false;
          $('uploadImgBtn').textContent = 'Upload floor photo';
        });
      };
      probe.onerror = function () { toast('Could not read that image.', 'err'); };
      probe.src = dataUrl;
    };
    reader.onerror = function () { toast('Could not read that file.', 'err'); };
    reader.readAsDataURL(file);
  }

  /* ----------------------------- export ---------------------------- */
  function download(path, filename) {
    fetch(path, { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { showLogin('Session expired — please sign in again.'); return null; }
        return r.blob();
      })
      .then(function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        toast('Export downloaded.', 'ok');
      })
      .catch(function () { toast('Export failed.', 'err'); });
  }

  /* ----------------------------- loading --------------------------- */
  function loadState() {
    return api('/api/admin/state').then(function (res) {
      if (!res.ok) return;
      state = res.data;
      offset = state.serverTime - Date.now();
      applyLayout();
      renderStats();
      if (!editing) renderMap();
      renderActive();
      renderUpcoming();
      renderHistory();
      renderSelects();
      setLive(true);
    }).catch(function () { setLive(false); });
  }

  function connectStream() {
    if (typeof EventSource === 'undefined') return;
    var es = new EventSource('/api/events');
    es.addEventListener('open', function () { setLive(true); });
    es.addEventListener('error', function () { setLive(false); });
    es.addEventListener('state', function () {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(loadState, 250);
    });
  }

  /* ------------------------------ init ----------------------------- */
  function init() {
    $('loginForm').addEventListener('submit', doLogin);
    $('logoutBtn').addEventListener('click', doLogout);
    $('refreshBtn').addEventListener('click', function () { loadState(); toast('Refreshed.', 'ok'); });
    $('settingsBtn').addEventListener('click', function () {
      document.getElementById('settingsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // seat map / table actions
    $('activeBody').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'adjust') adjust(btn.dataset.id, btn.dataset.delta);
      else if (btn.dataset.act === 'end') endSession(btn.dataset.id);
    });

    // upcoming reservations
    $('upcomingBody').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'start') startBooking(btn.dataset.id);
      else if (btn.dataset.act === 'adjust') adjust(btn.dataset.id, btn.dataset.delta);
      else if (btn.dataset.act === 'cancel') cancelBooking(btn.dataset.id);
    });

    // modal
    $('modalBusy').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-delta]');
      if (btn) modalAdjust(btn.dataset.delta);
    });
    $('applyDelta').addEventListener('click', function () {
      var v = $('customDelta').value;
      if (!v || Number(v) === 0) { toast('Enter minutes to add (or a negative number to remove).', 'err'); return; }
      modalAdjust(v);
    });
    $('endSession').addEventListener('click', function () {
      var id = $('modalBusy').dataset.booking;
      if (id) endSession(id);
    });
    $('modalClose').addEventListener('click', closeModal);
    $('modalClose2').addEventListener('click', closeModal);
    $('seatModal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

    // walk-in booking (or a reservation for later when a date/time is filled in)
    $('adminBookForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {
        seatId: $('adminSeat').value,
        name: $('adminName').value.trim(),
        phone: $('adminPhone').value.trim(),
        minutes: Number($('adminMinutes').value)
      };
      var when = $('adminDate').value;
      var at = $('adminTime').value;
      if (when || at) {
        if (!when || !at) { toast('Set both the date and the start time, or leave both empty.', 'err'); return; }
        payload.date = when;
        payload.time = at;
      }
      if (!payload.seatId) { toast('No free station selected.', 'err'); return; }
      if (payload.name.length < 2) { toast('Enter the player name.', 'err'); return; }
      if (payload.phone.replace(/\D/g, '').length < 10) { toast('Enter a 10 digit phone number.', 'err'); return; }
      var btn = $('adminBookBtn');
      if (btn.disabled) return;
      btn.disabled = true;
      api('/api/admin/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        btn.disabled = false;
        if (!res.ok) { toast(res.data.error || 'Booking failed.', 'err'); return; }
        toast(res.data.booking.status === 'scheduled'
          ? 'Reserved ' + payload.seatId + ' for ' + fmtTime(res.data.booking.startAt) + '.'
          : 'Session started on ' + payload.seatId + '.', 'ok');
        $('adminName').value = ''; $('adminPhone').value = '';
        $('adminDate').value = ''; $('adminTime').value = '';
        loadState();
      }).catch(function () { btn.disabled = false; });
    });

    // modal booking
    $('modalBookForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {
        seatId: $('modalBookForm').dataset.seat,
        name: $('modalName').value.trim(),
        phone: $('modalPhone').value.trim(),
        minutes: Number($('modalMinutes').value)
      };
      if (payload.name.length < 2) { toast('Enter the player name.', 'err'); return; }
      if (payload.phone.replace(/\D/g, '').length < 10) { toast('Enter a 10 digit phone number.', 'err'); return; }
      var mbtn = $('modalBookBtn');
      if (mbtn.disabled) return;
      mbtn.disabled = true;
      api('/api/admin/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        mbtn.disabled = false;
        if (!res.ok) { toast(res.data.error || 'Booking failed.', 'err'); return; }
        closeModal();
        toast('Booked ' + payload.seatId + '.', 'ok');
        loadState();
      }).catch(function () { mbtn.disabled = false; });
    });

    // floor plan editor
    $('editLayoutBtn').addEventListener('click', function () {
      if (editing) { exitEditMode(); } else { enterEditMode(); }
    });
    $('uploadImgBtn').addEventListener('click', function () { $('imageInput').click(); });
    $('imageInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) uploadFloorImage(f);
      e.target.value = '';
    });
    $('seatSelect').addEventListener('change', function (e) { selectDraftSeat(e.target.value); });
    $('edLabel').addEventListener('input', function (e) {
      var seat = draftSeat(editingSeatId);
      if (!seat) return;
      seat.label = e.target.value.slice(0, 24) || seat.id;
      var node = seatEls[seat.id];
      if (node) node.querySelector('.seat-name').textContent = seat.label;
      var opt = $('seatSelect').querySelector('option[value="' + seat.id + '"]');
      if (opt) opt.textContent = seat.label;
    });
    $('edZone').addEventListener('input', function (e) {
      var seat = draftSeat(editingSeatId);
      if (!seat) return;
      seat.zone = e.target.value.slice(0, 40);
      var node = seatEls[seat.id];
      if (node) node.querySelector('.seat-who').textContent = seat.zone;
    });
    $('edType').addEventListener('change', function (e) {
      var seat = draftSeat(editingSeatId);
      if (seat) seat.type = e.target.value;
    });
    $('addSeatBtn').addEventListener('click', addDraftSeat);
    $('delSeatBtn').addEventListener('click', deleteDraftSeat);
    $('gridBtn').addEventListener('click', arrangeGrid);
    $('saveLayoutBtn').addEventListener('click', saveLayout);
    $('cancelLayoutBtn').addEventListener('click', exitEditMode);

    // history filters
    $('searchInput').addEventListener('input', applyHistoryFilter);
    $('statusFilter').addEventListener('change', applyHistoryFilter);
    $('exportXlsx').addEventListener('click', function () { download('/api/export.xlsx', 'pausenplay-bookings.xlsx'); });
    $('exportCsv').addEventListener('click', function () { download('/api/export.csv', 'pausenplay-bookings.csv'); });

    // credentials
    $('credForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('credBtn');
      btn.disabled = true;
      api('/api/admin/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('newUser').value,
          password: $('newPass').value,
          confirmPassword: $('confirmPass').value,
          currentPassword: $('currentPass').value
        })
      }).then(function (res) {
        btn.disabled = false;
        if (!res.ok) { toast(res.data.error || 'Could not save credentials.', 'err'); return; }
        ['newUser', 'newPass', 'confirmPass', 'currentPass'].forEach(function (id) { $(id).value = ''; });
        showLogin('Credentials updated. Sign in with your new username and password.');
      }).catch(function () { btn.disabled = false; });
    });

    // clock + countdowns
    setInterval(function () {
      $('tbClock').textContent = fmtClockOnly(serverNow());
      tickMap();
      tickActiveCountdowns();
      tickUpcomingCountdowns();
    }, 1000);

    setInterval(function () { if (!live) loadState(); }, 15000);

    // are we already signed in?
    api('/api/admin/me').then(function (res) {
      if (res.ok && res.data.ok) {
        $('newUser').value = res.data.username;
        if (res.data.updatedAt) {
          $('credMeta').textContent = 'Username: ' + res.data.username + ' · last changed ' + fmtTime(res.data.updatedAt);
        }
        showApp(res.data.username);
        connectStream();
      } else {
        showLogin('');
      }
    }).catch(function () { showLogin(''); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
