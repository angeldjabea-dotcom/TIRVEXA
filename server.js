const express = require('express');
const path = require('path');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn(
    'WARNING: JWT_SECRET is not set. Set it before production.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

async function initDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required for the production build.'
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      level INTEGER DEFAULT 1,
      season_points INTEGER DEFAULT 0,
      games INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      best_score INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

app.use(express.json());

app.use(
  express.static(path.join(__dirname, 'public'))
);

const pub = (u) => ({
  id: u.id,
  username: u.username,
  email: u.email,
  level: u.level,
  seasonPoints: u.season_points,
  games: u.games,
  wins: u.wins,
  losses: u.losses,
  bestScore: u.best_score
});

const sign = (u) =>
  jwt.sign(
    {
      id: u.id,
      username: u.username
    },
    JWT_SECRET,
    {
      expiresIn: '30d'
    }
  );

function auth(req, res, next) {
  const h = req.headers.authorization || '';

  try {
    if (!JWT_SECRET || !h.startsWith('Bearer ')) {
      throw new Error('auth');
    }

    req.user = jwt.verify(
      h.slice(7),
      JWT_SECRET
    );

    next();
  } catch {
    res.status(401).json({
      error: 'Connexion requise'
    });
  }
}

/* =========================
   API TIRVEXA
========================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    game: 'TIRVEXA',
    version: 'V5',
    multiplayer: 'Socket.IO 4v4'
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    game: 'TIRVEXA',
    version: 'V5',
    year: 2026,

    season: {
      number: 1,
      name: 'Premier Tir',
      status: 'En cours'
    },

    nextUpdate: '2027 — Saison 2',

    modes: [
      'Match rapide',
      'Match classé',
      'Entraînement'
    ],

    owner: 'DJABEA ANGEL',
    creator: 'DJABEA ANGEL',

    multiplayer: {
      teams: 2,
      playersPerTeam: 4
    }
  });
});

/* =========================
   INSCRIPTION
========================= */

app.post('/api/register', async (req, res) => {
  const username = String(
    req.body.username || ''
  ).trim();

  const email = String(
    req.body.email || ''
  ).trim().toLowerCase();

  const password = String(
    req.body.password || ''
  );

  if (
    username.length < 3 ||
    !email.includes('@') ||
    password.length < 6
  ) {
    return res.status(400).json({
      error:
        'Pseudo, email ou mot de passe invalide.'
    });
  }

  try {
    const hash = await bcrypt.hash(
      password,
      10
    );

    const r = await pool.query(
      `
      INSERT INTO users(
        username,
        email,
        password_hash
      )
      VALUES($1, $2, $3)
      RETURNING *
      `,
      [
        username,
        email,
        hash
      ]
    );

    res.json({
      token: sign(r.rows[0]),
      user: pub(r.rows[0])
    });
  } catch (e) {
    res.status(409).json({
      error:
        'Ce pseudo ou cet email existe déjà.'
    });
  }
});

/* =========================
   CONNEXION
========================= */

app.post('/api/login', async (req, res) => {
  const email = String(
    req.body.email || ''
  ).trim().toLowerCase();

  const password = String(
    req.body.password || ''
  );

  const r = await pool.query(
    'SELECT * FROM users WHERE email=$1',
    [email]
  );

  const u = r.rows[0];

  if (
    !u ||
    !(await bcrypt.compare(
      password,
      u.password_hash
    ))
  ) {
    return res.status(401).json({
      error:
        'Email ou mot de passe incorrect.'
    });
  }

  res.json({
    token: sign(u),
    user: pub(u)
  });
});

/* =========================
   PROFIL
========================= */

app.get('/api/me', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM users WHERE id=$1',
    [req.user.id]
  );

  if (!r.rows[0]) {
    return res.status(404).json({
      error: 'Compte introuvable'
    });
  }

  res.json({
    user: pub(r.rows[0])
  });
});

/* =========================
   RESULTAT D'UNE PARTIE
========================= */

app.post(
  '/api/game-result',
  auth,
  async (req, res) => {
    const score = Math.max(
      0,
      Number(req.body.score) || 0
    );

    const won = Boolean(
      req.body.won
    );

    const mode = String(
      req.body.mode || 'quick'
    );

    const points =
      mode === 'ranked'
        ? (
            won
              ? Math.max(
                  25,
                  Math.floor(score / 4)
                )
              : -10
          )
        : (
            won
              ? Math.max(
                  10,
                  Math.floor(score / 6)
                )
              : 0
          );

    const r = await pool.query(
      `
      UPDATE users
      SET
        games = games + 1,
        wins = wins + $1,
        losses = losses + $2,
        season_points =
          GREATEST(
            0,
            season_points + $3
          ),
        best_score =
          GREATEST(
            best_score,
            $4
          ),
        level =
          1 +
          (
            GREATEST(
              0,
              season_points + $3
            ) / 500
          )::integer
      WHERE id = $5
      RETURNING *
      `,
      [
        won ? 1 : 0,
        won ? 0 : 1,
        points,
        score,
        req.user.id
      ]
    );

    res.json({
      user: pub(r.rows[0]),
      points
    });
  }
);

/* =========================
   CLASSEMENT
========================= */

app.get(
  '/api/leaderboard',
  async (req, res) => {
    const r = await pool.query(`
      SELECT
        username,
        level,
        season_points AS "seasonPoints",
        wins,
        losses,
        games,
        best_score AS "bestScore"
      FROM users
      ORDER BY
        season_points DESC,
        best_score DESC
      LIMIT 50
    `);

    res.json({
      season: {
        number: 1,
        name: 'Premier Tir',
        status: 'En cours'
      },

      leaderboard: r.rows
    });
  }
);

/* =========================
   MULTIJOUEUR TEMPS REEL
   4 VS 4
========================= */

const MAX_PLAYERS = 8;

const queue = [];
const rooms = new Map();
const sockets = new Map();

function roomSnapshot(room) {
  return {
    roomId: room.id,
    mode: room.mode,
    status: room.status,

    players: room.players.map(
      (p) => ({
        id: p.id,
        username: p.username,
        team: p.team,
        ready: p.ready,
        score: p.score
      })
    )
  };
}

function broadcastRoom(room) {
  io.to(room.id).emit(
    'room:state',
    roomSnapshot(room)
  );
}

function removeFromQueue(id) {
  const i = queue.findIndex(
    (x) => x.id === id
  );

  if (i >= 0) {
    queue.splice(i, 1);
  }
}

function makeRoom() {
  const picked = queue.splice(
    0,
    MAX_PLAYERS
  );

  if (picked.length < MAX_PLAYERS) {
    queue.unshift(...picked);
    return null;
  }

  const room = {
    id:
      'room_' +
      Date.now() +
      '_' +
      Math.random()
        .toString(36)
        .slice(2, 7),

    mode: picked[0].mode,

    status: 'waiting',

    players: picked.map(
      (x, i) => ({
        id: x.id,
        username: x.username,
        team: i < 4 ? 1 : 2,
        ready: false,
        score: 0
      })
    )
  };

  rooms.set(
    room.id,
    room
  );

  picked.forEach((x) => {
    x.socket.join(room.id);
    x.roomId = room.id;
  });

  broadcastRoom(room);

  return room;
}

function tryMatch() {
  while (
    queue.length >= MAX_PLAYERS
  ) {
    makeRoom();
  }
}

/* =========================
   AUTHENTIFICATION SOCKET
========================= */

io.use(
  (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token;

      if (
        !JWT_SECRET ||
        !token
      ) {
        throw new Error('auth');
      }

      socket.user =
        jwt.verify(
          token,
          JWT_SECRET
        );

      sockets.set(
        socket.user.id,
        socket
      );

      next();
    } catch {
      next(
        new Error(
          'Authentification requise'
        )
      );
    }
  }
);

/* =========================
   CONNEXION JOUEUR
========================= */

io.on(
  'connection',
  (socket) => {
    socket.emit(
      'mp:connected',
      {
        username:
          socket.user.username
      }
    );

    /* =====================
       RECHERCHE DE PARTIE
    ===================== */

    socket.on(
      'matchmaking:join',
      ({ mode = 'ranked' } = {}) => {
        removeFromQueue(
          socket.user.id
        );

        const entry = {
          id: socket.user.id,
          username:
            socket.user.username,
          socket,
          mode,
          roomId: null
        };

        queue.push(entry);

        socket.emit(
          'matchmaking:queued',
          {
            position:
              queue.length,

            playersNeeded:
              MAX_PLAYERS
          }
        );

        tryMatch();
      }
    );

    /* =====================
       ANNULER RECHERCHE
    ===================== */

    socket.on(
      'matchmaking:cancel',
      () => {
        removeFromQueue(
          socket.user.id
        );

        socket.emit(
          'matchmaking:cancelled'
        );
      }
    );

    /* =====================
       PRET / PAS PRET
    ===================== */

    socket.on(
      'room:ready',
      (ready) => {
        const room =
          [
            ...rooms.values()
          ].find(
            (r) =>
              r.players.some(
                (p) =>
                  p.id ===
                  socket.user.id
              )
          );

        if (!room) return;

        const p =
          room.players.find(
            (p) =>
              p.id ===
              socket.user.id
          );

        p.ready =
          Boolean(ready);

        broadcastRoom(room);

        if (
          room.players.length ===
            MAX_PLAYERS &&
          room.players.every(
            (p) => p.ready
          )
        ) {
          room.status =
            'starting';

          broadcastRoom(room);

          setTimeout(
            () => {
              room.status =
                'playing';

              room.startedAt =
                Date.now();

              broadcastRoom(room);

              io.to(
                room.id
              ).emit(
                'game:start',
                {
                  roomId:
                    room.id,

                  startedAt:
                    room.startedAt,

                  mode:
                    room.mode
                }
              );
            },
            2500
          );
        }
      }
    );

    /* =====================
       TIR
    ===================== */

    socket.on(
      'player:shoot',
      (data) => {
        const room =
          [
            ...rooms.values()
          ].find(
            (r) =>
              r.players.some(
                (p) =>
                  p.id ===
                  socket.user.id
              )
          );

        if (
          !room ||
          room.status !==
            'playing'
        ) {
          return;
        }

        io.to(
          room.id
        ).emit(
          'player:shoot',
          {
            playerId:
              socket.user.id,

            username:
              socket.user.username,

            x:
              Number(
                data?.x
              ) || 0,

            y:
              Number(
                data?.y
              ) || 0
          }
        );
      }
    );

    /* =====================
       DEPLACEMENT
    ===================== */

    socket.on(
      'player:move',
      (data) => {
        const room =
          [
            ...rooms.values()
          ].find(
            (r) =>
              r.players.some(
                (p) =>
                  p.id ===
                  socket.user.id
              )
          );

        if (
          !room ||
          room.status !==
            'playing'
        ) {
          return;
        }

        socket
          .to(room.id)
          .emit(
            'player:move',
            {
              playerId:
                socket.user.id,

              x:
                Number(
                  data?.x
                ) || 0,

              y:
                Number(
                  data?.y
                ) || 0
            }
          );
      }
    );

    /* =====================
       SCORE
    ===================== */

    socket.on(
      'game:score',
      ({ points = 0 } = {}) => {
        const room =
          [
            ...rooms.values()
          ].find(
            (r) =>
              r.players.some(
                (p) =>
                  p.id ===
                  socket.user.id
              )
          );

        if (
          !room ||
          room.status !==
            'playing'
        ) {
          return;
        }

        const p =
          room.players.find(
            (p) =>
              p.id ===
              socket.user.id
          );

        p.score += Math.max(
          0,
          Number(points) || 0
        );

        io.to(
          room.id
        ).emit(
          'room:score',
          {
            playerId: p.id,
            score: p.score
          }
        );
      }
    );

    /* =====================
       FIN DE PARTIE
    ===================== */

    socket.on(
      'game:finish',
      async ({
        won = false,
        score = 0
      } = {}) => {
        try {
          const room =
            [
              ...rooms.values()
            ].find(
              (r) =>
                r.players.some(
                  (p) =>
                    p.id ===
                    socket.user.id
                )
            );

          if (!room) return;

          room.status =
            'finished';

          io.to(
            room.id
          ).emit(
            'game:finish',
            {
              winner:
                Boolean(won)
            }
          );

          const pts =
            room.mode ===
            'ranked'
              ? (
                  won
                    ? Math.max(
                        25,
                        Math.floor(
                          Number(
                            score
                          ) / 4
                        )
                      )
                    : -10
                )
              : (
                  won
                    ? Math.max(
                        10,
                        Math.floor(
                          Number(
                            score
                          ) / 6
                        )
                      )
                    : 0
                );

          await pool.query(
            `
            UPDATE users
            SET
              games =
                games + 1,

              wins =
                wins + $1,

              losses =
                losses + $2,

              season_points =
                GREATEST(
                  0,
                  season_points + $3
                ),

              best_score =
                GREATEST(
                  best_score,
                  $4
                ),

              level =
                1 +
                (
                  GREATEST(
                    0,
                    season_points + $3
                  ) / 500
                )::integer

            WHERE id = $5
            `,
            [
              won ? 1 : 0,
              won ? 0 : 1,
              pts,
              Math.max(
                0,
                Number(score) || 0
              ),
              socket.user.id
            ]
          );
        } catch (e) {
          socket.emit(
            'mp:error',
            {
              error:
                'Impossible d’enregistrer le résultat.'
            }
          );
        }
      }
    );

    /* =====================
       DECONNEXION
    ===================== */

    socket.on(
      'disconnect',
      () => {
        removeFromQueue(
          socket.user.id
        );

        for (
          const [
            rid,
            room
          ] of rooms
        ) {
          const idx =
            room.players.findIndex(
              (p) =>
                p.id ===
                socket.user.id
            );

          if (idx >= 0) {
            room.players.splice(
              idx,
              1
            );

            if (
              room.players
                .length === 0
            ) {
              rooms.delete(
                rid
              );
            } else {
              broadcastRoom(
                room
              );
            }
          }
        }

        sockets.delete(
          socket.user.id
        );
      }
    );
  }
);

/* =========================
   PAGE PRINCIPALE
========================= */

app.use(
  (req, res) =>
    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    )
);

/* =========================
   DEMARRAGE SERVEUR
========================= */

initDb()
  .then(() => {
    httpServer.listen(
      PORT,
      '0.0.0.0',
      () => {
        console.log(
          `TIRVEXA V5 HTTP + Socket.IO on port ${PORT}`
        );
      }
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
