// Uses SQLite's online backup API, so WAL contents are included consistently.
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
const source=process.env.DATABASE_PATH??'/var/lib/silique/silique.sqlite';
const destination=process.argv[2];
if(!destination)throw new Error('Usage: node backup.mjs /absolute/backup/directory');
if(!destination.startsWith('/'))throw new Error('Use an absolute backup directory');
mkdirSync(destination,{recursive:true,mode:0o700});
const db=new DatabaseSync(source);
try{await backup(db,`${destination}/silique-${new Date().toISOString().replaceAll(':','-')}.sqlite`);}finally{db.close();}
