// Browser state: the chosen event, chosen seat, and latest seat list.
let selectedEvent = null;
let selectedSeat = null;
let seats = [];
let busy = false;
const reservationTimers = new Map();
const reservationDeadlines = new Map();
const ownerId = sessionStorage.getItem('seatOwnerId') || crypto.randomUUID();
sessionStorage.setItem('seatOwnerId', ownerId);
const get = (id) => document.getElementById(id);
const money = (amount) => '₹' + amount;

// Remember live bookings so a slower seat-list response cannot undo them.
const knownBookings = new Set();
const socket = io({ auth: { ownerId } });
socket.on('seat:booked', ({ eventId, seatLabel }) => {
  knownBookings.add(eventId + '-' + seatLabel);
  if (selectedEvent?.id !== eventId) return;
  const seat = seats.find((seat) => seat.label === seatLabel);
  if (seat) seat.booked = true;
  if (selectedSeat === seatLabel) selectedSeat = null;
  renderSeats();
});
socket.on('seat:reserved', ({ eventId, seatLabel, reserved, reservationTtlMs }) => {
  const seat = seats.find((item) => item.label === seatLabel);
  if (seat && selectedEvent?.id === eventId) {
    seat.reserved = reserved;
    renderSeats();
  }
  scheduleReservationExpiry(eventId, seatLabel, reservationTtlMs);
});
socket.on('seat:released', ({ eventId, seatLabel }) => {
  clearReservationTimer(eventId + '-' + seatLabel);
  if (selectedEvent?.id !== eventId) return;
  const seat = seats.find((item) => item.label === seatLabel);
  if (seat) { seat.reserved = false; seat.reservationTtlMs = 0; }
  renderSeats();
});
socket.on('connect', async () => {
  get('live-status').textContent = 'Live seat updates connected';
  // Fetch missed bookings after reconnecting, including during event loading.
  if (selectedEvent) {
    try { await loadSeats(); renderSeats(); }
    catch { get('live-status').textContent = 'Could not refresh seats. Use Refresh availability.'; }
  }
});
socket.on('disconnect', () => {
  get('live-status').textContent = 'Live updates disconnected. Use Refresh availability.';
});
socket.on('connect_error', () => {
  get('live-status').textContent = 'Live updates unavailable. Use Refresh availability.';
});

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function clearReservationTimer(seatKey) {
  clearTimeout(reservationTimers.get(seatKey));
  reservationTimers.delete(seatKey);
  reservationDeadlines.delete(seatKey);
}

function updateCheckoutCountdown() {
  const deadline = selectedEvent && selectedSeat
    ? reservationDeadlines.get(selectedEvent.id + '-' + selectedSeat) : null;
  const panel = get('checkout-countdown');
  panel.hidden = !deadline;
  if (!deadline) return;
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  get('checkout-time').textContent = String(Math.floor(seconds / 60)).padStart(2, '0')
    + ':' + String(seconds % 60).padStart(2, '0');
  panel.classList.toggle('urgent', seconds <= 10);
  if (seconds === 0) get('book').disabled = true;
}

// Use the hold deadline, so background tabs don't pause the countdown.
setInterval(updateCheckoutCountdown, 250);
document.addEventListener('visibilitychange', updateCheckoutCountdown);

function scheduleReservationExpiry(eventId, seatLabel, ttlMs) {
  const seatKey = eventId + '-' + seatLabel;
  clearReservationTimer(seatKey);
  if (!ttlMs || ttlMs <= 0) return;
  const deadline = Date.now() + ttlMs;
  reservationDeadlines.set(seatKey, deadline);
  reservationTimers.set(seatKey, setTimeout(() => {
    reservationTimers.delete(seatKey);
    reservationDeadlines.delete(seatKey);
    const seat = selectedEvent?.id === eventId ? seats.find((item) => item.label === seatLabel) : null;
    if (seat) {
      seat.reserved = false;
      seat.reservationTtlMs = 0;
    }
    if (selectedEvent?.id === eventId && selectedSeat === seatLabel) {
      selectedSeat = null;
      get('message').textContent = 'Your seat selection expired. Please select it again if it is available.';
    }
    if (selectedEvent?.id === eventId) {
      renderSeats();
      loadSeats().then(renderSeats).catch(() => {});
    }
  }, Math.max(0, deadline - Date.now()) + 50));
}

function renderSeats() {
  get('seats').replaceChildren();
  for (const seat of seats) {
    const button = document.createElement('button');
    button.textContent = seat.label;
    button.className = 'seat' + (seat.booked ? ' booked' : '') + (seat.reserved ? ' reserved' : '') + (selectedSeat === seat.label ? ' selected' : '');
    button.disabled = seat.booked || seat.reserved || busy;
    button.setAttribute('aria-label', seat.label + (seat.booked ? ', booked' : seat.reserved ? ', selected by another user' : ', available'));
    button.setAttribute('aria-pressed', String(selectedSeat === seat.label));
    button.onclick = () => selectSeat(seat.label);
    get('seats').append(button);
  }
  get('chosen-seat').textContent = selectedSeat || 'Choose a seat';
  get('book').disabled = !selectedSeat || busy;
  get('book').textContent = busy ? 'Please wait…' : 'Book this seat';
  get('refresh').disabled = busy;
  for (const button of get('events').children) button.disabled = busy;
  updateCheckoutCountdown();
}

async function loadSeats() {
  const eventId = selectedEvent.id;
  const latestSeats = await request('/api/events/' + eventId + '/seats?ownerId=' + encodeURIComponent(ownerId));
  if (selectedEvent.id !== eventId) return;
  for (const seat of latestSeats) {
    const seatId = eventId + '-' + seat.label;
    if (seat.booked) knownBookings.add(seatId);
    if (knownBookings.has(seatId)) seat.booked = true;
  }
  seats = latestSeats;
  for (const seat of seats) scheduleReservationExpiry(eventId, seat.label, seat.reservationTtlMs);
  if (seats.find((seat) => seat.label === selectedSeat)?.booked || seats.find((seat) => seat.label === selectedSeat)?.reserved) selectedSeat = null;
}

async function selectSeat(seatLabel) {
  if (busy || !selectedEvent) return;
  const eventId = selectedEvent.id;
  busy = true;
  renderSeats();
  try {
    if (selectedSeat === seatLabel) {
      await request('/api/selections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, seatLabel, ownerId }),
      });
      selectedSeat = null;
      get('message').textContent = '';
    } else {
      if (selectedSeat) {
        await request('/api/selections', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId, seatLabel: selectedSeat, ownerId }),
        });
      }
      const reservation = await request('/api/selections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, seatLabel, ownerId }),
      });
      selectedSeat = seatLabel;
      scheduleReservationExpiry(eventId, seatLabel, reservation.reservationTtlMs);
      get('message').textContent = '';
    }
    await loadSeats();
  } catch (error) {
    selectedSeat = null;
    get('message').textContent = error.message;
    try { await loadSeats(); } catch { /* Keep the selection error visible. */ }
  } finally {
    busy = false;
    renderSeats();
  }
}

async function chooseEvent(event) {
  if (busy) return;
  busy = true;
  if (selectedEvent && selectedSeat) {
    try {
      await request('/api/selections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: selectedEvent.id, seatLabel: selectedSeat, ownerId }),
      });
    } catch { /* The reservation expires automatically if release fails. */ }
  }
  selectedEvent = event;
  selectedSeat = null;
  seats = [];
  get('booking').hidden = false;
  get('receipt').hidden = true;
  get('event-category').textContent = event.category;
  get('event-details').textContent = event.venue + ' · ' + event.schedule;
  get('chosen-event').textContent = event.name;
  get('price').textContent = money(event.price);
  for (const button of get('events').children) {
    button.classList.toggle('active', button.dataset.id === event.id);
    button.setAttribute('aria-pressed', String(button.dataset.id === event.id));
  }
  renderSeats();
  get('message').textContent = 'Loading seats…';
  try { await loadSeats(); get('message').textContent = ''; }
  catch (error) { get('message').textContent = error.message; }
  finally { busy = false; renderSeats(); }
}

get('refresh').onclick = async () => {
  busy = true;
  renderSeats();
  try { await loadSeats(); get('message').textContent = 'Availability updated.'; }
  catch (error) { get('message').textContent = error.message; }
  finally { busy = false; renderSeats(); }
};

get('book').onclick = async () => {
  if (busy || !selectedSeat) return;
  const deadline = reservationDeadlines.get(selectedEvent.id + '-' + selectedSeat);
  if (!deadline || deadline <= Date.now()) {
    get('message').textContent = 'Your checkout time expired. Please select a seat again.';
    selectedSeat = null;
    renderSeats();
    return;
  }
  // A live update can clear selectedSeat while this request is waiting.
  const seatLabel = selectedSeat;
  busy = true;
  renderSeats();
  get('receipt').hidden = true;
  get('message').textContent = 'Booking your seat…';
  try {
    const booking = await request('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: selectedEvent.id, seatLabel, ownerId }),
    });
    knownBookings.add(selectedEvent.id + '-' + seatLabel);
    clearReservationTimer(selectedEvent.id + '-' + seatLabel);
    seats.find((seat) => seat.label === seatLabel).booked = true;
    selectedSeat = null;
    get('receipt-details').textContent = booking.event + ' · Seat ' + booking.seat + ' · ' + money(booking.price);
    get('reference').textContent = booking.bookingId;
    get('receipt').hidden = false;
    get('message').textContent = 'Booking confirmed.';
  } catch (error) {
    try {
      await request('/api/selections', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: selectedEvent.id, seatLabel, ownerId }),
      });
    } catch { /* The reservation expires automatically if release fails. */ }
    selectedSeat = null;
    get('message').textContent = error.message;
    try { await loadSeats(); } catch { /* Keep the original booking error visible. */ }
  } finally { busy = false; renderSeats(); }
};

async function start() {
  const eventPath = window.location.pathname.match(/^\/events\/([^/]+)\/?$/);
  if (eventPath) {
    get('event-list').hidden = true;
    get('all-events').hidden = false;
    get('page-title').textContent = 'Loading event...';
    get('page-intro').textContent = 'Choose your seat and book your evening.';
  }
  try {
    const events = await request('/api/events');
    if (eventPath) {
      const event = events.find((item) => item.id === eventPath[1]);
      if (!event) {
        get('page-title').textContent = 'Event not found';
        get('message').textContent = 'Return to all events to choose another event.';
        return;
      }
      document.title = event.name + ' | Gather';
      get('page-title').textContent = event.name;
      get('page-intro').textContent = event.venue + ' | ' + event.schedule;
      await chooseEvent(event);
      return;
    }
    for (const event of events) {
      const button = document.createElement('a');
      button.className = 'event';
      button.dataset.id = event.id;
      button.href = '/events/' + encodeURIComponent(event.id);
      for (const [tag, text] of [['small', event.category], ['h3', event.name], ['p', event.venue], ['strong', money(event.price) + ' / seat']]) {
        const element = document.createElement(tag);
        element.textContent = text;
        button.append(element);
      }
      get('events').append(button);
    }
    get('message').textContent = '';
  } catch (error) { get('message').textContent = error.message + ' Reload this page to retry.'; }
}

// Leaving through the page links releases a selected seat before navigating.
for (const link of [get('all-events'), document.querySelector('.brand')]) {
  link.addEventListener('click', async (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (!selectedEvent) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    renderSeats();
    if (selectedSeat) {
      try {
        await request('/api/selections', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId: selectedEvent.id, seatLabel: selectedSeat, ownerId }),
        });
      } catch { /* The existing hold expiry handles a failed release. */ }
    }
    window.location.assign(link.href);
  });
}
start();
