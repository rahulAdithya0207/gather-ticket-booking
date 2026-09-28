# Gather — beginner ticket booking

A small web app: choose an event, select one seat, and get a booking reference.
The sample events are demonstrations with no real dates or payments.

**Live demo:** https://gather-ticket-booking.onrender.com

The demo uses Render's free plan, so the first visit after inactivity may take
longer while the server wakes up. Cloud bookings are separate from local Docker data.

## Five application files

| File | Responsibility |
| --- | --- |
| `public/index.html` | The page: events, seats, and booking confirmation |
| `public/style.css` | Colors, spacing, and mobile layout |
| `public/app.js` | Button clicks, requests to the server, and page updates |
| `server.js` | Express routes, MongoDB connection, and booking logic |
| `redis.js` | Redis request locks and expiring, owner-checked seat reservations |

Read them in that order. The other files are setup (`package.json`, its generated
lockfile, `.env.example`, `.gitignore`), this guide, and one integration test.
`node_modules` contains installed dependencies; do not read or edit it.

## Run locally

Use Node.js 24 and Docker Desktop (running Linux containers).

```powershell
npm install
Copy-Item .env.example .env
docker run -d --name gather-beginner-mongo -p 127.0.0.1:27018:27017 -v gather-beginner-data:/data/db mongo:7
docker run -d --name gather-beginner-redis -p 127.0.0.1:6379:6379 redis:7-alpine
npm run dev
```

Open **http://localhost:3000**. The first API request creates 72 seats: 24 for each
of three events. The database name is `gather_beginner`, separate from the older app.
Bookings survive server and container restarts. Subsequent runs use
`docker start gather-beginner-mongo gather-beginner-redis`, then `npm run dev`.
If `.env` already exists, keep its values instead of copying over it.

You can also use an existing MongoDB database: put its connection string in `.env`
as `MONGODB_URI` and skip the MongoDB Docker command. Set `REDIS_URL` to your Redis
connection string (the local default is `redis://127.0.0.1:6379`). Never commit `.env`.

## Seat holds and booking safety

Selecting a seat creates a Redis reservation owned by that browser tab. Other
tabs immediately receive a live update and cannot select or book it. Clicking the
selected seat again, changing events, or completing a booking releases the hold.
Every hold expires after one minute, even if the first user leaves the seat selected.
The browser automatically clears that selection, and other tabs make the seat
available again at the same deadline.

Selection and booking briefly share a Redis request lock so they cannot race while
checking MongoDB. A separate owner-checked reservation lasts one minute. Release
compares the owner before deleting, so one
browser cannot release another browser's hold.

Booking verifies the active reservation, then asks MongoDB to do this atomically:

```js
Seat.findOneAndUpdate(
  { _id: eventId + '-' + seatLabel, booked: false },
  { $set: { booked: true, bookingId: randomUUID(), bookedAt: new Date() } },
  { new: true },
);
```

The filter requires `booked: false`. The winning request changes it to `true`.
The competing request no longer matches the filter and receives HTTP 409.
The booking reference lives in that same seat document, so the booking is saved
in the same operation as the seat change. There is no separate booking insert.

MongoDB makes a single document update atomic: the availability check and change
cannot be separated by another competing write. This also works when more than
one server handles requests to the same database.

The `booked: false` filter prevents double booking even if a Redis hold expires
during a slow request. `unlockSeat()` checks the request token before removing a
short-lived lock; a failed release is logged and the lock expires automatically.
If Redis is unavailable, selection and booking fail with 503.

Reference: [MongoDB atomic writes](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/).
Lock reference: [Redis locking](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/).

## Request flow

1. `app.js` requests `GET /api/events` and displays event buttons.
2. Choosing an event requests `GET /api/events/:id/seats`.
3. Selecting or unselecting a seat calls `POST` or `DELETE /api/selections`.
4. Socket.io broadcasts temporary holds and releases to other browser tabs.
5. Clicking Book verifies the hold and sends `POST /api/bookings`.
6. The booking browser displays its reference after MongoDB confirms the booking.

Open two tabs, select the same event, and choose a seat in one tab: it becomes
unavailable in the other tab immediately. Reconnect refreshes availability in case
socket events were missed. Booked seats are remembered so a slower HTTP response
cannot overwrite a newer live update. You can still refresh availability manually.

## Check the core behavior

Start both local containers, then run `npm test`.
The test uses a uniquely named temporary database on port 27018 and removes only
that database afterward. It sends 20 simultaneous HTTP requests for A1 and checks
for exactly one successful booking, 19 conflicts, and one booked database record.
It also checks Redis contention and token ownership, live socket notifications,
input validation, event isolation, and public seat responses. Redis tests use a
unique key prefix so they do not contend with the running demo.

## Deliberate limits

This is a learning demo with anonymous bookings. There are no accounts, payments,
or refunds. Seat selections are temporary holds, not paid checkout reservations.
Anyone can book an available seat.
Save the displayed reference before reloading; there is no booking history or
recovery screen. A lost network response can hide a successful booking, so refresh
availability before retrying. Prices come from the server's sample event list.

Run one app instance for this demo. Live broadcasts only reach browsers connected
to that instance; multiple instances would need a Socket.io adapter. The locks and
database protection can be shared, but cross-instance live delivery is not implemented.
There is no durable notification queue: if the server stops after saving, clients
learn the result from their next snapshot. This keeps the example small.

## Accurate resume wording for this version

Built a ticket booking web app with JavaScript, Node.js, Express, and MongoDB.
Added Redis-based seat locking with atomic database updates to prevent double
booking, and real-time seat availability updates using Socket.io.

This version does not use React, TypeScript, Strategy, Factory, or Repository
patterns. The original larger project is backed up separately.

## Deployment

The live demo runs on a free Render web service, with Render Key Value for Redis
and a MongoDB Atlas M0 cluster. Both Render services and the Atlas cluster are in
Singapore. Atlas permits the Render service's outbound IP ranges, and the app's
database user has read/write access to the `gather_beginner` database.

For example, Render web services support WebSocket connections. Build with
`npm ci` and start with `npm start`. Set `MONGODB_URI` and `REDIS_URL` to hosted
service URLs and configure their network access. Use one app instance. Local
Docker addresses cannot work from the cloud. There is no frontend build step.
Connection credentials are configured in Render's environment settings and are
not included in this repository. The previous Vercel-only setup instructions no
longer describe this persistent Socket.io server.

Reference: [WebSockets on Render](https://render.com/docs/websocket).
