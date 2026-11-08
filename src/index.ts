import { buildApp } from './app.js';
if (process.env.REGISTRATION_MODE !== undefined) console.warn('REGISTRATION_MODE is ignored: single-user server');
const {app}=await buildApp({database:process.env.DATABASE_PATH??'data/silique.sqlite',origins:(process.env.CORS_ORIGINS??'').split(',').filter(Boolean),logger:true});
const shutdown=async()=> {await app.close();process.exit(0);};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
await app.listen({host:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??8787)});
