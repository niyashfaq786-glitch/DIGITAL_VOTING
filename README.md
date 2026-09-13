# Digital Voting System for College Elections

A self-contained Express and SQLite web application implementing the college-election requirements in the supplied SRS.

## Features

- Student and administrator authentication with hashed passwords
- Student eligibility checks by department, year, and batch
- Election scheduling and server-side active/closed status calculation
- Position and candidate management
- One vote per student, election, and position enforced by a database uniqueness constraint
- Vote validation for eligibility, election state, position, candidate, and duplicate submissions
- Student voting dashboard and published results
- Administrator dashboard, participation reports, student search/filtering, election setup, results publication, and audit log
- Responsive interface for desktop and mobile devices

## Run locally

Requirements: Node.js 18+ and npm.

```powershell
cd digital-voting-system
npm install
npm start
```

Open `http://localhost:3000`.

The SQLite database is created automatically at `data/digital-voting.db` on first startup.

## Demo accounts

| Role | ID | Password |
| --- | --- | --- |
| Student | `S1001` | `student123` |
| Student | `S1002` | `student123` |
| Administrator | `ADMIN-001` | `admin123` |

Change the seeded credentials before deploying to a real college environment. The session secret in `server.js` should also be supplied through a protected environment variable for production use.

## Main routes

- `/` - Login
- `/student/dashboard` - Student dashboard
- `/student/results` - Published results
- `/admin/dashboard` - Administrator dashboard
- `/admin/elections/new` - Create an election
- `/admin/students` - Student directory
- `/admin/reports` - Participation reports
- `/admin/audit` - Audit history

This project is a functional demonstration and should receive a production security review before use for a live election.
