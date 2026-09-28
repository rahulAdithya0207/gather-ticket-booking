# Gather — beginner ticket booking

A small web app: choose an event, select one seat, and get a booking reference.
The sample events are demonstrations with no real dates or payments.

## Five application files

| File | Responsibility |
| --- | --- |
| `public/index.html` | The page: events, seats, and booking confirmation |
| `public/style.css` | Colors, spacing, and mobile layout |
| `public/app.js` | Button clicks, requests to the server, and page updates |
| `server.js` | Express routes, MongoDB connection, and booking logic |
| `redis.js` | Two small functions to acquire and release a temporary seat lock |

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

## Booking safety: Redis lock and atomic database update

Two browsers might both show A1 as available. They might click Book together.
Checking availability in JavaScript alone would not protect the seat.

First, `lockSeat()` runs `SET gather:lock:seatId token PX 10000 NX` in Redis.
`NX` means only create the lock if it does not exist. `PX 10000` means it expires
after ten seconds. The random token identifies the request that owns the lock.
Other requests for that seat get HTTP 409 while the lock is held. Servers sharing
the same Redis and key prefix share these locks; this is a distributed lock backed
by one Redis server, not a multi-node Redlock implementation.

The server then asks MongoDB to do this in a single operation:

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

Finally, `unlockSeat()` checks the token and removes the lock using a short Lua
script. Those two steps run together in Redis. An old request cannot remove a
new request's lock. A failed release is logged; the lock expires automatically.
If Redis is unavailable, booking fails with 503. If a lock expires too early,
MongoDB's conditional update still prevents double booking.

Reference: [MongoDB atomic writes](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/).
Lock reference: [Redis locking](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/).

## Request flow

1. `app.js` requests `GET /api/events` and displays event buttons.
2. Choosing an event requests `GET /api/events/:id/seats`.
3. Clicking Book sends `POST /api/bookings` with `eventId` and `seatLabel`.
4. `server.js` validates input, acquires a Redis lock, and performs the atomic update.
5. Socket.io broadcasts `seat:booked` with the event and seat; browsers update that seat.
6. The booking browser displays its reference. The server releases the Redis lock.

Availability updates live after a booking. Open two tabs, select the same event,
and book a seat in one tab: it becomes unavailable in the other tab automatically.
On reconnect, the browser fetches the latest seats because socket events may be
missed while disconnected. It remembers booked seats so a slower HTTP response
cannot overwrite a newer live update. You can still refresh availability manually.
These updates show confirmed bookings, not temporary Redis holds.

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
checkout holds, or refunds. Anyone can book an available seat.
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

## Our next steps

1. Run the smaller app locally and try booking a seat.
2. Resume tutor mode with HTML, browser JavaScript, HTTP, and the server.
3. Explain and demonstrate the atomic booking update with two browser tabs.
4. Push this version to your GitHub repository.
5. Deploy the app to a host supporting a persistent Node.js server, with hosted
   MongoDB and Redis.

For example, Render web services support WebSocket connections. Build with
`npm ci` and start with `npm start`. Set `MONGODB_URI` and `REDIS_URL` to hosted
service URLs and configure their network access. Use one app instance. Local
Docker addresses cannot work from the cloud. There is no frontend build step.
Check available free tiers and limits when we deploy; GitHub and hosting account
access will be needed then. The previous Vercel-only setup instructions no longer
describe this persistent Socket.io server.

Reference: [WebSockets on Render](https://render.com/docs/websocket).
