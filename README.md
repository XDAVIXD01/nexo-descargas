# NexoDescargas

Gestor de descargas de escritorio para Windows, pensado para enlaces públicos de:

- Marketcat Drive
- RapidShare.co
- LolaUp
- Solred

Incluye cola persistente, descargas simultáneas, pausa y reanudación mediante HTTP Range, límite de velocidad, búsqueda, detección de duplicados y un instalador NSIS.

## Desarrollo

Requiere Node.js 20 o superior.

```powershell
npm install
npm run dev
```

## Compilar e instalar

```powershell
npm test
npm run dist
```

El instalador se genera en `release/`.

## Alcance

NexoDescargas trabaja con enlaces que el usuario ya puede descargar públicamente. No evade CAPTCHA, contraseñas, pagos ni límites impuestos por los sitios. Los adaptadores pueden necesitar ajustes si un proveedor cambia su página o API.

## Licencia

MIT
