// Browser state: the chosen event, chosen seat, and latest seat list.
let selectedEvent = null;
let selectedSeat = null;
let seats = [];
let busy = false;
const get = (id) => document.getElementById(id);
const money = (amount) => '₹' + amount;

// Remember live bookings so a slower seat-list response cannot undo them.
const knownBookings = new Set();
const socket = io();
socket.on('seat:booked', ({ eventId, seatLabel }) => {
  knownBookings.add(eventId + '-' + seatLabel);
  if (selectedEvent?.id !== eventId) return;
  const seat = seats.find((seat) => seat.label === seatLabel);
  if (seat) seat.booked = true;
  if (selectedSeat === seatLabel) selectedSeat = null;
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

function renderSeats() {
  get('seats').replaceChildren();
  for (const seat of seats) {
    const button = document.createElement('button');
    button.textContent = seat.label;
    button.className = 'seat' + (seat.booked ? ' booked' : '') + (selectedSeat === seat.label ? ' selected' : '');
    button.disabled = seat.booked || busy;
    button.setAttribute('aria-label', seat.label + (seat.booked ? ', booked' : ', available'));
    button.setAttribute('aria-pressed', String(selectedSeat === seat.label));
    button.onclick = () => { selectedSeat = seat.label; renderSeats(); };
    get('seats').append(button);
  }
  get('chosen-seat').textContent = selectedSeat || 'Choose a seat';
  get('book').disabled = !selectedSeat || busy;
  get('book').textContent = busy ? 'Please wait…' : 'Book this seat';
  get('refresh').disabled = busy;
  for (const button of get('events').children) button.disabled = busy;
}

async function loadSeats() {
  const eventId = selectedEvent.id;
  const latestSeats = await request('/api/events/' + eventId + '/seats');
  if (selectedEvent.id !== eventId) return;
  for (const seat of latestSeats) {
    const seatId = eventId + '-' + seat.label;
    if (seat.booked) knownBookings.add(seatId);
    if (knownBookings.has(seatId)) seat.booked = true;
  }
  seats = latestSeats;
  if (seats.find((seat) => seat.label === selectedSeat)?.booked) selectedSeat = null;
}

async function chooseEvent(event) {
  if (busy) return;
  selectedEvent = event;
  selectedSeat = null;
  seats = [];
  busy = true;
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
      body: JSON.stringify({ eventId: selectedEvent.id, seatLabel }),
    });
    knownBookings.add(selectedEvent.id + '-' + seatLabel);
    seats.find((seat) => seat.label === seatLabel).booked = true;
    selectedSeat = null;
    get('receipt-details').textContent = booking.event + ' · Seat ' + booking.seat + ' · ' + money(booking.price);
    get('reference').textContent = booking.bookingId;
    get('receipt').hidden = false;
    get('message').textContent = 'Booking confirmed.';
  } catch (error) {
    get('message').textContent = error.message;
    try { await loadSeats(); } catch { /* Keep the original booking error visible. */ }
  } finally { busy = false; renderSeats(); }
};

async function start() {
  try {
    const events = await request('/api/events');
    for (const event of events) {
      const button = document.createElement('button');
      button.className = 'event';
      button.dataset.id = event.id;
      button.setAttribute('aria-pressed', 'false');
      for (const [tag, text] of [['small', event.category], ['h3', event.name], ['p', event.venue], ['strong', money(event.price) + ' / seat']]) {
        const element = document.createElement(tag);
        element.textContent = text;
        button.append(element);
      }
      button.onclick = () => chooseEvent(event);
      get('events').append(button);
    }
    get('message').textContent = '';
  } catch (error) { get('message').textContent = error.message + ' Reload this page to retry.'; }
}
start();
