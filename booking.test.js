// Integration test: use a temporary database and compete for a real seat.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { io: connectSocket } = require('socket.io-client');

test('only one of 20 simultaneous requests can book a seat', async () => {
  const databaseName = 'gather_test_' + Date.now();
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/' + databaseName;
  process.env.REDIS_KEY_PREFIX = databaseName + ':';
  const { server, io, redis } = require('./server');
  const { lockSeat, unlockSeat } = require('./redis');
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.on('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const book = (body) => fetch(base + '/api/bookings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const socket = connectSocket(base, { autoConnect: false, reconnection: false });
  try {
    assert.equal((await fetch(base)).status, 200);
    const events = await (await fetch(base + '/api/events')).json();
    assert.equal(events.length, 3);
    const before = await (await fetch(base + '/api/events/jazz-night/seats')).json();
    assert.equal(before.length, 24);
    assert.equal((await book({ eventId: 'jazz-night', seatLabel: 'Z99' })).status, 400);
    assert.equal((await fetch(base + '/api/events/missing/seats')).status, 404);
    // An existing Redis lock rejects a booking without changing MongoDB.
    const heldToken = await lockSeat('jazz-night-A2');
    assert.ok(heldToken);
    assert.equal(await lockSeat('jazz-night-A2'), null);
    assert.equal((await book({ eventId: 'jazz-night', seatLabel: 'A2' })).status, 409);
    assert.equal(await mongoose.model('SimpleSeat').countDocuments({ booked: true }), 0);
    await unlockSeat('jazz-night-A2', 'wrong-token');
    assert.equal(await lockSeat('jazz-night-A2'), null);
    await unlockSeat('jazz-night-A2', heldToken);
    const newToken = await lockSeat('jazz-night-A2');
    await unlockSeat('jazz-night-A2', heldToken);
    assert.equal(await lockSeat('jazz-night-A2'), null);
    await unlockSeat('jazz-night-A2', newToken);

    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    const notifications = [];
    socket.on('seat:booked', (message) => notifications.push(message));
    const results = await Promise.all(Array.from({ length: 20 }, () => book({ eventId: 'jazz-night', seatLabel: 'A1' })));
    assert.equal(results.filter((response) => response.status === 201).length, 1);
    assert.equal(results.filter((response) => response.status === 409).length, 19);
    const booking = await results.find((response) => response.status === 201).json();
    assert.equal(booking.price, 499);
    assert.ok(booking.bookingId);
    assert.equal(await mongoose.model('SimpleSeat').countDocuments({ booked: true }), 1);
    const after = await (await fetch(base + '/api/events/jazz-night/seats')).json();
    assert.equal(after.find((seat) => seat.label === 'A1').booked, true);
    assert.equal(JSON.stringify(after).includes(booking.bookingId), false);
    // Allow the independent socket transport to deliver the committed booking.
    for (let attempt = 0; notifications.length === 0 && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(notifications, [{ eventId: 'jazz-night', seatLabel: 'A1' }]);
    assert.equal((await book({ eventId: 'comedy-club', seatLabel: 'A1' })).status, 201);
  } finally {
    socket.disconnect();
    // This test only deletes its uniquely named disposable database.
    if (mongoose.connection.name === databaseName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await new Promise((resolve) => io.close(resolve));
    redis.disconnect();
  }
});
