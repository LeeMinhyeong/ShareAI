import type Database from 'better-sqlite3';
import {validExperimentalAccountId} from './experimental-429-account-id.js';

// EXPERIMENT ONLY. This schema is for a pre-created synthetic database, never a migration.
const meta = "CREATE TABLE inc429_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), marker TEXT NOT NULL CHECK(marker='inc429-v2'), counter INTEGER NOT NULL CHECK(typeof(counter)='integer' AND counter>=0)) STRICT";
const restrictions = "CREATE TABLE inc429_rows (kind TEXT NOT NULL CHECK(kind IN ('upstream','siwc')), account_id TEXT NOT NULL CHECK(length(CAST(account_id AS BLOB)) BETWEEN 1 AND 512 AND instr(account_id,char(0))=0), generation INTEGER NOT NULL CHECK(generation>0), duration_ns INTEGER CHECK(duration_ns IS NULL OR duration_ns>=0), PRIMARY KEY(kind,account_id)) STRICT, WITHOUT ROWID";
const index = 'CREATE INDEX inc429_finite ON inc429_rows(kind,account_id) WHERE duration_ns IS NOT NULL';
export const fixtureSchema = `${meta};${restrictions};${index};INSERT INTO inc429_meta VALUES(1,'inc429-v2',0);`;
const max = 9223372036854775807n;
type Kind = 'upstream'|'siwc';
type Key = {kind:Kind; id:string};
type Row = {kind: unknown; account_id: unknown; kind_hex:string; id_hex:string; generation:unknown; duration_ns:unknown};
type Observation = {generation:bigint; duration:bigint; start:bigint; last:bigint};
const columns = 'kind,account_id,hex(CAST(kind AS BLOB)) AS kind_hex,hex(CAST(account_id AS BLOB)) AS id_hex,generation,duration_ns';
export const finitePageSql = `SELECT ${columns} FROM inc429_rows INDEXED BY inc429_finite WHERE duration_ns IS NOT NULL AND (kind,account_id)>(?,?) ORDER BY kind,account_id LIMIT ?`;
function key(kind:unknown,id:unknown): asserts kind is Kind {
  if ((kind!=='upstream' && kind!=='siwc') || !validExperimentalAccountId(id) || Buffer.byteLength(id,'utf8')>512) throw new Error('Invalid key');
}
function parse(row:Row,counter:bigint): Key & {generation:bigint; duration:bigint|null} {
  key(row.kind,row.account_id);
  const id=row.account_id as string;
  if (Buffer.from(row.kind,'utf8').toString('hex').toUpperCase()!==row.kind_hex || Buffer.from(id,'utf8').toString('hex').toUpperCase()!==row.id_hex || typeof row.generation!=='bigint' || row.generation<=0n || row.generation>counter || (row.duration_ns!==null && (typeof row.duration_ns!=='bigint' || row.duration_ns<0n))) throw new Error('Invalid restriction state');
  return {kind:row.kind,id,generation:row.generation,duration:row.duration_ns as bigint|null};
}

/** Trust boundary: only validated writers modify this intact UTF-8 SQLite file;
 * no direct SQL, corruption, DB/VM rollback, or non-monotonic clocks. Other malformed
 * rows are deliberately not scanned globally. Never use for production admission. */
export class Incremental429 {
  private observations = new Map<string,Observation>();
  private busy=false;
  constructor(private readonly db:Database.Database, private readonly clock:()=>bigint=process.hrtime.bigint) {
    if (typeof clock!=='function') throw new Error('Invalid clock');
  }
  private schema():bigint {
    if (!this.db.open || !this.db.inTransaction) throw new Error('Requires immediate transaction');
    const found=this.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as {type:string;name:string;sql:string}[];
    const expected=[{type:'index',name:'inc429_finite',sql:index},{type:'table',name:'inc429_meta',sql:meta},{type:'table',name:'inc429_rows',sql:restrictions}];
    if (JSON.stringify(found)!==JSON.stringify(expected) || this.db.pragma('encoding',{simple:true})!=='UTF-8' || this.db.pragma('ignore_check_constraints',{simple:true})!==0) throw new Error('Invalid schema');
    const rows=this.db.prepare('SELECT singleton,marker,counter FROM inc429_meta').safeIntegers().all() as {singleton:unknown;marker:unknown;counter:unknown}[];
    if (rows.length!==1 || rows[0].singleton!==1n || rows[0].marker!=='inc429-v2' || typeof rows[0].counter!=='bigint' || rows[0].counter<0n) throw new Error('Invalid marker');
    return rows[0].counter;
  }
  private tx<T>(fn:(counter:bigint)=>T):T {
    if (this.busy || !this.db.open || this.db.inTransaction) throw new Error('Requires top-level writer');
    this.busy=true;
    try { return this.db.transaction(()=>fn(this.schema())).immediate(); }
    finally {this.busy=false;}
  }
  private read(kind:Kind,id:string,counter:bigint) {
    const row=this.db.prepare(`SELECT ${columns} FROM inc429_rows WHERE kind=? AND account_id=?`).safeIntegers().get(kind,id) as Row|undefined;
    return row ? parse(row,counter) : undefined;
  }
  arm(kind:Kind,id:string,duration:bigint|null):void {
    key(kind,id);
    if (duration!==null && (typeof duration!=='bigint' || duration<0n || duration>max)) throw new Error('Invalid duration');
    this.tx(counter=>{
      const current=this.read(kind,id,counter);
      if (counter===max) throw new Error('Counter exhausted');
      const next=current ? (current.duration===null || duration===null ? null : current.duration>duration ? current.duration : duration) : duration;
      this.db.prepare('UPDATE inc429_meta SET counter=? WHERE singleton=1').run(counter+1n);
      this.db.prepare('INSERT INTO inc429_rows VALUES(?,?,?,?) ON CONFLICT(kind,account_id) DO UPDATE SET generation=excluded.generation,duration_ns=excluded.duration_ns').run(kind,id,counter+1n,next);
    });
  }
  page(size:number, cursor?:Key):{rows:Key[];cursor?:Key} {
    if (!Number.isInteger(size) || size<1 || size>100) throw new Error('Invalid page size');
    if (cursor) key(cursor.kind,cursor.id);
    return this.tx(counter=>{
      const raw=this.db.prepare(finitePageSql).safeIntegers().all(cursor?.kind??'',cursor?.id??'',size) as Row[];
      const rows=raw.map(r=>{const parsed=parse(r,counter); if(parsed.duration===null) throw new Error('Invalid finite row'); return {kind:parsed.kind,id:parsed.id};});
      return {rows,cursor:rows.length===size?rows[rows.length-1]:undefined};
    });
  }
  check(kind:Kind,id:string):'absent'|'waiting'|'expired' {
    key(kind,id);
    const k=JSON.stringify([kind,id]);
    // Publish observations only after successful commit; retain them on SQLITE_BUSY.
    let replacement:Observation|undefined;
    let clear=false;
    try {
      const result=this.tx(counter=>{
        const row=this.read(kind,id,counter);
        if (!row || row.duration===null) {clear=true; return row?'waiting':'absent';}
        let obs=this.observations.get(k);
        let now:bigint;
        try {now=this.clock();} catch (error) {clear=true; throw error;}
        if (typeof now!=='bigint' || now<0n || (obs && now<obs.last)) {clear=true; throw new Error('Invalid clock');}
        if (!obs || obs.generation!==row.generation || obs.duration!==row.duration) {
          replacement={generation:row.generation,duration:row.duration,start:now,last:now};
          return 'waiting';
        }
        replacement={...obs,last:now};
        if (now-obs.start<obs.duration) return 'waiting';
        const result=this.db.prepare('DELETE FROM inc429_rows WHERE kind=? AND account_id=? AND generation=? AND duration_ns=?').run(kind,id,obs.generation,obs.duration);
        if(result.changes!==1) throw new Error('Compare-delete failed');
        clear=true; return 'expired';
      });
      if (clear) this.observations.delete(k); else if(replacement) this.observations.set(k,replacement);
      return result;
    } catch(e) {if(clear) this.observations.delete(k); throw e;}
  }
}
