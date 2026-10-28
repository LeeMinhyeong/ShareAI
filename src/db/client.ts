/**
 * SQLite 데이터베이스 클라이언트
 */
import Database from 'better-sqlite3';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { SQL_SCHEMA } from './schema.js';
import path from 'path';
import fs from 'fs';

let dbInstance: Database.Database | null = null;

/**
 * SQLite DB 초기화
 */
export function initDatabase(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  // DATABASE_URL에서 파일 경로 추출 (sqlite:./data/router.db)
  const dbPath = env.DATABASE_URL.replace('sqlite:', '');
  
  // 디렉토리 생성
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger.info({ dbPath }, 'Initializing SQLite database');

  dbInstance = new Database(dbPath);
  
  // WAL 모드 활성화 (동시성 향상)
  dbInstance.pragma('journal_mode = WAL');
  
  // 스키마 초기화
  dbInstance.exec(SQL_SCHEMA);
  
  logger.info('Database initialized successfully');
  
  return dbInstance;
}

/**
 * DB 인스턴스 가져오기
 */
export function getDb(): Database.Database {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

/**
 * DB 종료
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info('Database closed');
  }
}
