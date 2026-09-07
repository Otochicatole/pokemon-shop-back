import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface EmailPort {
  send(to: string, subject: string, text: string): Promise<void>;
}

class SmtpEmail implements EmailPort {
  private transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER && env.SMTP_PASSWORD ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  });

  async send(to: string, subject: string, text: string) {
    await this.transporter.sendMail({ from: env.SMTP_FROM, to, subject, text });
  }
}

class DevelopmentEmail implements EmailPort {
  async send(to: string, subject: string, text: string) {
    logger.info({ to, subject, text }, 'Development email');
  }
}

export const email: EmailPort = env.SMTP_HOST && env.SMTP_FROM ? new SmtpEmail() : new DevelopmentEmail();
