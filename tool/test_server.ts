// Disposable loopback-only database for the complete client integration suite.
// Production entry point keeps authentication and its default request limits.
import {buildApp} from '../src/app.js';
const {app} = await buildApp({database:':memory:',origins:[],rateLimitMax:100000});
await app.listen({host:'127.0.0.1',port:18789});
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,async () => { await app.close(); process.exit(0); });
console.log('Disposable Silique test server: http://127.0.0.1:18789');
