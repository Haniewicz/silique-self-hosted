import { Store } from './store.js';
import { z } from 'zod';
const store=new Store(process.env.DATABASE_PATH??'data/silique.sqlite');
try {
  const [command,email]=process.argv.slice(2);
  if(command==='create-user') {
    const password=process.env.SILIQUE_INITIAL_PASSWORD;
    z.string().min(12).max(512).parse(password);
    const userId=await store.createUser(z.email().parse(email),password!);
    console.log(JSON.stringify({userId,email}));
  } else throw new Error('Usage: SILIQUE_INITIAL_PASSWORD=… npm run admin -- create-user email');
} finally {store.close();}
