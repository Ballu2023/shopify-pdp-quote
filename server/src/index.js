import 'dotenv/config';
import express from 'express';
import quoteRoutes from './routes/quote.js';

// don't start without credentials
const required = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error('Missing env variables:', missing.join(', '));
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

// shopify app proxy sends /apps/quote/* here
app.use('/proxy', quoteRoutes);

app.use((req, res) => res.status(404).json({ ok: false, message: 'Not found' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, message: 'Invalid request' });
  }
  // errors with a status are ours and safe to show, anything else is a bug
  if (err.status) {
    return res.status(err.status).json({ ok: false, message: err.message, errors: err.errors });
  }
  console.error(err);
  res.status(500).json({ ok: false, message: 'Something went wrong, please try again' });
});

const PORT = process.env.PORT || 3010;

if (process.env.NODE_ENV !== 'test') {
  // only listen on localhost, apache proxies to it
  app.listen(PORT, '127.0.0.1', () => console.log(`Quote server running on port ${PORT}`));
}

export default app;
