const express = require('express');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { redis, lockSeat, unlockSeat, reserveSeat, releaseSeat, getSeatReservation } = require('./redis');
const rateLimiter = require('./rateLimiter');
require('dotenv').config({ quiet: true });

const app = express();
const server = createServer(app);
const io = new Server(server);
app.disable('x-powered-by');

app.use('/api', rateLimiter);
app.use(express.json({ limit: '2kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 1. Each seat stores its own booking. We only need one database collection.
const Seat = mongoose.model('SimpleSeat', new mongoose.Schema({
  _id: String,
  eventId: String,
  label: String,
  booked: { type: Boolean, default: false },
  bookingId: String,
  bookedAt: Date,
}));

const events = [
  { id: 'jazz-night', name: 'Jazz Night', category: 'Music', venue: 'The Garden Hall', schedule: 'Demo event · Friday, 7 PM', price: 499 },
  { id: 'comedy-club', name: 'Comedy Club', category: 'Comedy', venue: 'Studio Twenty', schedule: 'Demo event · Saturday, 6 PM', price: 299 },
  { id: 'indie-evening', name: 'Indie Evening', category: 'Music', venue: 'Rooftop Stage', schedule: 'Demo event · Sunday, 5 PM', price: 399 },
];

// Event URLs share the same page and booking code.
app.get('/events/:id', (req, res) => {
  if (!events.some((event) => event.id === req.params.id)) {
    return res.status(404).type('text').send('Event not found. Return to / to choose an event.');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. Connect once and add missing seats. Restarting never erases bookings.
let databaseReady;
function connectDatabase() {
  if (!databaseReady) {
    databaseReady = (async () => {
      if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in .env');
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      for (const event of events) {
        for (const row of ['A', 'B', 'C', 'D']) {
          for (let number = 1; number <= 6; number++) {
            const label = row + number;
            const seat = { _id: event.id + '-' + label, eventId: event.id, label, booked: false };
            try {
              await Seat.updateOne({ _id: seat._id }, { $setOnInsert: seat }, { upsert: true });
            } catch (error) {
              // Another server may have just created this same seat.
              if (error.code !== 11000) throw error;
            }
          }
        }
      }
    })().catch((error) => { databaseReady = undefined; throw error; });
  }
  return databaseReady;
}

app.use('/api', async (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try { await connectDatabase(); next(); }
  catch (error) { next(error); }
});

// 3. The browser asks for events, then the seats for its chosen event.
app.get('/api/events', (req, res) => res.json(events));

app.get('/api/events/:id/seats', async (req, res, next) => {
  if (!events.some((event) => event.id === req.params.id)) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  try {
    const event = events.find((item) => item.id === req.params.id);
    const seats = await Seat.find({ eventId: req.params.id }).select('label booked -_id').sort({ label: 1 });
    const reservations = await Promise.all(seats.map((seat) => getSeatReservation(event.id + '-' + seat.label)));
    res.json(seats.map((seat, index) => ({
      ...seat.toObject(),
      reserved: Boolean(reservations[index] && reservations[index].ownerId !== req.query.ownerId),
      reservationTtlMs: reservations[index]?.ttlMs || 0,
    })));
  } catch (error) { next(error); }
});

function validOwnerId(ownerId) {
  return typeof ownerId === 'string' && /^[\da-f-]{36}$/i.test(ownerId);
}

io.on('connection', (socket) => {
  socket.data.ownerId = validOwnerId(socket.handshake.auth.ownerId) ? socket.handshake.auth.ownerId : null;
});

function broadcastReservation(eventId, seatLabel, ownerId, reservationTtlMs) {
  for (const socket of io.sockets.sockets.values()) {
    socket.emit('seat:reserved', { eventId, seatLabel, reserved: socket.data.ownerId !== ownerId, reservationTtlMs });
  }
}

app.post('/api/selections', async (req, res, next) => {
  const { eventId, seatLabel, ownerId } = req.body || {};
  const event = events.find((item) => item.id === eventId);
  if (!event || typeof seatLabel !== 'string' || !/^[A-D][1-6]$/.test(seatLabel) || !validOwnerId(ownerId)) {
    return res.status(400).json({ error: 'Choose a valid event and seat.' });
  }
  const seatId = eventId + '-' + seatLabel;
  let lockToken;
  try {
    lockToken = await lockSeat(seatId);
    if (!lockToken) return res.status(409).json({ error: 'This seat is being booked. Please try again.' });
    const seat = await Seat.findById(seatId).select('booked');
    if (!seat || seat.booked) return res.status(409).json({ error: 'This seat is already booked.' });
    if (!await reserveSeat(seatId, ownerId)) {
      return res.status(409).json({ error: 'This seat is selected by someone else. Please choose another.' });
    }
    const reservation = await getSeatReservation(seatId);
    broadcastReservation(eventId, seatLabel, ownerId, reservation.ttlMs);
    res.status(200).json({ reserved: true, reservationTtlMs: reservation.ttlMs });
  } catch (error) { next(error); }
  finally {
    if (lockToken) {
      try { await unlockSeat(seatId, lockToken); }
      catch { console.error('Lock release failed; it will expire automatically.'); }
    }
  }
});

app.delete('/api/selections', async (req, res, next) => {
  const { eventId, seatLabel, ownerId } = req.body || {};
  const event = events.find((item) => item.id === eventId);
  if (!event || typeof seatLabel !== 'string' || !/^[A-D][1-6]$/.test(seatLabel) || !validOwnerId(ownerId)) {
    return res.status(400).json({ error: 'Choose a valid event and seat.' });
  }
  try {
    const released = await releaseSeat(eventId + '-' + seatLabel, ownerId);
    if (released) io.emit('seat:released', { eventId, seatLabel });
    res.json({ released });
  } catch (error) { next(error); }
});

// 4. Verify the active reservation, save atomically in MongoDB, then notify browsers.
app.post('/api/bookings', async (req, res, next) => {
  const { eventId, seatLabel, ownerId } = req.body || {};
  const event = events.find((event) => event.id === eventId);
  if (!event || typeof seatLabel !== 'string' || !/^[A-D][1-6]$/.test(seatLabel) || !validOwnerId(ownerId)) {
    return res.status(400).json({ error: 'Choose a valid event and seat.' });
  }
  const seatId = eventId + '-' + seatLabel;
  let lockToken;
  try {
    lockToken = await lockSeat(seatId);
    if (!lockToken) return res.status(409).json({ error: 'This seat is being booked. Please try another seat.' });
    if ((await getSeatReservation(seatId))?.ownerId !== ownerId) {
      return res.status(409).json({ error: 'Your seat selection has expired. Please select the seat again.' });
    }
    // MongoDB still protects the seat if the Redis lock expires during a slow request.
    const seat = await Seat.findOneAndUpdate(
      { _id: seatId, booked: false },
      { $set: { booked: true, bookingId: randomUUID(), bookedAt: new Date() } },
      { new: true },
    );
    if (!seat) return res.status(409).json({ error: 'Someone already booked this seat. Please choose another.' });
    try { await releaseSeat(seatId, ownerId); }
    catch { console.error('Reservation release failed; it will expire automatically.'); }
    io.emit('seat:booked', { eventId, seatLabel });
    res.status(201).json({ bookingId: seat.bookingId, event: event.name, seat: seat.label, price: event.price });
  } catch (error) { next(error); }
  finally {
    if (lockToken) {
      try { await unlockSeat(seatId, lockToken); }
      catch { console.error('Lock release failed; it will expire automatically.'); }
    }
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Send valid JSON.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  console.error('Request failed:', error.name);
  res.status(503).json({ error: 'A booking service is unavailable. Please try again shortly.' });
});

if (require.main === module) {
  server.listen(process.env.PORT || 3000, () => console.log('Open http://localhost:' + (process.env.PORT || 3000)));
}
module.exports = { server, io, redis };
