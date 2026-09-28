const express = require('express');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { redis, lockSeat, unlockSeat } = require('./redis');
require('dotenv').config({ quiet: true });

const app = express();
const server = createServer(app);
const io = new Server(server);
app.disable('x-powered-by');
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
    const seats = await Seat.find({ eventId: req.params.id }).select('label booked -_id').sort({ label: 1 });
    res.json(seats);
  } catch (error) { next(error); }
});

// 4. Get a Redis lock, save atomically in MongoDB, then notify connected browsers.
app.post('/api/bookings', async (req, res, next) => {
  const { eventId, seatLabel } = req.body || {};
  const event = events.find((event) => event.id === eventId);
  if (!event || typeof seatLabel !== 'string' || !/^[A-D][1-6]$/.test(seatLabel)) {
    return res.status(400).json({ error: 'Choose a valid event and seat.' });
  }
  const seatId = eventId + '-' + seatLabel;
  let lockToken;
  try {
    lockToken = await lockSeat(seatId);
    if (!lockToken) return res.status(409).json({ error: 'This seat is being booked. Please try another seat.' });
    // MongoDB still protects the seat if the Redis lock expires during a slow request.
    const seat = await Seat.findOneAndUpdate(
      { _id: seatId, booked: false },
      { $set: { booked: true, bookingId: randomUUID(), bookedAt: new Date() } },
      { new: true },
    );
    if (!seat) return res.status(409).json({ error: 'Someone already booked this seat. Please choose another.' });
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
