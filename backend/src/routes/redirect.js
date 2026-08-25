import express from 'express';
import crypto from 'crypto';
import { pool } from '../db.js';

const router = express.Router();

// GET /go/offer/:id — the entire revenue mechanism. Logs the click
// server-side then 302s straight to the offer's affiliate_url, which
// already carries that retailer's affiliate tracking (built at ingest
// time by the Amazon PA-API client or the affiliate feed importer — see
// services/amazon.js and services/affiliateFeed.js). This is looked up
// from the central `offers` table only — nothing here talks to a retailer
// site directly.
router.get('/offer/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM offers WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).send('Offer not found');
    const offer = rows[0];

    // Salted hash, never the raw IP — enough for rough geo/device stats
    // without storing anything that identifies a specific person.
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
    const ipHash = crypto.createHash('sha256').update(ip + (process.env.CLICK_SALT || 'bdf-salt')).digest('hex').slice(0, 32);

    await pool.query(
      `INSERT INTO clicks (offer_id, retailer, clicked_url, session_id, user_agent, referrer, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [offer.id, offer.retailer, offer.affiliate_url, req.query.sid || null, req.headers['user-agent'] || null, req.headers['referer'] || null, ipHash]
    );

    res.redirect(302, offer.affiliate_url);
  } catch (error) {
    console.error('Redirect error:', error);
    res.status(500).send('Something went wrong');
  }
});

export default router;
