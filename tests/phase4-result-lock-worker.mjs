import Database from 'better-sqlite3';
const db = new Database(process.argv[2]);
db.exec('BEGIN IMMEDIATE');
process.send('locked');
process.on('message', () => { db.exec('ROLLBACK'); db.close(); process.disconnect(); });
