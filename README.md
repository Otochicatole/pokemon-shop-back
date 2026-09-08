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

## Arquitectura

El backend usa screaming architecture por capacidad de negocio. Los módulos públicos están en `src/modules` y separan `domain`, `application`, `infrastructure` y `http`; la composición manual de Prisma, sesiones, pagos, correo y almacenamiento se realiza en `src/app/composition-root.ts`. Los casos de uso no dependen de Express ni de Prisma directamente.

La API actual para el frontend es `/api/v2`. Las respuestas exitosas usan `{ data, meta }` y los errores usan Problem Details (`code`, `status`, `title`, `detail`, `requestId`). El contrato `/api/v1` fue retirado al completar la migración.

El catálogo público expone `/api/v2/catalog/products` y `/api/v2/catalog/filters`. Los parámetros `kind`, `pokemonType`, `setName`, `rarity`, `condition`, `language`, `finish`, `edition` y `gradingCompany` son repetibles; las selecciones dentro de una faceta se combinan con OR y las distintas facetas con AND. También admite `q`, `setCode`, `graded`, `inStock`, `minPriceMinor`, `maxPriceMinor`, `sort`, `cursor` y `limit`. Swagger contiene el contrato completo y los valores válidos.

## Seguridad y operación

- Los importes y el stock siempre se recalculan en backend.
- Las sesiones son opacas y se almacenan hasheadas en SQLite.
- El checkout usa una transacción corta y una cola de escrituras para impedir doble reserva.
- Las imágenes y comprobantes se almacenan fuera del webroot y se sirven mediante endpoints autorizados.
- En producción se requieren secretos, HTTPS en el proxy, SMTP, credenciales de Google y Mercado Pago.

El proyecto está diseñado para una sola instancia mientras use SQLite y almacenamiento local. Los puertos de persistencia y archivos permiten migrar posteriormente a PostgreSQL, Redis y almacenamiento de objetos.

## Datos de desarrollo

`pnpm db:seed` es idempotente y crea diecisiete productos publicados con imágenes locales, los once tipos TCG, accesorios, metadatos de colección, inventario, retiro, envíos y los accesos de prueba:

- Usuario: `user@cardshop.test` / `User123!seed-card-shop`
- Admin: `admin@cardshop.test` / `Admin123!seed-card-shop`

El admin requiere TOTP. Para ver el código vigente ejecutá `pnpm admin:otp` o registrá el secreto `JBSWY3DPEHPK3PXP` en un autenticador. Estas credenciales son exclusivamente para desarrollo y deben cambiarse antes de cualquier entorno compartido.
