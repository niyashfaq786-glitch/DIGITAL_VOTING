const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'digital-voting.db');

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'digital-voting-system-development-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

const db = new sqlite3.Database(DB_PATH);

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderLayout({ title, user, body, nav = '' }) {
  const userDisplay = user ? `${user.name} (${user.role})` : 'Guest';
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(title)}</title>
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>
      <header class="topbar">
        <div class="brand-wrap">
          <div class="brand-mark">DV</div>
          <div>
            <div class="brand-title">Digital Voting System</div>
            <div class="brand-subtitle">College Elections</div>
          </div>
        </div>
        <div class="topbar-actions">
          ${user ? `<span class="user-pill">${escapeHtml(userDisplay)}</span><a class="nav-link" href="/logout">Logout</a>` : `<a class="nav-link" href="/">Login</a>`}
        </div>
      </header>
      <nav class="main-nav">${nav}</nav>
      <main class="container">${body}</main>
    </body>
    </html>
  `;
}

function formatDate(dateString) {
  if (!dateString) return 'Not set';
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function getElectionState(election) {
  const now = new Date();
  const start = new Date(election.start_at);
  const end = new Date(election.end_at);

  if (election.status === 'draft') return 'Draft';
  if (election.result_published) return 'Result Published';
  if (now < start) return 'Scheduled';
  if (now > end) return 'Closed';
  return 'Active';
}

function getStatusBadgeClass(state) {
  if (state === 'Active') return 'status-badge status-active';
  if (state === 'Scheduled') return 'status-badge status-scheduled';
  if (state === 'Closed') return 'status-badge status-closed';
  if (state === 'Result Published') return 'status-badge status-published';
  return 'status-badge';
}

function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function queryOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes, rowCount: this.changes });
    });
  });
}

async function seedDatabase() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('student','admin')),
      student_id TEXT UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      department TEXT,
      year TEXT,
      batch TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS elections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      department TEXT,
      year TEXT,
      batch TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      status TEXT DEFAULT 'scheduled',
      result_published INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY (election_id) REFERENCES elections(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id INTEGER NOT NULL,
      position_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      department TEXT,
      year TEXT,
      photo_url TEXT DEFAULT '',
      symbol TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      FOREIGN KEY (election_id) REFERENCES elections(id),
      FOREIGN KEY (position_id) REFERENCES positions(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id INTEGER NOT NULL,
      position_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      candidate_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(election_id, position_id, student_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS voter_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      election_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      status TEXT DEFAULT 'not_voted',
      voted_at TEXT,
      UNIQUE(election_id, student_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER,
      actor_name TEXT,
      action TEXT,
      details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const existingAdmin = await queryOne('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
  if (!existingAdmin) {
    const adminPassword = await bcrypt.hash('admin123', 10);
    const studentPassword = await bcrypt.hash('student123', 10);

    const adminId = (await run(
      'INSERT INTO users (role, student_id, name, password_hash, department, year, batch, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ['admin', 'ADMIN-001', 'System Administrator', adminPassword, 'Administration', 'N/A', 'N/A', 'active']
    )).id;

    const sampleStudents = [
      ['S1001', 'Aisha Rahman', 'CTH', '2', '2024', 'active'],
      ['S1002', 'Daniel Reed', 'CTH', '2', '2024', 'active'],
      ['S1003', 'Priya Nair', 'ECE', '3', '2023', 'active'],
      ['S1004', 'James Carter', 'EEE', '1', '2025', 'active'],
      ['S1005', 'Mina Patel', 'CTH', '2', '2024', 'active'],
      ['S1006', 'Omar Hassan', 'CSE', '4', '2022', 'active']
    ];

    for (const [studentId, name, department, year, batch, status] of sampleStudents) {
      await run('INSERT INTO users (role, student_id, name, password_hash, department, year, batch, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['student', studentId, name, studentPassword, department, year, batch, status]);
    }

    const electionStart = new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString();
    const electionEnd = new Date(Date.now() + 1000 * 60 * 60 * 30).toISOString();

    const electionId = (await run(
      'INSERT INTO elections (title, description, department, year, batch, start_at, end_at, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['College Union Election 2026', 'Leadership election for the student union governing body.', 'CTH', '2', '2024', electionStart, electionEnd, 'active', adminId]
    )).id;

    const positions = ['Chairman', 'General Secretary', 'Arts Secretary', 'Sports Secretary'];
    const insertedPositions = [];
    for (const name of positions) {
      const position = await run('INSERT INTO positions (election_id, name) VALUES (?, ?)', [electionId, name]);
      insertedPositions.push(position.id);
    }

    const positionCandidates = {
      [insertedPositions[0]]: ['Aisha Rahman', 'Daniel Reed'],
      [insertedPositions[1]]: ['Mina Patel', 'Omar Hassan'],
      [insertedPositions[2]]: ['Priya Nair', 'James Carter'],
      [insertedPositions[3]]: ['Daniel Reed', 'Aisha Rahman']
    };

    for (const [positionId, candidateNames] of Object.entries(positionCandidates)) {
      for (const name of candidateNames) {
        await run(
          'INSERT INTO candidates (election_id, position_id, name, department, year, photo_url, symbol, bio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [electionId, Number(positionId), name, 'CTH', '2', '', '✦', `Campaign profile for ${name}.`]
        );
      }
    }

    const scheduledStart = new Date(Date.now() + 1000 * 60 * 60 * 36).toISOString();
    const scheduledEnd = new Date(Date.now() + 1000 * 60 * 60 * 72).toISOString();
    const scheduledElectionId = (await run(
      'INSERT INTO elections (title, description, department, year, batch, start_at, end_at, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['Department Representative Election', 'Leadership election for department delegates.', 'ECE', '3', '2023', scheduledStart, scheduledEnd, 'scheduled', adminId]
    )).id;

    const scheduledPositionId = (await run('INSERT INTO positions (election_id, name) VALUES (?, ?)', [scheduledElectionId, 'Department Representative'])).id;
    await run('INSERT INTO candidates (election_id, position_id, name, department, year, photo_url, symbol, bio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [scheduledElectionId, scheduledPositionId, 'Priya Nair', 'ECE', '3', '', '●', 'Department candidate profile.']);

    await run('INSERT INTO audit_logs (actor_id, actor_name, action, details) VALUES (?, ?, ?, ?)', [adminId, 'System Administrator', 'seed_demo_data', 'Created default student accounts and a sample election.']);
  }
}

async function ensureAuthenticated(req, res, role) {
  if (!req.session.user || req.session.user.role !== role) {
    return false;
  }
  return true;
}

async function studentIsEligibleForElection(student, election) {
  if (!student || !election) return false;
  const checks = [];
  if (election.department) checks.push(student.department === election.department);
  if (election.year) checks.push(student.year === election.year);
  if (election.batch) checks.push(student.batch === election.batch);
  if (checks.length === 0) return true;
  return checks.every(Boolean);
}

async function getUserById(id) {
  return queryOne('SELECT * FROM users WHERE id = ?', [id]);
}

async function getElectionAndStats(electionId) {
  const election = await queryOne('SELECT * FROM elections WHERE id = ?', [electionId]);
  if (!election) return null;

  const positions = await query('SELECT * FROM positions WHERE election_id = ? ORDER BY id', [electionId]);
  const results = [];

  for (const position of positions) {
    const candidates = await query('SELECT * FROM candidates WHERE position_id = ? ORDER BY id', [position.id]);
    const counts = [];
    for (const candidate of candidates) {
      const row = await queryOne('SELECT COUNT(*) as total FROM votes WHERE position_id = ? AND candidate_id = ?', [position.id, candidate.id]);
      counts.push({ candidate, total: row ? row.total : 0 });
    }
    const winner = counts.reduce((best, item) => (!best || item.total > best.total ? item : best), null);
    results.push({ position, candidates, counts, winner });
  }

  return { election, results };
}

app.get('/', (req, res) => {
  const body = `
    <section class="auth-layout">
      <div class="auth-card hero-panel">
        <div class="eyebrow">College Governance</div>
        <h1>Secure Digital Voting for Student Elections</h1>
        <p>Modern ballot management for college elections, real-time results, and transparent voting statistics.</p>
        <ul class="feature-list">
          <li>Student login and eligibility checks</li>
          <li>Admin dashboard and election controls</li>
          <li>Result publication and audit logging</li>
        </ul>
      </div>
      <div class="auth-card login-panel">
        <h2>Student Login</h2>
        <form method="POST" action="/login/student">
          <label>Student ID</label>
          <input type="text" name="student_id" placeholder="S1001" required />
          <label>Password</label>
          <input type="password" name="password" placeholder="student123" required />
          <button class="primary-btn" type="submit">Sign In</button>
        </form>

        <div class="divider"><span>OR</span></div>

        <h2>Admin Login</h2>
        <form method="POST" action="/login/admin">
          <label>Admin ID</label>
          <input type="text" name="student_id" placeholder="ADMIN-001" required />
          <label>Password</label>
          <input type="password" name="password" placeholder="admin123" required />
          <button class="secondary-btn" type="submit">Admin Access</button>
        </form>
      </div>
    </section>
  `;

  res.send(renderLayout({ title: 'Digital Voting System', body }));
});

app.post('/login/student', async (req, res) => {
  const { student_id, password } = req.body;
  const user = await queryOne('SELECT * FROM users WHERE role = ? AND student_id = ?', ['student', student_id]);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    const body = `
      <section class="alert-box error-box">
        <h2>Login failed</h2>
        <p>Invalid student ID or password.</p>
        <a class="primary-btn" href="/">Try again</a>
      </section>
    `;
    return res.send(renderLayout({ title: 'Login Failed', body }));
  }

  req.session.user = { id: user.id, role: user.role, name: user.name, student_id: user.student_id, department: user.department, year: user.year, batch: user.batch };
  res.redirect('/student/dashboard');
});

app.post('/login/admin', async (req, res) => {
  const { student_id, password } = req.body;
  const user = await queryOne('SELECT * FROM users WHERE role = ? AND student_id = ?', ['admin', student_id]);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    const body = `
      <section class="alert-box error-box">
        <h2>Access denied</h2>
        <p>Invalid admin credentials.</p>
        <a class="primary-btn" href="/">Try again</a>
      </section>
    `;
    return res.send(renderLayout({ title: 'Access Denied', body }));
  }

  req.session.user = { id: user.id, role: user.role, name: user.name, student_id: user.student_id, department: user.department, year: user.year, batch: user.batch };
  res.redirect('/admin/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/student/dashboard', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'student'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const elections = await query('SELECT * FROM elections ORDER BY start_at DESC');
  const studentEntries = [];

  for (const election of elections) {
    const eligible = await studentIsEligibleForElection(user, election);
    const totalVotes = await queryOne('SELECT COUNT(*) as total FROM votes v JOIN positions p ON p.id = v.position_id WHERE p.election_id = ? AND v.student_id = ?', [election.id, user.id]);
    const voted = totalVotes && Number(totalVotes.total) > 0;
    const state = getElectionState(election);
    studentEntries.push({ election, eligible, voted, state });
  }

  const nav = `
    <a class="nav-link" href="/student/dashboard">My Dashboard</a>
    <a class="nav-link" href="/student/results">Published Results</a>
  `;

  const body = `
    <section class="page-header">
      <div>
        <div class="eyebrow">Student Panel</div>
        <h1>Welcome, ${escapeHtml(user.name)}</h1>
      </div>
      <div class="meta-card compact">
        <p>Department</p>
        <strong>${escapeHtml(user.department || 'N/A')}</strong>
      </div>
    </section>

    <section class="stats-grid">
      <div class="stat-card"><span>Total Elections</span><strong>${elections.length}</strong></div>
      <div class="stat-card"><span>Eligible</span><strong>${studentEntries.filter(({ eligible }) => eligible).length}</strong></div>
      <div class="stat-card"><span>Voted</span><strong>${studentEntries.filter(({ voted }) => voted).length}</strong></div>
      <div class="stat-card"><span>Results Published</span><strong>${elections.filter((e) => e.result_published).length}</strong></div>
    </section>

    <section class="panel">
      <h2>Available Elections</h2>
      <div class="list-stack">
        ${studentEntries.map(({ election, eligible, voted, state }) => `
          <div class="election-card">
            <div>
              <div class="title-row">
                <h3>${escapeHtml(election.title)}</h3>
                <span class="${getStatusBadgeClass(state)}">${state}</span>
              </div>
              <p>${escapeHtml(election.description || 'No description provided.')}</p>
              <small>Start: ${formatDate(election.start_at)}<br />End: ${formatDate(election.end_at)}</small>
            </div>
            <div class="card-actions">
              <div class="tag-box">${eligible ? 'Eligible' : 'Not eligible'}</div>
              <div class="tag-box">${voted ? 'Voted' : 'Not voted'}</div>
              ${state === 'Active' && eligible && !voted ? `<a class="primary-btn small-btn" href="/student/election/${election.id}">Vote Now</a>` : `<a class="secondary-btn small-btn" href="/student/election/${election.id}">View</a>`}
            </div>
          </div>
        `).join('') || '<p>No elections are registered yet.</p>'}
      </div>
    </section>
  `;

  res.send(renderLayout({ title: 'Student Dashboard', user, nav, body }));
});

app.get('/student/election/:id', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'student'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const election = await queryOne('SELECT * FROM elections WHERE id = ?', [req.params.id]);
  if (!election) {
    return res.send(renderLayout({ title: 'Election Not Found', user, body: '<section class="alert-box error-box"><h2>Election not found</h2><a class="primary-btn" href="/student/dashboard">Back</a></section>' }));
  }

  const eligible = await studentIsEligibleForElection(user, election);
  const state = getElectionState(election);
  const positions = await query('SELECT * FROM positions WHERE election_id = ? ORDER BY id', [election.id]);

  const positionRows = [];
  for (const position of positions) {
    const candidates = await query('SELECT * FROM candidates WHERE position_id = ? ORDER BY id', [position.id]);
    const hasVoted = await queryOne('SELECT * FROM votes WHERE election_id = ? AND position_id = ? AND student_id = ?', [election.id, position.id, user.id]);
    positionRows.push({ position, candidates, hasVoted });
  }

  const nav = `
    <a class="nav-link" href="/student/dashboard">Back to Dashboard</a>
    <a class="nav-link" href="/student/results">Results</a>
  `;

  const body = `
    <section class="page-header">
      <div>
        <div class="eyebrow">Voting</div>
        <h1>${escapeHtml(election.title)}</h1>
      </div>
      <span class="${getStatusBadgeClass(state)}">${state}</span>
    </section>

    <section class="panel election-detail-box">
      <p>${escapeHtml(election.description || 'No description available')}</p>
      <div class="meta-row">
        <span>Eligible group: ${escapeHtml(election.department || 'All')} / ${escapeHtml(election.year || 'All')} / ${escapeHtml(election.batch || 'All')}</span>
        <span>Voting window: ${formatDate(election.start_at)} to ${formatDate(election.end_at)}</span>
      </div>
    </section>

    ${!eligible ? '<section class="alert-box warn-box"><h2>Not eligible</h2><p>This election is restricted to specific department, year, or batch requirements.</p></section>' : ''}
    ${state !== 'Active' ? '<section class="alert-box warn-box"><h2>Voting is closed</h2><p>This election is not currently accepting votes.</p></section>' : ''}

    <section class="panel">
      <h2>Positions and Candidates</h2>
      <div class="position-stack">
        ${positionRows.map(({ position, candidates, hasVoted }) => `
          <form class="position-card" method="POST" action="/student/vote">
            <input type="hidden" name="electionId" value="${election.id}" />
            <input type="hidden" name="positionId" value="${position.id}" />
            <div class="title-row">
              <h3>${escapeHtml(position.name)}</h3>
              ${hasVoted ? '<span class="tag-box success">Voted</span>' : ''}
            </div>
            <div class="candidate-grid">
              ${candidates.map((candidate) => `
                <label class="candidate-option">
                  <input type="radio" name="candidateId" value="${candidate.id}" ${!eligible || state !== 'Active' || hasVoted ? 'disabled' : ''} required />
                  <div class="candidate-info">
                    <div class="candidate-avatar">${escapeHtml(candidate.photo_url || candidate.name.charAt(0).toUpperCase())}</div>
                    <div>
                      <strong>${escapeHtml(candidate.name)}</strong>
                      <span>${escapeHtml(candidate.department || 'N/A')} • ${escapeHtml(candidate.year || 'N/A')}</span>
                      <em>${escapeHtml(candidate.symbol || 'Symbol')}</em>
                    </div>
                  </div>
                </label>
              `).join('') || '<p>No candidates assigned to this position yet.</p>'}
            </div>
            ${eligible && state === 'Active' && !hasVoted ? '<button class="primary-btn" type="submit">Confirm Vote</button>' : ''}
          </form>
        `).join('')}
      </div>
    </section>
  `;

  res.send(renderLayout({ title: `${election.title} - Voting`, user, nav, body }));
});

app.post('/student/vote', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'student'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const { electionId, positionId, candidateId } = req.body;

  if (!electionId || !positionId || !candidateId) {
    return res.redirect('/student/dashboard?error=' + encodeURIComponent('Please select a valid candidate.'));
  }

  const election = await queryOne('SELECT * FROM elections WHERE id = ?', [electionId]);
  if (!election) {
    return res.redirect('/student/dashboard?error=' + encodeURIComponent('Election not found.'));
  }

  const eligible = await studentIsEligibleForElection(user, election);
  if (!eligible || getElectionState(election) !== 'Active') {
    return res.redirect('/student/dashboard?error=' + encodeURIComponent('This election is not accepting votes from your account.'));
  }

  const position = await queryOne('SELECT * FROM positions WHERE id = ? AND election_id = ?', [positionId, electionId]);
  const candidate = await queryOne('SELECT * FROM candidates WHERE id = ? AND election_id = ? AND position_id = ?', [candidateId, electionId, positionId]);

  if (!position || !candidate) {
    return res.redirect('/student/dashboard?error=' + encodeURIComponent('Invalid candidate or position.'));
  }

  const existingVote = await queryOne('SELECT * FROM votes WHERE election_id = ? AND position_id = ? AND student_id = ?', [electionId, positionId, user.id]);
  if (existingVote) {
    return res.redirect('/student/dashboard?error=' + encodeURIComponent('You have already voted for this position.'));
  }

  await run('INSERT INTO votes (election_id, position_id, student_id, candidate_id) VALUES (?, ?, ?, ?)', [electionId, positionId, user.id, candidateId]);
  await run('INSERT INTO voter_status (election_id, student_id, status, voted_at) VALUES (?, ?, ?, ?) ON CONFLICT(election_id, student_id) DO UPDATE SET status = excluded.status, voted_at = excluded.voted_at', [electionId, user.id, 'voted', new Date().toISOString()]);
  await run('INSERT INTO audit_logs (actor_id, actor_name, action, details) VALUES (?, ?, ?, ?)', [user.id, user.name, 'cast_vote', `Student cast a vote for ${candidate.name} in ${election.title} (${position.name}).`]);

  res.redirect('/student/dashboard?message=' + encodeURIComponent('Your vote has been recorded successfully.'));
});

app.get('/student/results', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'student'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const elections = await query('SELECT * FROM elections WHERE result_published = 1 ORDER BY end_at DESC');
  const nav = `
    <a class="nav-link" href="/student/dashboard">Dashboard</a>
    <a class="nav-link" href="/student/results">Published Results</a>
  `;

  const publishedElectionSections = [];
  for (const election of elections) {
    const info = await getElectionAndStats(election.id);
    publishedElectionSections.push(`
      <section class="panel">
        <div class="title-row">
          <h2>${escapeHtml(info.election.title)}</h2>
          <span class="${getStatusBadgeClass('Result Published')}">Result Published</span>
        </div>
        <div class="result-stack">
          ${info.results.map(({ position, counts, winner }) => `
            <div class="result-item">
              <h3>${escapeHtml(position.name)}</h3>
              <div class="winner-box">
                ${winner ? `Winner: <strong>${escapeHtml(winner.candidate.name)}</strong> • ${winner.total} votes` : 'No votes recorded'}
              </div>
              <div class="stack-list">
                ${counts.map(({ candidate, total }) => `
                  <div class="candidate-row">
                    <span>${escapeHtml(candidate.name)}</span>
                    <strong>${total} votes</strong>
                  </div>
                `).join('')}
              </div>
            </div>
          `).join('')}
        </div>
      </section>
    `);
  }

  const body = `
    <section class="page-header">
      <div>
        <div class="eyebrow">Student Results</div>
        <h1>Published Election Results</h1>
      </div>
    </section>
    ${publishedElectionSections.join('') || '<section class="alert-box warn-box"><h2>No published results</h2><p>Results will appear here once the administrator verifies and publishes them.</p></section>'}
  `;

  res.send(renderLayout({ title: 'Published Results', user, nav, body }));
});

app.get('/admin/dashboard', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const totalStudents = await queryOne('SELECT COUNT(*) as total FROM users WHERE role = ?', ['student']);
  const totalElections = await queryOne('SELECT COUNT(*) as total FROM elections');
  const activeElections = await queryOne('SELECT COUNT(*) as total FROM elections WHERE status = ?', ['active']);
  const closedElections = await queryOne('SELECT COUNT(*) as total FROM elections WHERE status = ? OR (start_at < datetime("now") AND end_at < datetime("now"))', ['closed']);
  const totalVotes = await queryOne('SELECT COUNT(*) as total FROM votes');
  const publishedResults = await queryOne('SELECT COUNT(*) as total FROM elections WHERE result_published = 1');
  const recentElections = await query('SELECT * FROM elections ORDER BY created_at DESC LIMIT 5');
  const auditLogs = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 6');

  const nav = `
    <a class="nav-link" href="/admin/dashboard">Overview</a>
    <a class="nav-link" href="/admin/elections/new">Create Election</a>
    <a class="nav-link" href="/admin/students">Students</a>
    <a class="nav-link" href="/admin/audit">Audit Log</a>
    <a class="nav-link" href="/admin/reports">Reports</a>
  `;

  const body = `
    <section class="page-header">
      <div>
        <div class="eyebrow">Admin Panel</div>
        <h1>Election Administration Dashboard</h1>
      </div>
    </section>

    <section class="stats-grid">
      <div class="stat-card"><span>Total Students</span><strong>${totalStudents.total}</strong></div>
      <div class="stat-card"><span>Eligible Voters</span><strong>${Number(totalStudents.total)}</strong></div>
      <div class="stat-card"><span>Active Elections</span><strong>${activeElections.total}</strong></div>
      <div class="stat-card"><span>Closed Elections</span><strong>${closedElections.total}</strong></div>
      <div class="stat-card"><span>Total Votes</span><strong>${totalVotes.total}</strong></div>
      <div class="stat-card"><span>Published Results</span><strong>${publishedResults.total}</strong></div>
    </section>

    <section class="dashboard-grid">
      <div class="panel">
        <h2>Recent Elections</h2>
        <div class="list-stack compact-list">
          ${recentElections.map((election) => `
            <div class="mini-row">
              <div>
                <strong>${escapeHtml(election.title)}</strong>
                <small>${formatDate(election.start_at)} → ${formatDate(election.end_at)}</small>
              </div>
              <span class="${getStatusBadgeClass(getElectionState(election))}">${getElectionState(election)}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="panel">
        <h2>Audit Activity</h2>
        <div class="list-stack compact-list">
          ${auditLogs.map((log) => `
            <div class="mini-row">
              <div>
                <strong>${escapeHtml(log.action)}</strong>
                <small>${escapeHtml(log.details || 'System event')}</small>
              </div>
              <span>${formatDate(log.created_at)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </section>
  `;

  res.send(renderLayout({ title: 'Admin Dashboard', user, nav, body }));
});

app.get('/admin/elections/new', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const nav = `
    <a class="nav-link" href="/admin/dashboard">Overview</a>
    <a class="nav-link" href="/admin/elections/new">Create Election</a>
    <a class="nav-link" href="/admin/students">Students</a>
  `;

  const body = `
    <section class="panel">
      <h1>Create Election</h1>
      <form class="form-grid" method="POST" action="/admin/elections/create">
        <div class="field">
          <label>Election Title</label>
          <input type="text" name="title" required />
        </div>
        <div class="field">
          <label>Description</label>
          <textarea name="description" rows="3"></textarea>
        </div>
        <div class="field">
          <label>Department</label>
          <input type="text" name="department" placeholder="CTH" />
        </div>
        <div class="field">
          <label>Year</label>
          <input type="text" name="year" placeholder="2" />
        </div>
        <div class="field">
          <label>Batch</label>
          <input type="text" name="batch" placeholder="2024" />
        </div>
        <div class="field">
          <label>Start Date</label>
          <input type="datetime-local" name="start_at" required />
        </div>
        <div class="field">
          <label>End Date</label>
          <input type="datetime-local" name="end_at" required />
        </div>
        <div class="field full-width">
          <button class="primary-btn" type="submit">Create Election</button>
        </div>
      </form>
    </section>
  `;

  res.send(renderLayout({ title: 'Create Election', user, nav, body }));
});

app.post('/admin/elections/create', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }

  const { title, description, department, year, batch, start_at, end_at } = req.body;
  if (!title || !start_at || !end_at) {
    return res.redirect('/admin/elections/new?error=' + encodeURIComponent('Election title and dates are required.'));
  }

  const admin = req.session.user;
  const election = await run(
    'INSERT INTO elections (title, description, department, year, batch, start_at, end_at, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [title, description || '', department || '', year || '', batch || '', start_at, end_at, 'scheduled', admin.id]
  );

  await run('INSERT INTO audit_logs (actor_id, actor_name, action, details) VALUES (?, ?, ?, ?)', [admin.id, admin.name, 'create_election', `Created election: ${title}.`]);
  res.redirect('/admin/elections/' + election.id + '/manage');
});

app.get('/admin/elections/:id/manage', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const election = await queryOne('SELECT * FROM elections WHERE id = ?', [req.params.id]);
  if (!election) {
    return res.send(renderLayout({ title: 'Election Not Found', user, body: '<section class="alert-box error-box"><h2>Election not found</h2><a class="primary-btn" href="/admin/dashboard">Back</a></section>' }));
  }

  const positions = await query('SELECT * FROM positions WHERE election_id = ? ORDER BY id', [election.id]);
  const details = [];
  for (const position of positions) {
    const candidates = await query('SELECT * FROM candidates WHERE position_id = ? ORDER BY id', [position.id]);
    details.push({ position, candidates });
  }

  const nav = `
    <a class="nav-link" href="/admin/dashboard">Overview</a>
    <a class="nav-link" href="/admin/elections/new">Create Election</a>
    <a class="nav-link" href="/admin/elections/${election.id}/manage">Manage Election</a>
    <a class="nav-link" href="/admin/elections/${election.id}/results">Results</a>
  `;

  const body = `
    <section class="page-header">
      <div>
        <div class="eyebrow">Election Setup</div>
        <h1>${escapeHtml(election.title)}</h1>
      </div>
      <span class="${getStatusBadgeClass(getElectionState(election))}">${getElectionState(election)}</span>
    </section>

    <section class="dashboard-grid">
      <div class="panel">
        <h2>Add Position</h2>
        <form method="POST" action="/admin/elections/${election.id}/positions">
          <div class="field">
            <label>Position Name</label>
            <input type="text" name="name" required />
          </div>
          <button class="primary-btn" type="submit">Add Position</button>
        </form>
      </div>

      <div class="panel">
        <h2>Candidate Details</h2>
        <form method="POST" action="/admin/elections/${election.id}/candidates">
          <div class="field">
            <label>Position</label>
            <select name="position_id" required>
              ${positions.map((position) => `<option value="${position.id}">${escapeHtml(position.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Candidate Name</label>
            <input type="text" name="name" required />
          </div>
          <div class="field">
            <label>Department</label>
            <input type="text" name="department" placeholder="CTH" />
          </div>
          <div class="field">
            <label>Year</label>
            <input type="text" name="year" placeholder="2" />
          </div>
          <div class="field">
            <label>Symbol</label>
            <input type="text" name="symbol" placeholder="✦" />
          </div>
          <div class="field">
            <label>Bio/Manifesto</label>
            <textarea name="bio" rows="3"></textarea>
          </div>
          <button class="secondary-btn" type="submit">Add Candidate</button>
        </form>
      </div>
    </section>

    <section class="panel">
      <h2>Configured Positions</h2>
      <div class="position-manager-list">
        ${details.map(({ position, candidates }) => `
          <div class="manager-item">
            <h3>${escapeHtml(position.name)}</h3>
            <div class="stack-list">
              ${candidates.length ? candidates.map((candidate) => `
                <div class="candidate-row"><span>${escapeHtml(candidate.name)}</span><small>${escapeHtml(candidate.department || 'N/A')} / ${escapeHtml(candidate.year || 'N/A')}</small></div>
              `).join('') : '<p>No candidates added yet.</p>'}
            </div>
          </div>
        `).join('') || '<p>No positions added yet.</p>'}
      </div>
    </section>
  `;

  res.send(renderLayout({ title: 'Manage Election', user, nav, body }));
});

app.post('/admin/elections/:id/positions', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }
  const { name } = req.body;
  const electionId = req.params.id;
  if (!name) {
    return res.redirect(`/admin/elections/${electionId}/manage?error=${encodeURIComponent('Position name required.')}`);
  }
  await run('INSERT INTO positions (election_id, name) VALUES (?, ?)', [electionId, name]);
  await run('INSERT INTO audit_logs (actor_id, actor_name, action, details) VALUES (?, ?, ?, ?)', [req.session.user.id, req.session.user.name, 'add_position', `Added position ${name} to election ${electionId}.`]);
  res.redirect(`/admin/elections/${electionId}/manage`);
});

app.post('/admin/elections/:id/candidates', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }
  const { position_id, name, department, year, symbol, bio } = req.body;
  const electionId = req.params.id;
  if (!position_id || !name) {
    return res.redirect(`/admin/elections/${electionId}/manage?error=${encodeURIComponent('Position and candidate name are required.')}`);
  }
  await run('INSERT INTO candidates (election_id, position_id, name, department, year, symbol, bio) VALUES (?, ?, ?, ?, ?, ?, ?)', [electionId, position_id, name, department || '', year || '', symbol || '', bio || '']);
  await run('INSERT INTO audit_logs (actor_id, actor_name, action, details) VALUES (?, ?, ?, ?)', [req.session.user.id, req.session.user.name, 'add_candidate', `Added candidate ${name} to election ${electionId}.`]);
  res.redirect(`/admin/elections/${electionId}/manage`);
});

app.get('/admin/elections/:id/results', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const info = await getElectionAndStats(req.params.id);
  if (!info) {
    return res.send(renderLayout({ title: 'Results Not Found', user, body: '<section class="alert-box error-box"><h2>Election not found</h2><a class="primary-btn" href="/admin/dashboard">Back</a></section>' }));
  }

  const nav = `
    <a class="nav-link" href="/admin/dashboard">Overview</a>
    <a class="nav-link" href="/admin/elections/${info.election.id}/manage">Manage Election</a>
    <a class="nav-link" href="/admin/elections/${info.election.id}/results">Results</a>
  `;

  const body = `
    <section class="page-header">
      <div>
        <div class="eyebrow">Result Verification</div>
        <h1>${escapeHtml(info.election.title)}</h1>
      </div>
      <span class="${getStatusBadgeClass(info.election.result_published ? 'Result Published' : getElectionState(info.election))}">${info.election.result_published ? 'Result Published' : getElectionState(info.election)}</span>
    </section>

    <section class="result-stack">
      ${info.results.map(({ position, counts, winner }) => `
        <div class="panel result-item">
          <h2>${escapeHtml(position.name)}</h2>
          <div class="winner-box">
            ${winner ? `Winner: <strong>${escapeHtml(winner.candidate.name)}</strong> (${winner.total} votes)` : 'No winner yet'}
          </div>
          <div class="stack-list">
            ${counts.map(({ candidate, total }) => `
              <div class="candidate-row">
                <span>${escapeHtml(candidate.name)}</span>
                <strong>${total} votes</strong>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </section>

    ${!info.election.result_published ? `<form method="POST" action="/admin/elections/${info.election.id}/publish-results"><button class="primary-btn" type="submit">Publish Results</button></form>` : '<section class="alert-box success-box"><h2>Published</h2><p>Results have already been published.</p></section>'}
  `;

  res.send(renderLayout({ title: 'Election Results', user, nav, body }));
});

app.post('/admin/elections/:id/publish-results', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }

  const electionId = req.params.id;
  const admin = req.session.user;
  const election = await queryOne('SELECT * FROM elections WHERE id = ?', [electionId]);
  if (election) {
    await run('UPDATE elections SET result_published = 1, status = ? WHERE id = ?', ['closed', electionId]);
    await run('INSERT INTO audit_logs (actor_id, actor_name, action, details) VALUES (?, ?, ?, ?)', [admin.id, admin.name, 'publish_results', `Published results for election ${election.title}.`]);
  }
  res.redirect(`/admin/elections/${electionId}/results`);
});

app.get('/admin/students', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const search = (req.query.search || '').trim();
  const department = (req.query.department || '').trim();

  let sql = 'SELECT * FROM users WHERE role = ?';
  const params = ['student'];

  if (search) {
    sql += ' AND (student_id LIKE ? OR name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  if (department) {
    sql += ' AND department = ?';
    params.push(department);
  }

  sql += ' ORDER BY student_id';
  const students = await query(sql, params);
  const departments = await query('SELECT DISTINCT department FROM users WHERE role = ? AND department IS NOT NULL AND department != ? ORDER BY department', ['student', '']);

  const nav = `
    <a class="nav-link" href="/admin/dashboard">Overview</a>
    <a class="nav-link" href="/admin/elections/new">Create Election</a>
    <a class="nav-link" href="/admin/students">Students</a>
  `;

  const body = `
    <section class="page-header">
      <div>
        <div class="eyebrow">Student Management</div>
        <h1>Student Directory</h1>
      </div>
    </section>

    <section class="panel">
      <form class="filter-row" method="GET" action="/admin/students">
        <input type="text" name="search" placeholder="Search student name or ID" value="${escapeHtml(search)}" />
        <select name="department">
          <option value="">All departments</option>
          ${departments.map((item) => `<option value="${escapeHtml(item.department)}" ${department === item.department ? 'selected' : ''}>${escapeHtml(item.department)}</option>`).join('')}
        </select>
        <button class="primary-btn" type="submit">Apply</button>
      </form>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Student ID</th>
              <th>Name</th>
              <th>Department</th>
              <th>Year</th>
              <th>Batch</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${students.map((student) => `
              <tr>
                <td>${escapeHtml(student.student_id)}</td>
                <td>${escapeHtml(student.name)}</td>
                <td>${escapeHtml(student.department || 'N/A')}</td>
                <td>${escapeHtml(student.year || 'N/A')}</td>
                <td>${escapeHtml(student.batch || 'N/A')}</td>
                <td>${escapeHtml(student.status || 'active')}</td>
              </tr>
            `).join('') || '<tr><td colspan="6">No matching students.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `;

  res.send(renderLayout({ title: 'Student Directory', user, nav, body }));
});

app.get('/admin/audit', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const logs = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 20');
  const nav = `
    <a class="nav-link" href="/admin/dashboard">Overview</a>
    <a class="nav-link" href="/admin/elections/new">Create Election</a>
    <a class="nav-link" href="/admin/audit">Audit Log</a>
  `;

  const body = `
    <section class="page-header">
      <div>
        <div class="eyebrow">Security Log</div>
        <h1>Audit Trail</h1>
      </div>
    </section>
    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            ${logs.map((log) => `
              <tr>
                <td>${formatDate(log.created_at)}</td>
                <td>${escapeHtml(log.actor_name || 'System')}</td>
                <td>${escapeHtml(log.action)}</td>
                <td>${escapeHtml(log.details || 'No details')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;

  res.send(renderLayout({ title: 'Audit Log', user, nav, body }));
});

app.get('/admin/reports', async (req, res) => {
  if (!(await ensureAuthenticated(req, res, 'admin'))) {
    return res.redirect('/');
  }

  const user = req.session.user;
  const elections = await query('SELECT * FROM elections ORDER BY start_at DESC');
  const reportRows = [];

  for (const election of elections) {
    const eligibleCount = await queryOne('SELECT COUNT(*) as total FROM users WHERE role = ? AND department = ? AND year = ? AND batch = ?', ['student', election.department || '', election.year || '', election.batch || '']);
    const totalVotes = await queryOne('SELECT COUNT(*) as total FROM votes v JOIN positions p ON p.id = v.position_id WHERE p.election_id = ?', [election.id]);
    const percent = eligibleCount.total ? ((Number(totalVotes.total) / Number(eligibleCount.total)) * 100).toFixed(1) : '0.0';
    reportRows.push({ election, eligibleCount: eligibleCount.total, totalVotes: totalVotes.total, percent });
  }

  const nav = `
    <a class="nav-link" href="/admin/dashboard">Overview</a>
    <a class="nav-link" href="/admin/elections/new">Create Election</a>
    <a class="nav-link" href="/admin/reports">Reports</a>
  `;

  const body = `
    <section class="page-header">
      <div>
        <div class="eyebrow">Elections Reports</div>
        <h1>Participation & Results Summary</h1>
      </div>
    </section>

    <section class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Election</th>
              <th>Eligible Voters</th>
              <th>Votes Cast</th>
              <th>Participation</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${reportRows.map(({ election, eligibleCount, totalVotes, percent }) => `
              <tr>
                <td>${escapeHtml(election.title)}</td>
                <td>${eligibleCount}</td>
                <td>${totalVotes}</td>
                <td>${percent}%</td>
                <td>${escapeHtml(getElectionState(election))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;

  res.send(renderLayout({ title: 'Election Reports', user, nav, body }));
});

async function startApp() {
  await seedDatabase();
  app.listen(PORT, () => {
    console.log(`Digital Voting System running on http://localhost:${PORT}`);
  });
}

startApp().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
