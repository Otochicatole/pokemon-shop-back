# back-card-shop

Backend REST para un ecommerce de cartas Pokémon, construido como monolito modular con Express, TypeScript, Prisma y SQLite.

## Desarrollo

Requiere Node.js 24 y pnpm 11.

```bash
pnpm install
copy .env.example .env
pnpm db:generate
pnpm db:migrate --name init
pnpm db:seed
pnpm dev
```

Swagger queda disponible en `http://localhost:3000/docs` y el documento OpenAPI en `/openapi.json`.

## Seguridad y operación

- Los importes y el stock siempre se recalculan en backend.
- Las sesiones son opacas y se almacenan hasheadas en SQLite.
- El checkout usa una transacción corta y una cola de escrituras para impedir doble reserva.
- Las imágenes y comprobantes se almacenan fuera del webroot y se sirven mediante endpoints autorizados.
- En producción se requieren secretos, HTTPS en el proxy, SMTP, credenciales de Google y Mercado Pago.

El proyecto está diseñado para una sola instancia mientras use SQLite y almacenamiento local. Los puertos de persistencia y archivos permiten migrar posteriormente a PostgreSQL, Redis y almacenamiento de objetos.

## Datos de desarrollo

`pnpm db:seed` es idempotente y crea ocho productos publicados con imágenes locales, inventario, retiro, envíos y los accesos de prueba:

- Usuario: `user@cardshop.test` / `User123!seed-card-shop`
- Admin: `admin@cardshop.test` / `Admin123!seed-card-shop`

El admin requiere TOTP. Para ver el código vigente ejecutá `pnpm admin:otp` o registrá el secreto `JBSWY3DPEHPK3PXP` en un autenticador. Estas credenciales son exclusivamente para desarrollo y deben cambiarse antes de cualquier entorno compartido.
