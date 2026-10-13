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

### Autocompletado de cartas y precios

Configurá `POKEMON_TCG_API_KEY` en el `.env` del backend con la clave privada de [pokemon-tcg.dev](https://pokemon-tcg.dev/docs) y reiniciá el servidor. La clave se envía únicamente desde el servidor como Bearer token a `https://api.pokemon-tcg.dev/v1`; nunca se expone en el frontend. `.env` está excluido de Git y `.env.example` contiene sólo el nombre de la variable.

La búsqueda de cartas acepta `q` (2–80 caracteres) y `page` (entero positivo, por defecto 1) en ambas rutas. Cada consulta obtiene sólo la página solicitada, de 20 cartas, y responde `{ data: [...], meta: { page, limit, total, totalPages } }`. Los totales vienen del proveedor: `total_pages` se transforma en `totalPages` sin sustituirlo por la cantidad de cartas de la página. Las búsquedas vacías conservan el valor del proveedor (0 o 1 páginas). La caché y las consultas simultáneas se separan por texto y página; navegar no descarga todo el catálogo ni consulta cada carta por separado. Contrato de origen: [OpenAPI oficial](https://api.pokemon-tcg.dev/v1/openapi.json), operación `GET /cards` y esquema `PaginationMeta`.

La consulta de precio de venta reutiliza esa búsqueda con precios incluidos. El historial se carga sólo al solicitarlo con `GET /api/v2/admin/pokemon-tcg/cards/:id/prices/history` o su equivalente de afiliados activos; el servidor consulta el endpoint autenticado `/cards/{id}/prices/history`. Responde `{ data: { cardId, prices: [{ sourceId, source, currency, variant, amountMinor, recordedAt, observedAt }] } }`: todos los registros válidos, ordenados cronológicamente, con su moneda original y centavos enteros. `recordedAt` conserva la fecha UTC y `observedAt` el instante real cuando existe. No se mezclan monedas ni variantes ni se generan valores históricos faltantes. El historial se cachea cinco minutos y deduplica consultas simultáneas; una lista vacía indica que no hay observaciones disponibles.

Productos, compras a proveedores y publicaciones de afiliados consultan `/api/v2/admin/pokemon-tcg/*` o `/api/v2/affiliate/pokemon-tcg/*`. La búsqueda usa `include_prices=true` y devuelve nombre, colección, código de set, número, imagen, rareza, tipos elementales, idioma, región, categoría especial y precios en una sola consulta al proveedor, sin pedir el detalle de cada resultado. Cada precio informa fuente, moneda original (USD/EUR), variante, importe, mínimo/máximo disponibles y fecha UTC; los importes se entregan en centavos enteros. Se omiten cotizaciones inválidas o monedas sin una unidad de centavos conocida. Seleccionar una carta consulta su detalle y completa el precio de venta de referencia en USD, editable antes de guardar. `set_code` completa Código de set y `set_name` completa Colección / set, respetando los valores del proveedor incluso cuando ambos coinciden. El costo de compra no cambia. Para completar el precio de venta se prioriza TCGPlayer y, dentro de una fuente, las variantes normal, holofoil y reverse-holofoil; los precios graduados o en otras monedas se muestran como referencias pero no se aplican. Si no hay precio USD válido se conserva el valor del formulario.

`rarity` conserva la etiqueta exacta del proveedor y se selecciona automáticamente, incluso si no estaba en las opciones locales. La rareza sigue siendo un selector en todos los formularios. `types` completa Tipo / atributo con el primer tipo elemental informado por la carta. Si la rareza es `null` o los tipos están vacíos, se conserva la información manual; la etiqueta literal `None` sí se considera un valor informado. Descripción y primera edición no están disponibles en esta API. La búsqueda utiliza inglés; las cartas de región japonesa se identifican como japonés. Las imágenes se descargan exclusivamente de `img.pokemon-tcg.dev` y se sanitizan antes de guardarse. Las consultas se cachean por cinco minutos (colecciones: 24 horas) y se respeta `Retry-After` ante límites temporales del proveedor. TCGdex fue retirado por completo; no hay fallback al proveedor anterior.

### Mercado Pago Checkout Pro

El checkout nuevo usa Orders API y convierte los importes internos en USD a ARS con la cotización `venta` de DolarAPI. Está desactivado por defecto. Para habilitarlo, configurá `MERCADOPAGO_ENABLED=true`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET`, `MERCADOPAGO_COLLECTOR_ID`, `PUBLIC_API_URL` y `PUBLIC_WEB_URL` en el backend. En producción ambas URLs deben ser públicas y usar HTTPS. Configurá en Mercado Pago el evento **Order (Mercado Pago)** apuntando a `${PUBLIC_API_URL}/api/v2/webhooks/mercado-pago`.

Primero desplegá la migración con `MERCADOPAGO_ENABLED=false`, cargá los secretos y probá con usuarios/tarjetas de prueba de Mercado Pago. El worker durable procesa el inbox de webhooks cada cinco segundos; el dashboard administrativo muestra backlog, errores y eventos agotados.

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
- En producción se requieren secretos, HTTPS en el proxy, SMTP y credenciales de Google. Mercado Pago sólo exige sus credenciales y URLs públicas cuando `MERCADOPAGO_ENABLED=true`.

El proyecto está diseñado para una sola instancia mientras use SQLite y almacenamiento local. Los puertos de persistencia y archivos permiten migrar posteriormente a PostgreSQL, Redis y almacenamiento de objetos.

## Datos iniciales

`pnpm db:seed` es idempotente y deja la tienda vacía: un administrador, reglas de lealtad por defecto, transferencia bancaria desactivada y sin productos, pedidos, noticias, envíos ni afiliados. En el VPS usá `SEED_ADMIN_EMAIL` y `SEED_ADMIN_PASSWORD` (mínimo 12 caracteres) y después cargá catálogo, zonas de envío, retiro y CBU desde el CMS.

Para un entorno local con catálogo de demostración:

```bash
pnpm db:seed:demo
```

Esa seed demo crea diecisiete productos publicados con imágenes locales, tres proveedores de ejemplo, órdenes representativas para el CMS, envíos, retiro y los accesos de prueba:

- Usuario: `user@cardshop.test` / `User123!seed-card-shop`
- Admin: `admin@cardshop.test` / `Admin123!seed-card-shop`
- Afiliado: `affiliate@cardshop.test` / `Affiliate123!seed-card-shop`

El acceso administrativo usa únicamente email y contraseña. Las credenciales por defecto son exclusivamente para desarrollo y deben cambiarse antes de cualquier entorno compartido.

Los administradores se crean únicamente desde la terminal con `pnpm admin:create`; no existe registro administrativo por HTTP. El comando solicita email, nombre opcional y una contraseña de al menos 12 caracteres.

La agenda de proveedores está disponible en `http://localhost:3001/admin/suppliers`. Los proveedores se pueden crear, editar, desactivar y reactivar; la baja es lógica para conservar la información y la auditoría.
