require('dotenv').config()
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:/tmp/vecher-seans.db'
}

const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')

const app = express()
const prisma = new PrismaClient()

app.use(cors({
  origin: [
    'https://vecher-seans-client-production.up.railway.app',
    'http://localhost:5173',
    /\.railway\.app$/,
  ],
  credentials: true,
}))
app.use(express.json())

app.get('/', (req, res) => res.json({ status: 'ok', app: 'Вечерний сеанс API' }))

const JWT_SECRET = process.env.JWT_SECRET || 'vecher-seans-secret'
const OMDB_KEY = process.env.OMDB_API_KEY
const PORT = process.env.PORT || 3001

// ─── Helpers ───────────────────────────────────────────────────────────────────
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Не авторизован' })
  }
  try {
    req.user = jwt.verify(auth.split(' ')[1], JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ message: 'Токен недействителен' })
  }
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, avatar, familyAction, familyName, familyCode } = req.body

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Заполните все обязательные поля' })
    }

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) return res.status(400).json({ message: 'Email уже используется' })

    const hashed = await bcrypt.hash(password, 10)

    let familyId = null
    if (familyAction === 'create') {
      if (!familyName) return res.status(400).json({ message: 'Введите название семьи' })
      const family = await prisma.family.create({
        data: { name: familyName, code: generateCode() },
      })
      familyId = family.id
    } else if (familyAction === 'join') {
      if (!familyCode) return res.status(400).json({ message: 'Введите код семьи' })
      const family = await prisma.family.findUnique({
        where: { code: familyCode.toUpperCase() },
      })
      if (!family) return res.status(404).json({ message: 'Семья с таким кодом не найдена' })
      familyId = family.id
    }

    const user = await prisma.user.create({
      data: { name, email, password: hashed, avatar: avatar || '🧑', familyId },
    })

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' })
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar },
    })
  } catch (err) {
    console.error('register error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return res.status(401).json({ message: 'Неверный email или пароль' })

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return res.status(401).json({ message: 'Неверный email или пароль' })

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' })
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, avatar: user.avatar },
    })
  } catch (err) {
    console.error('login error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, avatar: true, familyId: true },
    })
    if (!user) return res.status(404).json({ message: 'Пользователь не найден' })
    res.json({ user })
  } catch (err) {
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ─── Family ────────────────────────────────────────────────────────────────────
app.get('/api/family', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        family: {
          include: {
            users: { select: { id: true, name: true, avatar: true } },
          },
        },
      },
    })
    if (!user?.family) return res.status(404).json({ message: 'Семья не найдена' })
    res.json({ family: user.family })
  } catch (err) {
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ─── Movies ────────────────────────────────────────────────────────────────────
app.get('/api/movies/search', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query
    if (!q) return res.status(400).json({ message: 'Введите запрос' })

    if (!OMDB_KEY || OMDB_KEY === 'your_omdb_api_key_here') {
      return res.status(503).json({ message: 'OMDB_API_KEY не задан в .env файле' })
    }

    const url = `https://www.omdbapi.com/?s=${encodeURIComponent(q)}&apikey=${OMDB_KEY}&type=movie`
    const response = await fetch(url)
    const data = await response.json()

    if (data.Response === 'False') {
      return res.json({ results: [] })
    }

    // Fetch full details for first 8 results in parallel for rich data
    const basic = (data.Search || []).slice(0, 8)
    const detailed = await Promise.allSettled(
      basic.map((m) =>
        fetch(`https://www.omdbapi.com/?i=${m.imdbID}&apikey=${OMDB_KEY}`)
          .then((r) => r.json())
          .catch(() => m),
      ),
    )

    const results = detailed.map((r, i) =>
      r.status === 'fulfilled' && r.value.Response !== 'False' ? r.value : basic[i],
    )

    res.json({ results })
  } catch (err) {
    console.error('search error:', err)
    res.status(500).json({ message: 'Ошибка поиска' })
  }
})

app.post('/api/movies/watchlist', authMiddleware, async (req, res) => {
  try {
    const {
      imdbId, status,
      title, poster, year, genre, plot, director, actors, imdbRating, runtime,
    } = req.body

    if (!imdbId) return res.status(400).json({ message: 'imdbId обязателен' })

    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!user?.familyId) return res.status(400).json({ message: 'Сначала вступите в семью' })

    const movie = await prisma.movie.upsert({
      where: { imdbId },
      update: {
        ...(poster     && { poster }),
        ...(title      && { title }),
        ...(year       && { year }),
        ...(genre      && { genre }),
        ...(plot       && { plot }),
        ...(director   && { director }),
        ...(actors     && { actors }),
        ...(imdbRating && { imdbRating }),
        ...(runtime    && { runtime }),
      },
      create: {
        imdbId,
        title:      title      || imdbId,
        poster:     poster     || null,
        year:       year       || null,
        genre:      genre      || null,
        plot:       plot       || null,
        director:   director   || null,
        actors:     actors     || null,
        imdbRating: imdbRating || null,
        runtime:    runtime    || null,
      },
    })

    const entry = await prisma.watchlistEntry.upsert({
      where: { userId_movieId: { userId: user.id, movieId: movie.id } },
      update: { status: status || 'WANT' },
      create: { userId: user.id, movieId: movie.id, status: status || 'WANT' },
    })

    res.json({ entry, movie })
  } catch (err) {
    console.error('watchlist post error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// DELETE by imdbId in URL path
app.delete('/api/movies/watchlist/:imdbId', authMiddleware, async (req, res) => {
  try {
    const { imdbId } = req.params
    const movie = await prisma.movie.findUnique({ where: { imdbId } })
    if (!movie) return res.status(404).json({ message: 'Фильм не найден' })

    await prisma.watchlistEntry.deleteMany({
      where: { userId: req.user.id, movieId: movie.id },
    })
    res.json({ message: 'Удалено' })
  } catch (err) {
    console.error('watchlist delete error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// DELETE by imdbId in request body
app.delete('/api/movies/watchlist', authMiddleware, async (req, res) => {
  try {
    const { imdbId } = req.body
    if (!imdbId) return res.status(400).json({ message: 'imdbId обязателен' })

    const movie = await prisma.movie.findUnique({ where: { imdbId } })
    if (!movie) return res.status(404).json({ message: 'Фильм не найден' })

    await prisma.watchlistEntry.deleteMany({
      where: { userId: req.user.id, movieId: movie.id },
    })
    res.json({ message: 'Удалено' })
  } catch (err) {
    console.error('watchlist delete body error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

app.get('/api/movies/intersections', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!user?.familyId) return res.status(400).json({ message: 'Нет семьи' })

    const familyUsers = await prisma.user.findMany({ where: { familyId: user.familyId } })
    const familyUserIds = familyUsers.map((u) => u.id)

    if (familyUserIds.length < 2) {
      return res.json({ movies: [] })
    }

    const movies = await prisma.movie.findMany({
      where: {
        watchlist: {
          some: { userId: { in: familyUserIds }, status: 'WANT' },
        },
      },
      include: {
        watchlist: {
          where: { userId: { in: familyUserIds } },
          include: { user: { select: { id: true, name: true, avatar: true } } },
        },
      },
    })

    // Keep only movies where ALL family members have status WANT
    const filtered = movies.filter((m) => {
      const wantIds = m.watchlist.filter((w) => w.status === 'WANT').map((w) => w.userId)
      return familyUserIds.every((uid) => wantIds.includes(uid))
    })

    res.json({ movies: filtered })
  } catch (err) {
    console.error('intersections error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

app.get('/api/movies/family', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } })
    if (!user?.familyId) return res.status(400).json({ message: 'Нет семьи' })

    const familyUsers = await prisma.user.findMany({ where: { familyId: user.familyId } })
    const familyUserIds = familyUsers.map((u) => u.id)

    const movies = await prisma.movie.findMany({
      where: {
        watchlist: { some: { userId: { in: familyUserIds } } },
      },
      include: {
        watchlist: {
          where: { userId: { in: familyUserIds } },
          include: { user: { select: { id: true, name: true, avatar: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ movies })
  } catch (err) {
    console.error('family movies error:', err)
    res.status(500).json({ message: 'Ошибка сервера' })
  }
})

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Вечерний сеанс backend запущен: http://localhost:${PORT}`)
  console.log(`📂 DATABASE_URL: ${process.env.DATABASE_URL}`)
  if (!OMDB_KEY || OMDB_KEY === 'your_omdb_api_key_here') {
    console.warn('⚠️  OMDB_API_KEY не задан!')
  }
  const { exec } = require('child_process')
  exec('npx prisma db push --accept-data-loss', (err, stdout, stderr) => {
    if (err) console.error('db push error:', stderr)
    else console.log('✅ DB ready')
  })
})
