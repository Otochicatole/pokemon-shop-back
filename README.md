# back-card-shop

Backend REST para un ecommerce de cartas Pokémon, construido como monolito modular con Express, TypeScript, Prisma y SQLite.

## Desarrollo

Requiere Node.js 24 y pnpm 11.

```bash
pnpm install
copy .env.example .env
pnpm db:generate
pnpm db:deploy
pnpm db:seed
pnpm dev
```

Swagger queda disponible en `http://localhost:3000/docs` y el documento OpenAPI en `/openapi.json`.

Con el frontend ejecutándose en el puerto 3001, el CMS se abre en `http://localhost:3001/admin/login`.

## Arquitectura

El backend usa screaming architecture por capacidad de negocio. Los módulos públicos están en `src/modules` y separan `domain`, `application`, `infrastructure` y `http`; la composición manual de Prisma, sesiones, pagos, correo y almacenamiento se realiza en `src/app/composition-root.ts`. Los casos de uso no dependen de Express ni de Prisma directamente.

El backoffice expone casos de uso y puertos estrechos por capacidad (`products`, `inventory`, `suppliers`, `orders`, `payments`, `fulfillment`, `customers` y `audit`). El composition root es el único lugar que conecta esos puertos con Prisma, sesiones, uploads y media. Los adaptadores comparten deliberadamente un store transaccional SQLite: aprobar/rechazar pagos debe modificar orden, reservas, inventario y auditoría dentro de una única transacción serializada, sin fingir transacciones distribuidas entre módulos.

La API actual para el frontend es `/api/v2`. Las respuestas exitosas usan `{ data, meta }` y los errores usan Problem Details (`code`, `status`, `title`, `detail`, `requestId`). El contrato `/api/v1` fue retirado al completar la migración.

El catálogo público expone `/api/v2/catalog/products` y `/api/v2/catalog/filters`. Los parámetros `kind`, `pokemonType`, `setName`, `rarity`, `condition`, `language`, `finish`, `edition` y `gradingCompany` son repetibles; las selecciones dentro de una faceta se combinan con OR y las distintas facetas con AND. También admite `q`, `setCode`, `graded`, `inStock`, `minPriceMinor`, `maxPriceMinor`, `sort`, `cursor` y `limit`. Swagger contiene el contrato completo y los valores válidos.

## Seguridad y operación

- Los importes y el stock siempre se recalculan en backend.
- Las sesiones son opacas y se almacenan hasheadas en SQLite.
- La sesión administrativa usa cookies y CSRF independientes de las del cliente, vence tras 15 minutos de inactividad y nunca supera las 8 horas.
- Cada respuesta bajo `/api/v2/admin` se entrega con `Cache-Control: no-store`; las mutaciones requieren `X-CSRF-Token` obtenido desde `/api/v2/admin/auth/csrf`.
- El checkout usa una transacción corta y una cola de escrituras para impedir doble reserva.
- Las imágenes y comprobantes se almacenan fuera del webroot y se sirven mediante endpoints autorizados.
- Retirar una imagen crea un trabajo persistente con 24 horas de gracia. El job verifica snapshots de órdenes, mueve el archivo a `storage/tmp/quarantine` y recién después elimina sus registros y el archivo; cada etapa es reanudable. Se ejecuta al iniciar y cada cinco minutos, y también puede operarse manualmente con `pnpm media:cleanup`.
- En producción se requieren secretos, HTTPS en el proxy, SMTP, credenciales de Google y Mercado Pago.

El proyecto está diseñado para una sola instancia mientras use SQLite y almacenamiento local. Los puertos de persistencia y archivos permiten migrar posteriormente a PostgreSQL, Redis y almacenamiento de objetos.

## Datos de desarrollo

`pnpm db:seed` es idempotente y crea diecisiete productos publicados con imágenes locales, tres proveedores de ejemplo (dos activos y uno inactivo), siete órdenes representativas para el CMS (incluido un comprobante privado), los once tipos TCG, accesorios, metadatos de colección, inventario, retiro, envíos y los accesos de prueba:

- Usuario: `user@cardshop.test` / `User123!seed-card-shop`
- Admin: `admin@cardshop.test` / `Admin123!seed-card-shop`

El acceso administrativo usa únicamente email y contraseña. Estas credenciales son exclusivamente para desarrollo y deben cambiarse antes de cualquier entorno compartido.

Los administradores se crean únicamente desde la terminal con `pnpm admin:create`; no existe registro administrativo por HTTP. El comando solicita email, nombre opcional y una contraseña de al menos 12 caracteres.

La agenda de proveedores está disponible en `http://localhost:3001/admin/suppliers`. Los proveedores se pueden crear, editar, desactivar y reactivar; la baja es lógica para conservar la información y la auditoría.
