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
  const select = (body) => fetch(base + '/api/selections', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const release = (body) => fetch(base + '/api/selections', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const firstOwner = '11111111-1111-4111-8111-111111111111';
  const secondOwner = '22222222-2222-4222-8222-222222222222';
  const socket = connectSocket(base, { autoConnect: false, reconnection: false, auth: { ownerId: secondOwner } });
  try {
    assert.equal((await fetch(base)).status, 200);
    const events = await (await fetch(base + '/api/events')).json();
    assert.equal(events.length, 3);
    const before = await (await fetch(base + '/api/events/jazz-night/seats')).json();
    assert.equal(before.length, 24);
    assert.equal((await book({ eventId: 'jazz-night', seatLabel: 'Z99' })).status, 400);
    assert.equal((await fetch(base + '/api/events/missing/seats')).status, 404);
    const firstSelection = { eventId: 'jazz-night', seatLabel: 'A3', ownerId: firstOwner };
    assert.equal((await select(firstSelection)).status, 200);
    assert.equal((await select(firstSelection)).status, 200);
    assert.equal((await select({ ...firstSelection, ownerId: secondOwner })).status, 409);
    const reservedSeats = await (await fetch(base + '/api/events/jazz-night/seats')).json();
    assert.equal(reservedSeats.find((seat) => seat.label === 'A3').reserved, true);
    assert.equal((await (await release({ ...firstSelection, ownerId: secondOwner })).json()).released, false);
    assert.equal((await release(firstSelection)).status, 200);
    assert.equal((await select({ ...firstSelection, ownerId: secondOwner })).status, 200);
    await release({ ...firstSelection, ownerId: secondOwner });
    // An existing Redis lock rejects a booking without changing MongoDB.
    const heldToken = await lockSeat('jazz-night-A2');
    assert.ok(heldToken);
    assert.equal(await lockSeat('jazz-night-A2'), null);
    assert.equal((await book({ eventId: 'jazz-night', seatLabel: 'A2', ownerId: firstOwner })).status, 409);
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
    const reservationNotifications = [];
    const releaseNotifications = [];
    socket.on('seat:booked', (message) => notifications.push(message));
    socket.on('seat:reserved', (message) => reservationNotifications.push(message));
    socket.on('seat:released', (message) => releaseNotifications.push(message));
    const liveSelection = { eventId: 'jazz-night', seatLabel: 'B1', ownerId: firstOwner };
    const liveSelectionResponse = await select(liveSelection);
    assert.equal(liveSelectionResponse.status, 200);
    const liveSelectionResult = await liveSelectionResponse.json();
    assert.ok(liveSelectionResult.reservationTtlMs > 0 && liveSelectionResult.reservationTtlMs <= 60_000);
    for (let attempt = 0; reservationNotifications.length === 0 && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(reservationNotifications, [{
      eventId: 'jazz-night',
      seatLabel: 'B1',
      reserved: true,
      reservationTtlMs: reservationNotifications[0].reservationTtlMs,
    }]);
    assert.ok(reservationNotifications[0].reservationTtlMs > 0 && reservationNotifications[0].reservationTtlMs <= 60_000);
    assert.equal(Object.hasOwn(reservationNotifications[0], 'ownerId'), false);
    assert.equal((await release(liveSelection)).status, 200);
    for (let attempt = 0; releaseNotifications.length === 0 && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(releaseNotifications, [{ eventId: 'jazz-night', seatLabel: 'B1' }]);

    const bookingSelection = { eventId: 'jazz-night', seatLabel: 'A1', ownerId: firstOwner };
    assert.equal((await book(bookingSelection)).status, 409);
    assert.equal((await select(bookingSelection)).status, 200);
    const results = await Promise.all(Array.from({ length: 20 }, () => book(bookingSelection)));
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
    const comedySelection = { eventId: 'comedy-club', seatLabel: 'A1', ownerId: firstOwner };
    assert.equal((await select(comedySelection)).status, 200);
    assert.equal((await book(comedySelection)).status, 201);
  } finally {
    socket.disconnect();
    // This test only deletes its uniquely named disposable database.
    if (mongoose.connection.name === databaseName) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await new Promise((resolve) => io.close(resolve));
    redis.disconnect();
  }
});
