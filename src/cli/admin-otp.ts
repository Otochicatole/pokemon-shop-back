import 'dotenv/config';
import { Secret, TOTP } from 'otpauth';
const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@cardshop.test';
const secret = process.env.SEED_ADMIN_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXP';
console.log(new TOTP({ issuer: 'back-card-shop', label: email, secret: Secret.fromBase32(secret) }).generate());
